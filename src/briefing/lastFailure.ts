import type { Outcome } from '../watch/BusyTracker';

/**
 * Where the record is kept.
 *
 * Defined here rather than in each reader: the briefing writes it, the chat reads it,
 * and dismissing it deletes it — three copies of a string is two chances to typo one.
 */
export const FAILURE_KEY = 'clarvis.lastFailure';

/**
 * The failing job worth mentioning at next launch — "the thread you dropped".
 *
 * Persisted across sessions (M3's outcomes are live-only), so this is the piece that
 * lets a briefing say what was broken when you walked away.
 */
export interface FailureRecord {
  label: string;
  exitCode: number | undefined;
  at: number; // epoch ms
}

/**
 * How long a recorded failure stays interesting.
 *
 * A fortnight-old failure is archaeology, not context — leading a briefing with it
 * would be actively misleading about where you left off.
 */
export const FAILURE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Folds an outcome into the stored record, returning the new value.
 *
 * Two rules, and the second is the one M4's checklist left open:
 *  - a failure is recorded, replacing any earlier one
 *  - **a success clears the stored failure if it's the same job**, because the thing
 *    you dropped is no longer dropped. A success from an *unrelated* job leaves it
 *    alone: `npm run lint` passing says nothing about the test suite still being red.
 *
 * Pure — takes the current record and returns the next one, so the decision is
 * testable without a Memento or an extension host.
 */
export function foldOutcome(
  current: FailureRecord | undefined,
  outcome: Outcome,
  now: number
): FailureRecord | undefined {
  const failed = outcome.exitCode !== 0;

  if (failed) {
    return { label: outcome.label, exitCode: outcome.exitCode, at: now };
  }

  // Succeeded: only clears the record if it's the same job that was failing.
  if (current && current.label === outcome.label) return undefined;
  return current;
}

/**
 * The stored failure, if it's still worth reporting. Returns undefined once it has
 * aged past the TTL, so callers never have to think about staleness themselves.
 */
export function activeFailure(
  record: FailureRecord | undefined,
  now: number
): FailureRecord | undefined {
  if (!record) return undefined;
  if (now - record.at > FAILURE_TTL_MS) return undefined;
  return record;
}

/**
 * Guards against malformed persisted state.
 *
 * `workspaceState` survives crashes, version changes, and half-written data from a
 * force-quit. Anything that isn't a well-formed record is treated as absent rather
 * than trusted into the briefing.
 */
export function parseRecord(raw: unknown): FailureRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const candidate = raw as Partial<FailureRecord>;
  if (typeof candidate.label !== 'string') return undefined;
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return undefined;
  if (candidate.exitCode !== undefined && typeof candidate.exitCode !== 'number') return undefined;

  return { label: candidate.label, exitCode: candidate.exitCode, at: candidate.at };
}
