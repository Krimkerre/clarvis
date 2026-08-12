/** How far back occurrences count. §4.2: three times in seven days. */
export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Occurrences within the window before Clarvis says anything. */
export const THRESHOLD = 3;

/** What we remember about one recurring error. */
export interface Pattern {
  /** A readable excerpt, for showing the user what "this error" refers to. */
  sample: string;
  /** Epoch-ms timestamps, oldest first, pruned to the window. */
  occurrences: number[];
  /** The command that appeared to fix it last time. A guess, always labelled as one. */
  resolvedBy?: string;
}

export interface PatternState {
  version: 1;
  patterns: Record<string, Pattern>;
}

export function emptyState(): PatternState {
  return { version: 1, patterns: {} };
}

/** Drops occurrences that have aged out, so a count is always "within the window". */
function prune(occurrences: number[], now: number): number[] {
  return occurrences.filter((at) => now - at <= WINDOW_MS);
}

/**
 * Records an occurrence and reports whether it just crossed the threshold.
 *
 * `shouldSurface` is true only on the exact occurrence that reaches the threshold —
 * not on every occurrence after it. Otherwise a persistently broken build would
 * produce the same remark on every single run, which is how a useful signal becomes
 * something people mute.
 */
export function recordOccurrence(
  state: PatternState,
  key: string,
  sample: string,
  now: number
): { state: PatternState; shouldSurface: boolean; pattern: Pattern } {
  const existing = state.patterns[key];
  const occurrences = [...prune(existing?.occurrences ?? [], now), now];

  const pattern: Pattern = {
    sample: existing?.sample ?? sample,
    occurrences,
    resolvedBy: existing?.resolvedBy,
  };

  return {
    state: { ...state, patterns: { ...state.patterns, [key]: pattern } },
    shouldSurface: occurrences.length === THRESHOLD,
    pattern,
  };
}

/** Attaches a candidate fix to a known pattern. */
export function recordResolution(state: PatternState, key: string, command: string): PatternState {
  const existing = state.patterns[key];
  if (!existing) return state;

  return {
    ...state,
    patterns: { ...state.patterns, [key]: { ...existing, resolvedBy: command } },
  };
}

/**
 * The most-repeated pattern still inside the window, for the briefing's fourth line
 * (§4.3). Returns nothing unless something has actually recurred — a pattern seen
 * once is not a pattern.
 */
export function topPattern(
  state: PatternState,
  now: number
): { key: string; pattern: Pattern; count: number } | undefined {
  let best: { key: string; pattern: Pattern; count: number } | undefined;

  for (const [key, pattern] of Object.entries(state.patterns)) {
    const count = prune(pattern.occurrences, now).length;
    if (count < 2) continue;
    if (!best || count > best.count) best = { key, pattern, count };
  }

  return best;
}

/**
 * Guards against anything that isn't a well-formed store.
 *
 * The file lives on disk across upgrades and can be hand-edited, truncated by a
 * crash, or written by a future version. Anything unrecognised starts empty rather
 * than breaking activation — losing pattern history is a minor annoyance; failing to
 * start is not.
 */
export function parseState(raw: unknown): PatternState {
  if (!raw || typeof raw !== 'object') return emptyState();

  const candidate = raw as Partial<PatternState>;
  if (candidate.version !== 1 || !candidate.patterns || typeof candidate.patterns !== 'object') {
    return emptyState();
  }

  const patterns: Record<string, Pattern> = {};
  for (const [key, value] of Object.entries(candidate.patterns)) {
    const p = value as Partial<Pattern>;
    if (typeof p?.sample !== 'string' || !Array.isArray(p.occurrences)) continue;

    const occurrences = p.occurrences.filter((n): n is number => typeof n === 'number');
    if (occurrences.length === 0) continue;

    patterns[key] = {
      sample: p.sample,
      occurrences,
      resolvedBy: typeof p.resolvedBy === 'string' ? p.resolvedBy : undefined,
    };
  }

  return { version: 1, patterns };
}

/**
 * Drops every pattern that mentions `needle`.
 *
 * Forgetting a job has to mean forgetting it everywhere. The failure record and the
 * pattern memory are separate stores with separate rules, and clearing only the first
 * left him still opening with "seen probe-build-fail 4× this week" — which, to the
 * person who just asked him to drop it, is the same thing said again.
 *
 * Matched loosely on the sample text, because the user names the job the way they see
 * it in their tasks list, not the way an error line spells it.
 */
export function forgetMatching(state: PatternState, needle: string): { state: PatternState; removed: number } {
  const wanted = needle.trim().toLowerCase();
  if (!wanted) return { state, removed: 0 };

  const kept: Record<string, Pattern> = {};
  let removed = 0;

  for (const [key, pattern] of Object.entries(state.patterns)) {
    const mentions =
      pattern.sample.toLowerCase().includes(wanted) || (pattern.resolvedBy ?? '').toLowerCase().includes(wanted);

    if (mentions) removed++;
    else kept[key] = pattern;
  }

  return { state: { ...state, patterns: kept }, removed };
}
