/**
 * Works out which command probably fixed a recurring error.
 *
 * **The naive version doesn't work.** M5's build notes originally said "record the
 * next successful command as the fix" — but between a failure and its fix you'll
 * typically run `git status`, `ls`, a passing lint, and three other innocent things.
 * The next success is almost never the fix, and M5's own checklist demanded better.
 *
 * The real signal is narrower: **the failing command runs again and passes.** Only
 * then is anything confirmed fixed, and the credit belongs to whatever was run in
 * between — most plausibly the last thing before the retry.
 *
 * Still a guess, and always surfaced as one. But a guess grounded in an actual
 * red→green transition rather than in coincidence.
 */
export interface PendingFix {
  /** Fingerprint of the error we're trying to explain. */
  key: string;
  /** The command whose failure opened this — the one that must pass to close it. */
  failingLabel: string;
  /** Successful commands seen since, oldest first, excluding the failing one. */
  candidates: string[];
}

/** Enough to spot the fix; beyond this it's noise. */
const MAX_CANDIDATES = 10;

/** Opens (or restarts) attribution for a failing command. */
export function beginPending(key: string, failingLabel: string): PendingFix {
  return { key, failingLabel, candidates: [] };
}

/**
 * Folds one finished command into the pending attribution.
 *
 * Returns the next pending state, plus `resolvedBy` on the turn the original command
 * finally passes — that's the moment there's something worth recording.
 */
export function noteOutcome(
  pending: PendingFix | undefined,
  label: string,
  succeeded: boolean
): { pending: PendingFix | undefined; resolvedBy?: string } {
  if (!pending) return { pending: undefined };

  if (label === pending.failingLabel) {
    if (!succeeded) {
      // Still broken. Whatever we tried didn't work, so discard those candidates
      // rather than crediting them later.
      return { pending: { ...pending, candidates: [] } };
    }

    // Red → green on the original command: this is the only confirmation available.
    const resolvedBy = pending.candidates[pending.candidates.length - 1];
    return { pending: undefined, resolvedBy };
  }

  // An unrelated command. Successes are plausible fixes; failures are just noise.
  if (!succeeded) return { pending };

  const candidates = [...pending.candidates, label].slice(-MAX_CANDIDATES);
  return { pending: { ...pending, candidates } };
}
