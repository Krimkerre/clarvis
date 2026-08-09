import {
  CompletionRequest,
  ModelChoice,
  ModelError,
  ModelProvider,
  describeHttpFailure,
} from './ModelProvider';
import { ProviderSpec, resolveBaseUrl } from './providers';
import { SseParser, decodeStream } from './sse';

/** Wire version. Pinned, because an unpinned API version changes under you silently. */
const API_VERSION = '2023-06-01';

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

  async *stream(request: CompletionRequest): AsyncIterable<string> {
    const key = await this.getKey();
    if (!key) {
      throw new ModelError('No Anthropic key set. `/key` sorts that out.', 'no api key stored');
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      signal: request.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: 2048,
        stream: true,
        // Top-level, not a message — the shape difference this adapter exists for.
        system: request.system,
        messages: request.messages,
      }),
    });

    if (!response.ok) {
      throw describeHttpFailure(response.status, await response.text(), this.spec.label);
    }
    if (!response.body) {
      throw new ModelError('Anthropic sent nothing back.', 'empty response body');
    }

    const parser = new SseParser();

    for await (const chunk of decodeStream(response.body)) {
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
