/**
 * The shared lock rule: is a project lock's holder alive, unresponsive, or gone? (plan.md M15, C1)
 *
 * **Specified once, implemented twice.** RAVIS judges its `project_lock` rows and the checkout lock
 * file with this rule; Clarvis judges the checkout lock file with it. Both are held to the same case
 * table, `src/test/fixtures/lock-rule-cases.json`, which RAVIS owns and Clarvis copies with a hash
 * check. If the two implementations ever disagreed, one engine would call a holder dead that the
 * other calls alive — two writers in one project, which is the thing the lock exists to prevent.
 *
 * **The three verdicts** (design §6.3):
 * - `gone`: the holder's pid isn't running, or its process start time differs from the one recorded
 *   (the pid was reused). **Only `gone` counts as dead.**
 * - `unresponsive`: the right process is still running, but its heartbeat is more than 90 s old
 *   **and** this observer has itself been awake for at least 90 s. A Mac that just woke hasn't given
 *   anyone time to heartbeat, so a stale heartbeat right after a sleep never makes a holder look dead.
 * - `alive`: otherwise.
 *
 * The file also carries two decisions built on the verdict — what a window does on finding a lock,
 * and RAVIS's rule for a lock file it finds when it restarts — and both are here too, so every table
 * in the shared case file is exercised by this repository's tests, not only the verdicts.
 *
 * Pure: the probe (`processProbe.ts`) and the clock are the caller's.
 */

import type { HolderKind } from '../relay/relayTypes';

export type Verdict = 'alive' | 'unresponsive' | 'gone';

/** Both limits: a heartbeat older than this, seen by an observer awake at least this long. */
export const THRESHOLD_SECONDS = 90;

/** What the rule needs from a lock: who holds it and how old its heartbeat is. */
export interface JudgedLock {
  pid: number;
  pid_start: string;
  heartbeat_age_seconds: number;
}

/** What was found when the holder's pid was looked up. */
export interface ProcessProbe {
  pid_running: boolean;
  /** `ps -o lstart= -p <pid>`, or null when the pid isn't running. */
  lstart: string | null;
}

/** `judgeLock(lock, probe, observerAwakeSeconds)`, the signature both implementations share. */
export function judgeLock(lock: JudgedLock, probe: ProcessProbe, observerAwakeSeconds: number): Verdict {
  if (!probe.pid_running || probe.lstart === null) return 'gone';
  if (!sameStart(probe.lstart, lock.pid_start)) return 'gone';
  // "Older than 90 s" is strict and "awake at least 90 s" is not: the cases pin both edges.
  const stale = lock.heartbeat_age_seconds > THRESHOLD_SECONDS;
  const settled = observerAwakeSeconds >= THRESHOLD_SECONDS;
  return stale && settled ? 'unresponsive' : 'alive';
}

/**
 * Whether two `ps -o lstart=` readings name the same moment. `ps` pads a one-digit day with a second
 * space ("Sat Sep  5") and ends its line with spaces, and a value stored in JSON may have lost either,
 * so both are compared with runs of whitespace collapsed.
 */
export function sameStart(a: string, b: string): boolean {
  return normaliseStart(a) === normaliseStart(b);
}

export function normaliseStart(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** What a window does when it wants to write and finds the project locked (`on_finding_a_lock`). */
export type FindingOutcome = 'attach' | 'reconcile' | 'refuse' | 'take_over_with_confirmation';

export function onFindingALock(holder: HolderKind, verdict: Verdict, waitingOnYou: boolean): FindingOutcome {
  // A Codex task lives in RAVIS: a window joins it and can stop it, and never takes it over.
  if (holder === 'codex_session') return 'attach';
  if (verdict === 'gone') return 'reconcile';
  // Asking first is only fair when the holder can't be working: stalled, or waiting on the owner.
  if (verdict === 'unresponsive' || waitingOnYou) return 'take_over_with_confirmation';
  return 'refuse';
}

/** A checkout lock file RAVIS finds at startup (`adoption_cases`), or null for no file. */
export interface AdoptionInput {
  file: { holder_kind: HolderKind; names_previous_ravis_instance: boolean; verdict: Verdict } | null;
  create_race_lost: boolean;
}

export interface AdoptionOutcome {
  action: 'rewrite' | 'superseded' | 'create';
  file_touched: boolean;
  ravis_lock_state: 'running' | 'superseded';
  codex_session_state?: 'uncertain';
  refused_with_409_lock_superseded?: string[];
}

/**
 * RAVIS's restart adoption rule (review AB1). RAVIS may rewrite a lock file only when it still names
 * RAVIS's own previous instance. Anyone else's file is left alone **whatever its verdict** — even a
 * `gone` window's — because a window that is merely slow to reconnect still owns uncommitted work; the
 * Codex session waits, and `settle-claim`, `turns` and `resume` answer `409 LOCK_SUPERSEDED`, until
 * that window releases or registers its lock with `adopt_file_lock`. Clarvis doesn't make this
 * decision; it keeps it so a reattaching window can tell why a task is paused.
 */
export function adoptionDecision(input: AdoptionInput): AdoptionOutcome {
  const ours = input.file === null ? !input.create_race_lost : input.file.names_previous_ravis_instance;
  if (!ours) return SUPERSEDED;
  return { action: input.file === null ? 'create' : 'rewrite', file_touched: true, ravis_lock_state: 'running' };
}

const SUPERSEDED: AdoptionOutcome = {
  action: 'superseded',
  file_touched: false,
  ravis_lock_state: 'superseded',
  codex_session_state: 'uncertain',
  refused_with_409_lock_superseded: ['settle-claim', 'turns', 'resume'],
};
