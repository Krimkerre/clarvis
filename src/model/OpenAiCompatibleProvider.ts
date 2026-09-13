import {
  CompletionRequest,
  ModelChoice,
  ModelError,
  ModelProvider,
  describeHttpFailure,
} from './ModelProvider';
import { StreamEvent, ToolCall } from './ModelProvider';
import { openAiTools } from '../agent/toolRegistry';
import { buildCatalog } from './openrouterCatalog';
import { buildOpenAiCatalog } from './openaiCatalog';
import { ProviderSpec, resolveBaseUrl } from './providers';
import { SseParser, decodeStream } from './sse';
import { ReasoningWatch, reasoningFieldError, unfinishedThinkingError } from './reasoning';
import { lineageHeaders } from './lineage';
import { codexListingHeaders } from '../engine/engineChoice';

/**
 * One adapter, four providers: OpenAI, OpenRouter, Ollama and LM Studio.
 *
 * They all speak `/v1/chat/completions`, so the only differences are the base URL and
 * whether a key is required — both of which are data (`ProviderSpec`), not behaviour.
 * Writing four near-identical classes would mean fixing every streaming bug four times.
 */
/**
 * Statuses that say nothing about the model.
 *
 * Auth, quota and rate limits are facts about the account. Treating them as capability
 * answers means one bad minute decides what Clarvis can do for the rest of the session.
 */
