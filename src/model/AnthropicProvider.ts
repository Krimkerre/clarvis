import {
  CompletionRequest,
  ModelChoice,
  ModelError,
  ModelProvider,
  describeHttpFailure,
} from './ModelProvider';
import { StreamEvent, ToolCall } from './ModelProvider';
import { ProviderSpec, resolveBaseUrl } from './providers';
import { anthropicTools } from '../agent/toolRegistry';
import { SseParser, decodeStream } from './sse';
import { lineageHeaders } from './lineage';

/** Wire version. Pinned, because an unpinned API version changes under you silently. */
const API_VERSION = '2023-06-01';

/**
 * What one request is allowed to spend, and what it may call.
 *
 * One argument rather than two positional ones because the two co-vary: the tool loop
 * gets tools and the larger budget, a plain reply gets neither.
 */
interface RequestBudget {
  maxTokens: number;
  tools?: unknown[];
}

/**
 * The Anthropic Messages API.
 *
 * Its own adapter rather than a special case of the OpenAI one: the system prompt is a
 * top-level field instead of a message, and the stream is typed events rather than
 * choice deltas. Two small differences that would otherwise become conditionals
 * scattered through shared code.
 *
 * **API key only.** M8b0 established that third-party products may not use claude.ai
 * subscription credentials without prior Anthropic approval, so there is no login path
 * here by design, not by omission.
 */
/** A tool-use block being assembled across frames. */
interface PartialBlock {
  id: string;
  name: string;
  json: string;
}

/** The frame that opens a tool call, as opposed to the one that opens prose. */
export function startsToolBlock(event: {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
}): boolean {
  return (
    event.type === 'content_block_start' &&
    event.content_block?.type === 'tool_use' &&
    event.index !== undefined
  );
}

/**
 * Routes one delta: into a tool call being built, or out as text.
 *
 * **The same frame type carries both**, which is the trap. `content_block_delta` is
 * prose when it holds `text` and tool arguments when it holds `partial_json`, and the
 * only way to tell which block it belongs to is the index — so a delta for an open tool
 * block must never be yielded as something to say aloud.
 *
 * Returns the text to emit, or undefined when the delta was swallowed into a call.
 */
