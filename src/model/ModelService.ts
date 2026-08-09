import * as vscode from 'vscode';
import { AnthropicProvider } from './AnthropicProvider';
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider';
import {
  CompletionRequest,
  ModelChoice,
  ModelError,
  ModelProvider,
  StreamEvent,
} from './ModelProvider';
import { PROVIDERS, ProviderId, ProviderSpec, providerSpec } from './providers';
import { ModelRole, RoleSettings, resolveRole } from './roles';

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

  /** Every role setting, read in one place so resolution stays pure and testable. */
  private settings(): RoleSettings {
    const config = vscode.workspace.getConfiguration('clarvis');
    return {
      chatProvider: config.get<string>('chat.provider', 'anthropic'),
      chatModel: config.get<string>('chat.model', ''),
      agentProvider: config.get<string>('agent.provider', ''),
      agentModel: config.get<string>('agent.model', ''),
    };
  }

  /** The provider for a role, or the default when the setting names nothing known. */
  spec(role: ModelRole = 'chat'): ProviderSpec {
    const { provider } = resolveRole(role, this.settings());

    const spec = providerSpec(provider);
    if (!spec) this.log(`model: unknown provider "${provider}", using anthropic`);
    return spec ?? PROVIDERS[0];
  }

  /** The model for a role — the user's choice, else that provider's default. */
  model(role: ModelRole = 'chat'): string {
    const { model } = resolveRole(role, this.settings());
    return model || this.spec(role).defaultModel;
  }

  /** Whether the agent runs on its own model rather than following chat. */
  agentIsSeparate(): boolean {
    return !resolveRole('agent', this.settings()).inherited;
  }

  /** Whether a question can be sent right now. */
  async isReady(role: ModelRole = 'chat'): Promise<boolean> {
    return this.provider(role).isAvailable();
  }

  /**
   * Whether the agent path can be offered for the current model.
   *
   * Probed once per provider/model and remembered for the session (§4.6). Probing on
   * every turn would spend a request per question to answer something that does not
   * change; never probing would mean discovering it mid-run, which is the failure this
   * is meant to prevent.
   */
  async supportsTools(role: ModelRole = 'agent'): Promise<boolean> {
    // Asked per role: the agent needs tools to work at all, while the chat model uses
    // them only to *look* at the project — a model without them still answers, it just
    // answers from memory rather than from the file.
    const spec = this.spec(role);
    const model = this.model(role);
    const cacheKey = `${spec.id}/${model}`;

    const cached = this.toolSupport.get(cacheKey);
    if (cached !== undefined) return cached;

    const supported = await this.provider(role).supportsTools(model);
    this.toolSupport.set(cacheKey, supported);
    this.log(`model: ${cacheKey} tool support = ${supported}`);
    return supported;
  }

  async listModels(role: ModelRole = 'chat'): Promise<ModelChoice[]> {
    return this.provider(role).listModels();
  }

  /** Which providers currently hold a key, for the key manager. */
  async keyedProviders(): Promise<Record<ProviderId, boolean>> {
    const entries = await Promise.all(
      PROVIDERS.map(async (spec) => [spec.id, await this.hasKey(spec.id)] as const)
    );
    return Object.fromEntries(entries) as Record<ProviderId, boolean>;
  }

  /**
   * Streams with tools offered, for the agent path.
   *
   * Throws when the configured provider has no tool support at all rather than
   * silently falling back to a text stream — an agent whose tools were quietly dropped
   * looks like a model that refuses to do anything, and the cause is invisible.
   */
  streamWithTools(
    request: Omit<CompletionRequest, 'model'>,
    role: ModelRole = 'agent'
  ): AsyncIterable<StreamEvent> {
    const provider = this.provider(role);

    if (!provider.streamWithTools) {
      throw new ModelError(
        `${this.spec(role).label} can't call tools, so I can't do the work — only talk about it.`,
        `${provider.id} has no streamWithTools`
      );
    }

    return provider.streamWithTools({ ...request, model: this.model(role) });
  }

  /** Streams an answer. Errors arrive as `ModelError`, already phrased for a human. */
  stream(request: Omit<CompletionRequest, 'model'>, role: ModelRole = 'chat'): AsyncIterable<string> {
    return this.provider(role).stream({ ...request, model: this.model(role) });
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
  private provider(role: ModelRole = 'chat'): ModelProvider {
    const spec = this.spec(role);
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