function isAboutAccess(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

/**
 * Whether a failed tool probe actually answered the question it asked.
 *
 * A 4xx is the server understanding the request and rejecting it — and the only
 * unusual thing about a tool probe is its `tools` parameter, so that rejection is an
 * answer: no. Anything else is the server failing to answer at all. A 502 from a
 * gateway, a 503 from a model still loading, a 500 from a bug: none of them say
 * anything about tools.
 *
 * Access statuses are the exception inside 4xx. 401, 403 and 429 are about the key or
 * the quota, never about the request body.
 *
 * **A rule rather than a list, and that distinction is the whole fix.** The first
 * version enumerated the three access codes, having been burned once by a bad
 * credential caching `tool support = false` for the session. Enumerating meant every
 * status nobody had thought of — every 5xx, every gateway error — was still recorded
 * as a definitive "this model cannot call tools" and remembered until the window was
 * reloaded. Only a conclusive answer is worth remembering; everything else means ask
 * again later.
 */
export function probeAnswered(status: number): boolean {
  return status >= 400 && status < 500 && !isAboutAccess(status);
}

/** The shape of a streamed chunk, as far as this file cares about it. */
interface OpenAiChunk {
  choices?: {
    delta?: {
      content?: string;
      /**
       * A reasoning model's thinking, routed away from `content` by the server (F29).
       *
       * Read only to know that it happened — never shown, never spoken. LM Studio's
       * `separateReasoningContentInAPI` puts it here and leaves `content` empty, which
       * is otherwise indistinguishable from a model that said nothing.
       */
      reasoning_content?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string;
  }[];
}

/** A tool call being assembled across frames. */
interface PartialCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Folds streamed tool-call fragments into the calls they belong to.
 *
 * **Keyed by index, which is the whole difficulty.** OpenAI splits one call across many
 * frames and identifies them only by position: the name arrives once, the id sometimes,
 * and the arguments a few characters at a time. Anything already known has to survive a
 * frame that omits it, which is why every field falls back to what was there before.
 *
 * Pure and separate from the stream so it can be reasoned about without a network call —
 * this is the part that silently produces a malformed tool call when it is wrong.
 */
export function absorbToolDeltas(
  pending: Map<number, PartialCall>,
  deltas: NonNullable<NonNullable<OpenAiChunk['choices']>[number]['delta']>['tool_calls']
): void {
  for (const delta of deltas ?? []) {
    const index = delta.index ?? 0;
    const existing = pending.get(index) ?? { id: '', name: '', args: '' };

    pending.set(index, {
      id: delta.id ?? existing.id,
      name: delta.function?.name ?? existing.name,
      args: existing.args + (delta.function?.arguments ?? ''),
    });
  }
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;

  constructor(
    private readonly spec: ProviderSpec,
    private readonly getKey: () => Promise<string | undefined>,
    private readonly baseUrlOverride: () => string | undefined,
    private readonly log: (message: string) => void
  ) {
    this.id = spec.id;
  }

  private get baseUrl(): string {
    return resolveBaseUrl(this.spec, this.baseUrlOverride());
  }

  /**
   * Local providers are available when they answer; hosted ones need a key.
   *
   * Deliberately does not *call the model* — that would spend a request to answer a
   * configuration question. For local endpoints, reaching `/v1/models` is enough to
   * distinguish "not running" from "running", which is the failure people actually hit.
   */
  async isAvailable(): Promise<boolean> {
    if (this.spec.needsKey) return Boolean(await this.getKey());

    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * The provider's own live list, filtered to models that can actually chat.
   *
   * Two shapes behind one method, because the responses genuinely differ: OpenRouter
   * publishes capability metadata (so the filter is exact), while OpenAI and the local
   * runtimes publish bare ids (so it is a naming heuristic — see `openaiCatalog.ts`).
   * Fetched every time rather than baked in, so a model released tomorrow shows up
   * without an extension update.
   */
  async listModels(): Promise<ModelChoice[]> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        // M15 C2a: RAVIS lists `ravis/clarvis-codex` only when asked, and only an address on this Mac is asked.
        headers: { ...(await this.headers()), ...codexListingHeaders(this.baseUrl) },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.log(`model: listing ${this.id} models failed (http ${response.status})`);
        return [];
      }

      const body = await response.json();
      return this.id === 'openrouter' ? buildCatalog(body) : buildOpenAiCatalog(body);
    } catch (error) {
      this.log(`model: listing ${this.id} models failed (${String(error)})`);
      return [];
    }
  }

  /**
   * Whether this model can call tools, established by asking it to.
   *
   * A one-tool, one-token request is the only honest test: `/v1/models` reports
   * nothing about tool support, hosted providers lie by omission, and local runtimes
   * accept a `tools` parameter and then ignore it. Cheap enough to run once per model
   * and cache upstream.
   */
  async supportsTools(model: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: await this.headers(),
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'noop',
                description: 'does nothing',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
        }),
      });

      // A provider that rejects the request because of `tools` is telling us it can't.
      //
      // **Except when it is telling us something else entirely.** A 401 or 429 is about
      // the key or the quota, not the model — and reading it as "no tool support" was
      // observed live: a bad upstream credential produced `tool support = false`, which
      // is cached for the session, so the agent path would have stayed disabled for a
      // model that supports tools perfectly well even after the key was fixed.
      //
      // The same is true of everything the server says when it is not answering: a
      // gateway's 502, a runtime's 503 while a model loads. `probeAnswered` is where
      // that line is drawn, as a rule rather than as a list of the statuses that have
      // caught us out so far.
      if (!response.ok && !probeAnswered(response.status)) {
        this.log(`model: tool probe for ${this.id}/${model} hit ${response.status} — asking again later`);
        throw new ModelError(
          `${this.spec.label} would not answer a tool probe.`,
          `tool probe: HTTP ${response.status}`,
          true
        );
      }

      if (!response.ok) {
        this.log(`model: ${this.id}/${model} refused a tool probe (${response.status})`);
        return false;
      }
      return true;
    } catch (error) {
      if (error instanceof ModelError) throw error;
      // A timeout or a refused connection is not the model declining tools — it is the
      // probe never arriving. This returned `false`, so the first time the runtime was
      // closed the agent path was disabled for the whole session, including after it
      // came back.
      this.log(`model: tool probe failed for ${this.id}/${model} (${String(error)})`);
      throw new ModelError(
        `${this.spec.label} would not answer a tool probe.`,
        `tool probe: ${String(error)}`,
        true
      );
    }
  }

  /**
   * The tool-calling stream.
   *
   * OpenAI streams tool calls as deltas addressed by **index**, not by id: the first
   * delta carries the id and name, and later ones append argument fragments with
   * neither. Keying the accumulator on the id therefore loses every fragment after the
   * first, which shows up as a tool called with `{}` — a bug that looks like the model
   * being stupid rather than the parser being wrong.
   */
  async *streamWithTools(request: CompletionRequest): AsyncIterable<StreamEvent> {
    const response = await this.post(request, openAiTools(request.tools));
    const parser = new SseParser();
    const pending = new Map<number, PartialCall>();
    const watch = new ReasoningWatch();

    for await (const chunk of decodeStream(response.body!)) {
      for (const payload of parser.push(chunk)) {
        if (payload === '[DONE]') break;

        const choice = this.readFrame(payload)?.choices?.[0];
        if (!choice) continue;

        const text = watch.push(choice.delta);
        if (text) yield { type: 'text', text };
        if (choice.delta?.tool_calls?.length) watch.sawToolCall();
        absorbToolDeltas(pending, choice.delta?.tool_calls);
      }
    }

    // Whatever the filter was still holding when the stream ended — text that looked
    // like it might become a tag and never did.
    const tail = watch.flush();
    if (tail) yield { type: 'text', text: tail };

    this.refuseReasoningOnly(watch, request.model);

    // Emitted at the end rather than as they complete: nothing marks a tool call
    // finished mid-stream, so the arguments are only known to be whole once the
    // stream is.
    for (const call of pending.values()) {
      yield { type: 'toolCall', call: toCall(call) };
    }

    yield { type: 'stop', reason: pending.size > 0 ? 'tools' : 'end' };
  }

  /**
   * One SSE frame, or nothing.
   *
   * A frame that will not parse is skipped rather than thrown: providers emit keep-alive
   * and comment frames of their own devising, and killing a working stream over one of
   * them would be a bug about politeness.
   */
  private readFrame(payload: string): OpenAiChunk | undefined {
    try {
      return JSON.parse(payload) as OpenAiChunk;
    } catch {
      this.log(`model: skipped an unparseable ${this.id} frame`);
      return undefined;
    }
  }

  /**
   * Shared request setup, so the two streams cannot drift apart.
   *
   * They had. `stream()` built its own request until now, and the two were extended
   * separately on 20 Aug — leaving one mapping messages with `toOpenAiMessages` and the
   * other by hand, and one parsing frames through `readFrame` while the other inlined
   * the same try/catch and the same log line.
   */
  private async post(request: CompletionRequest, tools?: unknown[]): Promise<Response> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...(await this.headers()), ...lineageHeaders(request.traceId ?? '', request.sessionId ?? '') },
      signal: request.signal,
      body: JSON.stringify({
        model: request.model,
        stream: true,
        messages: [
          { role: 'system', content: request.system },
          ...request.messages.flatMap(toOpenAiMessages),
        ],
        ...(tools ? { tools } : {}),
      }),
    });

    if (!response.ok) {
      throw describeHttpFailure(response.status, await response.text(), this.spec.label);
    }
    if (!response.body) {
      throw new ModelError(`${this.spec.label} sent nothing back.`, 'empty response body');
    }

    return response;
  }

  /**
   * The plain reply stream — no tools offered.
   *
   * Shares `post()` with the tool stream rather than building its own request, which is
   * what that method's comment has always claimed and did not do. `messages` goes
   * through `toOpenAiMessages` as a result: not a behaviour change, because only
   * `AgentRunner` attaches tool calls or results to a message and it uses
   * `streamWithTools`, and for a message without either the mapping returns the single
   * `{ role, content }` this used to build by hand.
   */
  async *stream(request: CompletionRequest): AsyncIterable<string> {
    const response = await this.post(request);
    const parser = new SseParser();
    const watch = new ReasoningWatch();
    let done = false;

    for await (const chunk of decodeStream(response.body!)) {
      for (const payload of parser.push(chunk)) {
        // `[DONE]` used to return outright, which would now walk away from whatever the
        // filter is still holding. It ends the reading, not the function.
        if (payload === '[DONE]') {
          done = true;
          break;
        }

        // A malformed frame is skipped rather than thrown: one bad chunk should cost a
        // few tokens, not the whole answer the user is watching arrive.
        const event = this.readFrame(payload);
        if (!event) continue;

        const text = watch.push(event.choices?.[0]?.delta);
        if (text) yield text;
      }
      if (done) break;
    }

    const tail = watch.flush();
    if (tail) yield tail;

    this.refuseReasoningOnly(watch, request.model);
  }

  /**
   * Says so when a model spent the whole stream thinking and showed none of it (F29).
   *
   * Thrown rather than returned quietly, and thrown *after* the stream so anything that
   * did arrive is delivered first. The alternative — an empty reply — is the failure
   * this exists to end: two models were written off as slow on 20 Aug when they were
   * talking into a field nothing here reads.
   */
  private refuseReasoningOnly(watch: ReasoningWatch, model: string): void {
    if (!watch.saidNothing()) return;

    this.log(`model: ${this.id}/${model} returned ${watch.shape()} reasoning only`);
    throw watch.shape() === 'separate'
      ? reasoningFieldError(this.spec, model)
      : unfinishedThinkingError(this.spec, model);
  }

  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const key = await this.getKey();

    // Local providers accept a key and ignore it; sending one we don't have would mean
    // an "Authorization: Bearer undefined" header, which some gateways reject outright.
    if (key) headers.authorization = `Bearer ${key}`;
    return headers;
  }
}

