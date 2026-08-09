import {
  CompletionRequest,
  ModelChoice,
  ModelError,
  ModelProvider,
  describeHttpFailure,
} from './ModelProvider';
import { buildCatalog } from './openrouterCatalog';
import { buildOpenAiCatalog } from './openaiCatalog';
import { ProviderSpec, resolveBaseUrl } from './providers';
import { SseParser, decodeStream } from './sse';

/**
 * One adapter, four providers: OpenAI, OpenRouter, Ollama and LM Studio.
 *
 * They all speak `/v1/chat/completions`, so the only differences are the base URL and
 * whether a key is required — both of which are data (`ProviderSpec`), not behaviour.
 * Writing four near-identical classes would mean fixing every streaming bug four times.
 */
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
        headers: await this.headers(),
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
      if (!response.ok) {
        this.log(`model: ${this.id}/${model} refused a tool probe (${response.status})`);
        return false;
      }
      return true;
    } catch (error) {
      this.log(`model: tool probe failed for ${this.id}/${model} (${String(error)})`);
      return false;
    }
  }

  async *stream(request: CompletionRequest): AsyncIterable<string> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: await this.headers(),
      signal: request.signal,
      body: JSON.stringify({
        model: request.model,
        stream: true,
        messages: [
          { role: 'system', content: request.system },
          ...request.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
      }),
    });

    if (!response.ok) {
      throw describeHttpFailure(response.status, await response.text(), this.spec.label);
    }
    if (!response.body) {
      throw new ModelError(`${this.spec.label} sent nothing back.`, 'empty response body');
    }

    const parser = new SseParser();

    for await (const chunk of decodeStream(response.body)) {
      for (const payload of parser.push(chunk)) {
        if (payload === '[DONE]') return;

        // A malformed frame is skipped rather than thrown: one bad chunk should cost a
        // few tokens, not the whole answer the user is watching arrive.
        try {
          const event = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const text = event.choices?.[0]?.delta?.content;
          if (text) yield text;
        } catch {
          this.log(`model: skipped an unparseable ${this.id} frame`);
        }
      }
    }
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
