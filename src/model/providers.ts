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
export type ProviderId = 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'custom' | 'lmstudio';

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
  /**
   * Whether this provider has no address of its own and must be told one.
   *
   * True only for `custom`, which exists precisely because the field is empty: any
   * OpenAI-compatible server the user runs. A URL is to this provider what a key is to
   * Anthropic, and it is asked for in the same place for the same reason (§6 — a user who
   * never wants to hear him should also never have to open settings.json).
   */
  needsUrl?: boolean;
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
  // **LM Studio sits above Ollama deliberately**, and the order is the recommendation.
  // §6 gives the whole product a one-install-step setup budget and says that if it needs a
  // config file it has failed. Choosing a model in LM Studio is a search box and a button;
  // in Ollama it is `ollama pull` in a terminal, which is the failure §6 describes.
  //
  // Both stay. They share `OpenAiCompatibleProvider` — a base URL and a label between them
  // — so removing one saves no maintenance and costs everyone who already runs it. Order
  // and wording are the whole intervention. Anthropic stays first: this array's head is
  // also the fallback in `ModelService.spec()`.
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    dialect: 'openai',
    baseUrl: 'http://localhost:1234',
    needsKey: false,
    defaultModel: 'local-model',
    detail: 'Runs on your machine, nothing leaves it. Browse and load models in the app — no terminal. Start its server first.',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    dialect: 'openai',
    baseUrl: 'http://localhost:11434',
    needsKey: false,
    defaultModel: 'llama3.1',
    detail: 'Also local, also private. Standard port, nothing to configure — but models are pulled from a terminal.',
  },
  // **The escape hatch, and the reason the list can stop growing.** Every local runtime
  // worth using speaks the OpenAI dialect: llama.cpp, vLLM, LocalAI, Jan, a colleague's
  // box, a proxy. They differ by port and nothing else, so they do not each need a row —
  // they need one row that asks. `needsUrl` puts that question where the key question
  // already lives, rather than in settings.json (§6).
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    dialect: 'openai',
    baseUrl: '',
    needsKey: false,
    needsUrl: true,
    defaultModel: 'local-model',
    detail: 'Any other OpenAI-compatible server — llama.cpp, vLLM, LocalAI, or one on your network. Clarvis asks for the address.',
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
  const url = acceptableOverride(override, spec.needsKey) ?? spec.baseUrl;
  return url.replace(/\/+$/, '');
}

/**
 * What to say when a local endpoint refused the connection outright (F13).
 *
 * A refused connection to a known local port has one overwhelmingly likely cause,
 * so this names it directly rather than the generic "no models found" a keyed
 * provider's failure would get. One sentence, written once, so a chat reply and a
 * model picker never say it two different ways.
 */
export function providerNotRespondingLine(label: string, baseUrl: string): string {
  return `${label} isn't answering on \`${baseUrl}\`. Is it running?`;
}

/**
 * What to say when a local endpoint answered but listed nothing (F13's second edge).
 *
 * Deliberately a different sentence from `providerNotRespondingLine` — "not running"
 * and "running with nothing loaded" have different fixes, and telling someone to
 * start a server that is already running sends them looking for a problem they
 * don't have.
 */
export function providerListedNothingLine(label: string, baseUrl: string): string {
  return `${label} answered on \`${baseUrl}\` but isn't listing any models — has one been loaded yet?`;
}

/**
 * Whether a base-URL override is safe to use, given whether a key travels with it.
 *
 * **The rule follows the credential, not the protocol.** Every request to a
 * key-bearing provider carries that key in a header, so anything able to change this
 * URL could collect it along with whatever code context went with the question.
 * Raised in a security review, and it was worse than reported: there was no
 * validation at all.
 *
 * So the two kinds of provider get different rules, because they are exposed to
 * different things:
 *
 *  - **Keyed providers (Anthropic, OpenAI, OpenRouter): https, or this machine.**
 *    Plain http to somewhere else would put the key on the wire in clear text, and
 *    the loopback exception exists only because a proxy on your own machine is a
 *    normal thing to run.
 *  - **Keyless providers (Ollama, LM Studio): any http host.** There is no credential
 *    to leak, and `http://box:1234` — a model server on the machine under the desk —
 *    is exactly what this setting was added for. Banning it would cost a real setup
 *    to prevent nothing.
 *
 * `localhost` means `localhost`, not "contains localhost", which
 * `https://localhost.evil.example` would otherwise satisfy.
 *
 * A rejected value is ignored rather than raised: the request still goes to the real
 * provider, which is the safe outcome, and a setting nobody remembers writing should
 * not break the extension.
 */
export function acceptableOverride(override: string | undefined, needsKey = true): string | undefined {
  const value = override?.trim();
  if (!value) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (!needsKey) return value;

  if (url.protocol === 'https:') return value;
  return LOOPBACK.has(url.hostname) ? value : undefined;
}

/** The only hosts allowed to receive a key over plain http. Exact matches only. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);