export function absorbDelta(
  pending: Map<number, PartialBlock>,
  index: number,
  delta: { text?: string; partial_json?: string } | undefined
): string | undefined {
  const block = pending.get(index);

  if (block && delta?.partial_json !== undefined) {
    block.json += delta.partial_json;
    return undefined;
  }

  return delta?.text;
}

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';

  constructor(
    private readonly spec: ProviderSpec,
    private readonly getKey: () => Promise<string | undefined>,
    private readonly baseUrlOverride: () => string | undefined,
    private readonly log: (message: string) => void
  ) {}

  private get baseUrl(): string {
    return resolveBaseUrl(this.spec, this.baseUrlOverride());
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(await this.getKey());
  }

  /**
   * The live model list, with the context window and release date attached.
   *
   * Anthropic *does* publish `GET /v1/models` — checked rather than assumed, after an
   * earlier draft of this file claimed it didn't and hardcoded a default instead. The
   * response carries `display_name` and `max_input_tokens`, which is exactly what makes
   * the picker choosable, and it means a model released tomorrow appears without an
   * extension update.
   */
  async listModels(): Promise<ModelChoice[]> {
    const key = await this.getKey();
    if (!key) return [];

    try {
      const response = await fetch(`${this.baseUrl}/v1/models?limit=1000`, {
        headers: { 'x-api-key': key, 'anthropic-version': API_VERSION },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.log(`model: anthropic model list failed (${response.status})`);
        return [];
      }

      const body = (await response.json()) as {
        data?: { id?: string; display_name?: string; max_input_tokens?: number }[];
      };

      return (body.data ?? [])
        .filter((model): model is { id: string; display_name?: string; max_input_tokens?: number } =>
          typeof model.id === 'string'
        )
        .map((model) => ({
          id: model.id,
          label: model.display_name || model.id,
          detail: model.max_input_tokens
            ? `${Math.round(model.max_input_tokens / 1000)}K context`
            : model.id,
        }));
    } catch (error) {
      this.log(`model: anthropic model list failed (${String(error)})`);
      return [];
    }
  }

  /** Tool use is a documented capability of every current Claude model. */
  async supportsTools(): Promise<boolean> {
    return true;
  }

  /**
   * The tool-calling stream.
   *
   * Anthropic delivers a tool call as a `content_block_start` naming it, followed by
   * `input_json_delta` fragments that have to be **concatenated and parsed at the
   * end** — the JSON is not valid until the block closes. Parsing early yields a
   * truncated object that looks plausible, which is worse than failing.
   */
  async *streamWithTools(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const response = await this.post(request, { maxTokens: 4096, tools: anthropicTools(request.tools) });
    const parser = new SseParser();

    // Assembled per content block, keyed by the index Anthropic assigns.
    const pending = new Map<number, PartialBlock>();
    let sawToolCall = false;

    for await (const chunk of decodeStream(response.body!)) {
      for (const payload of parser.push(chunk)) {
        const event = this.parseEvent(payload);
        if (!event) continue;

        if (startsToolBlock(event)) {
          pending.set(event.index!, {
            id: event.content_block!.id!,
            name: event.content_block!.name!,
            json: '',
          });
          continue;
        }

        if (event.type === 'content_block_delta' && event.index !== undefined) {
          const text = absorbDelta(pending, event.index, event.delta);
          if (text) yield { type: 'text', text };
          continue;
        }

        if (event.type === 'content_block_stop' && event.index !== undefined) {
          const block = pending.get(event.index);
          if (!block) continue;

          pending.delete(event.index);
          sawToolCall = true;
          yield { type: 'toolCall', call: toCall(block) };
        }
      }
    }

    yield { type: 'stop', reason: sawToolCall ? 'tools' : 'end' };
  }

  /** One typed frame, or undefined for anything unparseable or uninteresting. */
  private parseEvent(payload: string):
    | {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { text?: string; partial_json?: string };
        error?: { message?: string };
      }
    | undefined {
    try {
      const event = JSON.parse(payload);

      if (event.type === 'error') {
        throw new ModelError(
          'Anthropic stopped mid-sentence.',
          `stream error: ${event.error?.message ?? 'unknown'}`,
          true
        );
      }
      return event;
    } catch (error) {
      if (error instanceof ModelError) throw error;
      this.log('model: skipped an unparseable anthropic frame');
      return undefined;
    }
  }

  /**
   * Shared request setup, so the two streams cannot drift apart.
   *
   * They had. `stream()` used to build its own `fetch` rather than call this, and the
   * two copies were extended separately — leaving Anthropic with two undocumented
   * token budgets, 4096 here and 2048 there, and nothing recording that the difference
   * was meant. It is meant: a plain reply is one answer and a tool loop is many turns.
   * Passing it in is what makes that a decision at the call site rather than a
   * discrepancy between two blocks nobody reads together.
   */
  private async post(request: CompletionRequest, budget: RequestBudget): Promise<Response> {
    const key = await this.getKey();
    if (!key) {
      throw new ModelError('No Anthropic key set. `/key` sorts that out.', 'no api key stored');
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: request.signal,
      // The same correlation headers the OpenAI-compatible adapter sends (§6.5).
      // This adapter only ever reaches Anthropic — RAVIS serves no `/v1/messages`
      // — so nothing in the ecosystem reads them yet; they are sent so a request
      // is the same request whichever adapter carries it.
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
        ...lineageHeaders(request.traceId ?? '', request.sessionId ?? ''),
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: budget.maxTokens,
        stream: true,
        // Top-level, not a message — the shape difference this adapter exists for.
        system: request.system,
        messages: request.messages.map(toAnthropicMessage),
        ...(budget.tools ? { tools: budget.tools } : {}),
      }),
    });

    if (!response.ok) {
      throw describeHttpFailure(response.status, await response.text(), this.spec.label);
    }
    if (!response.body) {
      throw new ModelError('Anthropic sent nothing back.', 'empty response body');
    }

    return response;
  }

  /**
   * The plain reply stream — no tools offered, and a smaller budget for that reason.
   *
   * `messages` now goes through `toAnthropicMessage` like the tool path's does. That is
   * not a behaviour change: only `AgentRunner` ever attaches tool calls or results to a
   * message, and `AgentRunner` uses `streamWithTools`. For every message that reaches
   * here the mapping returns `{ role, content }` — the object it was handed.
   */
  async *stream(request: CompletionRequest): AsyncIterable<string> {
    const response = await this.post(request, { maxTokens: 2048 });
    const parser = new SseParser();

    for await (const chunk of decodeStream(response.body!)) {
      for (const payload of parser.push(chunk)) {
        try {
          const event = JSON.parse(payload) as {
            type?: string;
            delta?: { text?: string };
            error?: { message?: string };
          };

          // Errors arrive *inside* a 200 stream, so a failure mid-answer never shows up
          // as a bad status code. Missing this means a truncated reply looks complete.
          if (event.type === 'error') {
            throw new ModelError(
              'Anthropic stopped mid-sentence.',
              `stream error: ${event.error?.message ?? 'unknown'}`,
              true
            );
          }

          if (event.type === 'content_block_delta' && event.delta?.text) {
            yield event.delta.text;
          }
        } catch (error) {
          if (error instanceof ModelError) throw error;
          this.log('model: skipped an unparseable anthropic frame');
        }
      }
    }
  }
}

/**
 * Turns an assembled tool-use block into a call.
 *
 * Malformed JSON becomes empty arguments rather than an exception: the registry's
 * validation then rejects it with a message the model can act on, which costs one
 * step. Throwing here would end the run over a fragment.
 */
function toCall(block: { id: string; name: string; json: string }): ToolCall {
  let args: unknown = {};

  try {
    args = block.json ? JSON.parse(block.json) : {};
  } catch {
    args = {};
  }

  return { id: block.id, name: block.name, args };
}

/**
 * Converts a neutral message into Anthropic's content-block shape.
 *
 * Tool results are a **user** turn containing `tool_result` blocks, which is the
 * detail most easily got wrong — sending them as an assistant turn produces a
 * confusing 400 that says nothing about the real mistake.
 */
export function toAnthropicMessage(message: {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: { id: string; content: string; isError?: boolean }[];
}): unknown {
  if (message.toolResults?.length) {
    return {
      role: 'user',
      content: [
        ...message.toolResults.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        })),
        // **What the user said mid-run rides in the same turn, after the results.**
        // Dropping it is how "no, use the other library" was logged and never read.
        // Text ahead of the tool_result blocks is rejected, and so is an empty text
        // block — which is every step nobody interrupted.
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
      ],
    };
  }

  if (message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...message.toolCalls.map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.args ?? {},
        })),
      ],
    };
  }

  return { role: message.role, content: message.content };
}
