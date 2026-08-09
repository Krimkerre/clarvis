import * as vscode from 'vscode';
import { AnthropicProvider } from './AnthropicProvider';
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider';
import { CompletionRequest, ModelChoice, ModelError, ModelProvider } from './ModelProvider';
import { PROVIDERS, ProviderId, ProviderSpec, providerSpec } from './providers';

/** Secret-storage key per provider. Namespaced so one provider's key can't shadow another's. */
export function keySecretId(provider: ProviderId): string {
  return `clarvis.model.key.${provider}`;
}

/**
 * The one place that knows which model is configured and how to reach it.
 *
 * Providers are constructed on demand rather than all at once: building five adapters
 * at activation would mean five objects, four of which are never used, and each
 * holding a closure over secret storage.
 */
export class ModelService {
  /** Tool-support probe results, keyed by `provider/model`. Cheap, but not free. */
  private readonly toolSupport = new Map<string, boolean>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void
  ) {}

  /** The configured provider, or the default when the setting names nothing known. */
  get spec(): ProviderSpec {
    const configured = vscode.workspace
      .getConfiguration('clarvis')
      .get<string>('chat.provider', 'anthropic');

    const spec = providerSpec(configured);
    if (!spec) this.log(`model: unknown provider "${configured}", using anthropic`);
    return spec ?? PROVIDERS[0];
  }

  /** The model to use — the user's choice, else the provider's default. */
  get model(): string {
    const configured = vscode.workspace.getConfiguration('clarvis').get<string>('chat.model', '');
    return configured.trim() || this.spec.defaultModel;
  }

  /** Whether a question can be sent right now. */
  async isReady(): Promise<boolean> {
    return this.provider().isAvailable();
  }

  /**
   * Whether the agent path can be offered for the current model.
   *
   * Probed once per provider/model and remembered for the session (§4.6). Probing on
   * every turn would spend a request per question to answer something that does not
   * change; never probing would mean discovering it mid-run, which is the failure this
   * is meant to prevent.
   */
  async supportsTools(): Promise<boolean> {
    const cacheKey = `${this.spec.id}/${this.model}`;
    const cached = this.toolSupport.get(cacheKey);
    if (cached !== undefined) return cached;

    const supported = await this.provider().supportsTools(this.model);
    this.toolSupport.set(cacheKey, supported);
    this.log(`model: ${cacheKey} tool support = ${supported}`);
    return supported;
  }

  async listModels(): Promise<ModelChoice[]> {
    return this.provider().listModels();
  }

  /** Which providers currently hold a key, for the key manager. */
  async keyedProviders(): Promise<Record<ProviderId, boolean>> {
    const entries = await Promise.all(
      PROVIDERS.map(async (spec) => [spec.id, await this.hasKey(spec.id)] as const)
    );
    return Object.fromEntries(entries) as Record<ProviderId, boolean>;
  }

  /** Streams an answer. Errors arrive as `ModelError`, already phrased for a human. */
  stream(request: Omit<CompletionRequest, 'model'>): AsyncIterable<string> {
    return this.provider().stream({ ...request, model: this.model });
  }

  /** Stores a provider's key in the OS keychain — never in settings, never logged. */
  async setKey(provider: ProviderId, key: string): Promise<void> {
    await this.context.secrets.store(keySecretId(provider), key.trim());
    this.log(`model: stored a key for ${provider}`);
  }

  async clearKey(provider: ProviderId): Promise<void> {
    await this.context.secrets.delete(keySecretId(provider));
    this.log(`model: cleared the key for ${provider}`);
  }

  async hasKey(provider: ProviderId): Promise<boolean> {
    return Boolean(await this.context.secrets.get(keySecretId(provider)));
  }

  /** Builds the adapter for the configured provider. */
  private provider(): ModelProvider {
    const spec = this.spec;
    // Wrapped rather than passed through: SecretStorage returns a Thenable, and the
    // adapters want a real Promise so they can use await/catch normally.
    const getKey = async () => this.context.secrets.get(keySecretId(spec.id));
    const override = () =>
      vscode.workspace.getConfiguration('clarvis').get<string>(`chat.baseUrl.${spec.id}`, '');

    if (spec.dialect === 'anthropic') {
      return new AnthropicProvider(spec, getKey, override, this.log);
    }
    return new OpenAiCompatibleProvider(spec, getKey, override, this.log);
  }
}

/**
 * Everything the user should be told when a model can't be reached.
 *
 * A `ModelError` already carries a human sentence; anything else is a bug or a network
 * fault and gets a generic line rather than a stack trace pasted into the transcript.
 */
export function explain(error: unknown): { text: string; detail: string } {
  if (error instanceof ModelError) {
    return { text: error.friendly, detail: error.detail };
  }

  // AbortError is the user pressing stop, not a failure — the caller checks for it
  // before reaching here, so arriving with one means something else aborted us.
  const detail = error instanceof Error ? error.message : String(error);
  return {
    text: "I couldn't reach the model. The output channel has the unglamorous details.",
    detail,
  };
}