function toCall(block: { id: string; name: string; args: string }): ToolCall {
  let args: unknown = {};

  try {
    args = block.args ? JSON.parse(block.args) : {};
  } catch {
    // Validation in the registry turns this into a message the model can act on.
    args = {};
  }

  return { id: block.id || block.name, name: block.name, args };
}

/**
 * Converts a neutral message into OpenAI's shape.
 *
 * Returns an **array**, because one neutral message holding several tool results
 * becomes several `role: 'tool'` messages — one per call id. Collapsing them into one
 * is rejected, and matching results to calls by position rather than id is how the
 * wrong output gets attributed to the wrong call.
 */
export function toOpenAiMessages(message: {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: { id: string; content: string; isError?: boolean }[];
}): unknown[] {
  if (message.toolResults?.length) {
    return [
      ...message.toolResults.map((result) => ({
        role: 'tool',
        tool_call_id: result.id,
        content: result.content,
      })),
      // **What the user said mid-run follows as its own user turn.** A tool message
      // carries only its call's output, so dropping this is how "no, use the other
      // library" was logged and never read. It goes after the last result: a user turn
      // between two of them leaves a call unanswered, which is rejected.
      ...(message.content ? [{ role: 'user', content: message.content }] : []),
    ];
  }

  if (message.toolCalls?.length) {
    return [
      {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })),
      },
    ];
  }

  return [{ role: message.role, content: message.content }];
}
