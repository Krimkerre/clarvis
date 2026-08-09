/**
 * The model providers Clarvis can talk to.
 *
 * Four of the six speak the OpenAI chat-completions dialect, so they are one adapter
 * with a different base URL rather than four integrations (§4.6). Keeping that as
 * *data* — rather than four classes that mostly agree — is what makes adding the next
 * OpenAI-compatible host a one-line change instead of a new file.
 *
 * No Claude-subscription entry: ruled out at M8b0. Anthropic does not permit
 * third-party products to offer claude.ai login or subscription rate limits without
 * prior approval, so the Anthropic path is API-key-only.
 */
export type ProviderId = 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'lmstudio';

export type Dialect = 'anthropic' | 'openai';

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  /** Which wire format this speaks. Decides the adapter, nothing else. */
  dialect: Dialect;
  /** Default endpoint. Overridable per provider for proxies and odd ports. */
  baseUrl: string;
  /** Local providers have no account to key against. */
  needsKey: boolean;
  /** Sensible starting model, used until the user picks one. */
  defaultModel: string;
  /** One line on the trade, shown in the picker — the version that helps someone choose. */
  detail: string;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    dialect: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    needsKey: true,
    defaultModel: 'claude-opus-5',
    detail: 'The default. Best tool calling, which is what the agent runs on.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    dialect: 'openai',
    baseUrl: 'https://api.openai.com',
    needsKey: true,
    defaultModel: 'gpt-5',
    detail: 'Solid tool calling. Use the key you already have.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    dialect: 'openai',
    baseUrl: 'https://openrouter.ai/api',
    needsKey: true,
    defaultModel: 'anthropic/claude-opus-4.5',
    detail: 'One key, many models. Quality depends entirely on which you pick.',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    dialect: 'openai',
    baseUrl: 'http://localhost:11434',
    needsKey: false,
    defaultModel: 'llama3.1',
    detail: 'Runs on your machine. No key, nothing leaves it — tool calling varies by model.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    dialect: 'openai',
    baseUrl: 'http://localhost:1234',
    needsKey: false,
    defaultModel: 'local-model',
    detail: 'Same as Ollama, different port. Whatever you have loaded.',
  },
];

export function providerSpec(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/**
 * The endpoint to call, given a provider and any user override.
 *
 * Local providers move ports constantly (a second Ollama, LM Studio on a colleague's
 * machine, a proxy in front of OpenAI), so an override is normal rather than exotic.
 * Trailing slashes are stripped here so `baseUrl + path` can't produce a double slash
 * that some gateways accept and others reject with an unhelpful 404.
 */
export function resolveBaseUrl(spec: ProviderSpec, override?: string): string {
  const url = override?.trim() || spec.baseUrl;
  return url.replace(/\/+$/, '');
}
