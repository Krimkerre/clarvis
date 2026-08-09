/**
 * Picking the chat models out of an OpenAI-compatible `/v1/models` response.
 *
 * Unlike OpenRouter, this response carries **no capability metadata at all** — just
 * ids. And the list mixes in embeddings, speech, transcription, image and moderation
 * models, none of which can hold a conversation. Offering them means the user picks
 * `text-embedding-3-large`, gets an unhelpful 400, and reasonably concludes Clarvis is
 * broken.
 *
 * So this is a **heuristic, and openly labelled as one**. It is a display filter, not a
 * safety check: the authoritative answer is `supportsTools()`, which asks the model
 * itself. Anything wrongly excluded can still be typed in by hand.
 */

/** Families that are definitively not chat models, by the naming every vendor uses. */
const NOT_CHAT = [
  /embed/i,
  /^tts/i,
  /whisper/i,
  /transcribe/i,
  /^dall-e/i,
  /image/i,
  /moderation/i,
  /^omni-moderation/i,
  /audio/i,
  /realtime/i,
  /rerank/i,
  /guard/i, // safety classifiers: llama-guard and friends
];

export function isLikelyChatModel(id: string): boolean {
  return !NOT_CHAT.some((pattern) => pattern.test(id));
}

/**
 * Filters and sorts an OpenAI-style model list.
 *
 * Newest first where the response says so — `created` is a unix timestamp on OpenAI and
 * absent on most local runtimes, so the sort falls back to alphabetical rather than
 * producing an arbitrary order that changes between calls.
 */
export function buildOpenAiCatalog(raw: unknown): { id: string; label: string; detail: string }[] {
  const models = (raw as { data?: unknown })?.data;
  if (!Array.isArray(models)) return [];

  const entries = models
    .filter((model): model is { id: string; created?: number; owned_by?: string } =>
      Boolean(model) && typeof model === 'object' && typeof (model as { id?: unknown }).id === 'string'
    )
    .filter((model) => isLikelyChatModel(model.id));

  const haveDates = entries.every((model) => typeof model.created === 'number');

  return entries
    .sort((a, b) =>
      haveDates ? (b.created ?? 0) - (a.created ?? 0) : a.id.localeCompare(b.id)
    )
    .map((model) => ({
      id: model.id,
      label: model.id,
      detail: model.owned_by ? `by ${model.owned_by}` : 'chat model',
    }));
}
