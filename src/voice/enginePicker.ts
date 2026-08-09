/**
 * The Fish Audio engines, described by what the choice actually costs you.
 *
 * "s1 vs s1-mini" is meaningless on its own, so the picker shows the tradeoff rather
 * than the bare model name. Verified against Fish Audio's documented identifiers —
 * these are the `model` header values, not display names.
 */
export interface EngineChoice {
  id: string;
  label: string;
  detail: string;
}

export const ENGINES: EngineChoice[] = [
  {
    id: 's2.1-pro-free',
    label: 'S2.1 Pro (free tier)',
    detail: 'Their current best model, at no per-call cost. Rate limited. The default, and the right answer for short briefings.',
  },
  {
    id: 's2.1-pro',
    label: 'S2.1 Pro',
    detail: 'The same model on the paid tier. Worth switching to only when the free tier’s limits start biting.',
  },
  {
    id: 's2-pro',
    label: 'S2 Pro',
    detail: 'Previous generation. Kept for voices that were tuned against it.',
  },
  { id: 's1', label: 'S1', detail: 'Older engine, still solid. Fast.' },
  { id: 's1-mini', label: 'S1 Mini', detail: 'Faster and cheaper than S1, slightly flatter delivery.' },
  {
    id: 'speech-1.6',
    label: 'Speech 1.6',
    detail: 'Oldest and cheapest. Some legacy voices were tuned against it.',
  },
];

/**
 * Whether a stored engine id is one we know about.
 *
 * Providers retire engines; an unrecognised value falls back to the default rather
 * than failing every utterance (§4.4). Fish Audio does the same server-side, but
 * relying on that would mean spending a request to discover the problem.
 */
export function isKnownEngine(id: string): boolean {
  return ENGINES.some((engine) => engine.id === id);
}
