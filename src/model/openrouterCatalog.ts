/**
 * Working out which OpenRouter models Clarvis can actually use.
 *
 * OpenRouter lists ~400 models and a quarter of them cannot call tools, which is what
 * the agent runs on. Offering the whole list would mean most picks silently produce a
 * chat-only Clarvis, and the user would have no way to know why — so the catalogue is
 * filtered against what `/api/v1/models` reports rather than left to trial and error.
 *
 * Pure and network-free: fetching is the caller's job, and the *filtering rules* are
 * the part worth testing.
 */

/** The fields we rely on, out of a much larger response. */
export interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: { prompt?: string; completion?: string };
}

export interface CatalogEntry {
  id: string;
  label: string;
  /** Context window and price, the two things that decide between near-equals. */
  detail: string;
  /** Prompt price per token, as a number — 0 for free tiers. Used for sorting. */
  promptPrice: number;
  contextLength: number;
}

/**
 * Whether a model can do the job.
 *
 * Two requirements, both load-bearing:
 *  - **`tools` in `supported_parameters`** — the agent path is a tool loop, and a model
 *    without tool support accepts the request and then ignores the tools, which looks
 *    like the agent doing nothing rather than a model that cannot.
 *  - **text in and text out** — image-only and audio-only endpoints appear in the same
 *    list and would fail on the first ordinary question.
 */
export function isCompatible(model: OpenRouterModel): boolean {
  const params = model.supported_parameters ?? [];
  const architecture = model.architecture ?? {};

  const callsTools = params.includes('tools');
  const readsText = (architecture.input_modalities ?? []).includes('text');
  const writesText = (architecture.output_modalities ?? []).includes('text');

  return callsTools && readsText && writesText;
}

/**
 * Turns the raw response into a sorted, usable list.
 *
 * Cheapest first, because that is the axis people actually choose on once tool support
 * is guaranteed — and free models sort to the top, which is the right default for
 * someone trying this out.
 *
 * Anything malformed is dropped rather than throwing: this response comes from a third
 * party that will add fields and occasionally omit them, and one odd entry must not
 * empty the picker.
 */
export function buildCatalog(raw: unknown): CatalogEntry[] {
  const models = (raw as { data?: unknown })?.data;
  if (!Array.isArray(models)) return [];

  return models
    .filter((model): model is OpenRouterModel => Boolean(model) && typeof model === 'object')
    .filter((model) => typeof model.id === 'string' && model.id.length > 0)
    .filter(isCompatible)
    .map(toEntry)
    .sort((a, b) => a.promptPrice - b.promptPrice || a.id.localeCompare(b.id));
}

function toEntry(model: OpenRouterModel): CatalogEntry {
  const promptPrice = Number(model.pricing?.prompt ?? '0') || 0;
  const contextLength = model.context_length ?? 0;

  return {
    id: model.id,
    label: model.name ?? model.id,
    detail: `${formatContext(contextLength)} context · ${formatPrice(promptPrice)}`,
    promptPrice,
    contextLength,
  };
}

/** "1M" beats "1048576" at a glance, and this list is read at a glance. */
function formatContext(tokens: number): string {
  if (tokens <= 0) return 'unknown';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/**
 * Price per million prompt tokens.
 *
 * Per-token prices are unreadable — `0.000000079996` tells nobody anything. Per
 * million is the unit every provider quotes in its own pricing page.
 */
function formatPrice(perToken: number): string {
  if (perToken === 0) return 'free';

  const perMillion = perToken * 1_000_000;
  // Two decimals hides the difference between the very cheapest models, where the
  // whole point of sorting by price is telling them apart.
  return `$${perMillion < 1 ? perMillion.toFixed(3) : perMillion.toFixed(2)}/M in`;
}
