/**
 * Switching an unfinished task between engines, as steps and the rules between them
 * (plan.md M15, C3; design §6.2; review B1, N1, N2, AH4).
 *
 * **The steps, in order:** `stopping` (the lock is reserved for the destination, then the source is stopped),
 * `confirming` (every process the source started is confirmed gone), `settling` (its work is committed on the
 * task's branch), `saved` (the checkpoint is written), `starting` (the destination takes the lock with the
 * transfer token and continues on the branch), `started`. Any step before `started` can end in `failed`.
 *
 * **The lock is held throughout.** From `stopping` until the destination has started, the source holds the
 * project lock in `transferring`, and nothing lets it go (N2). A switch that fails leaves the lock with the
 * source, which lets go only once every process is confirmed gone and its work is saved (N1).
 *
 * **Which way Codex starts** (design §6.2 step 6): the task's earlier Codex session when RAVIS still keeps it
 * idle — a switch back reuses it and never ends or archives it (AH4); otherwise a new session resuming the old
 * thread, when the thread lives in the same Codex home, the account is the confirmed one, and this Codex is
 * tested or accepted with its file rules proven; otherwise a fresh start from the checkpoint.
 *
 * Pure.
 */

import type { EngineKind } from '../CodingRun';
import type { TaskCheckpoint, TransferStep } from '../checkpoint/taskCheckpoint';
import type { CodexState, HolderKind } from '../relay/relayTypes';

export const TRANSFER_STEPS: readonly TransferStep[] = ['stopping', 'confirming', 'settling', 'saved', 'starting', 'started'];

/** Forward one step at a time; `failed` from any step before `started`; nothing after `started` or `failed`. */
export function mayMove(from: TransferStep | undefined, to: TransferStep): boolean {
  if (from === 'started' || from === 'failed') return false;
  if (to === 'failed') return from !== undefined;
  const next = from === undefined ? 0 : TRANSFER_STEPS.indexOf(from) + 1;
  return TRANSFER_STEPS[next] === to;
}

/**
 * Whether the source may let the project lock go now. Never during a switch — the lock is the destination's
 * to take — and never after one has started. Outside a switch, or after one failed, only once every process is
 * confirmed gone and the work is saved.
 */
export function mayReleaseLock(state: { step: TransferStep | undefined; processesGone: boolean; saved: boolean }): boolean {
  if (state.step !== undefined && state.step !== 'failed') return false;
  return state.processesGone && state.saved;
}

/** Who holds the lock after the switch, as RAVIS's transfer route names it. */
export function holderFor(engine: EngineKind): HolderKind {
  return engine === 'codex' ? 'codex_session' : 'clarvis_run';
}

export type CodexStart = { kind: 'catch_up'; sessionId: string } | { kind: 'resume'; threadId: string } | { kind: 'brief' };

const VERDICTS_THAT_MAY_RESUME = new Set(['tested', 'accepted']);

/** How Codex takes a task back (design §6.2 step 6). `idleSessionId` is the task's session when RAVIS lists it `idle`. */
export function codexStartFor(checkpoint: TaskCheckpoint, codex: CodexState, idleSessionId: string | undefined): CodexStart {
  const earlier = checkpoint.codexSession;
  if (earlier && idleSessionId === earlier.id) return { kind: 'catch_up', sessionId: earlier.id };
  return earlier?.threadId && mayResume(checkpoint, codex) ? { kind: 'resume', threadId: earlier.threadId } : { kind: 'brief' };
}

function mayResume(checkpoint: TaskCheckpoint, codex: CodexState): boolean {
  return sameCodexHome(checkpoint, codex) && codex.account?.fingerprint_matches === true && provenRuntime(codex);
}

/** The thread lives in the Codex home RAVIS runs on now (the owner's decision D3 keeps it there). */
function sameCodexHome(checkpoint: TaskCheckpoint, codex: CodexState): boolean {
  const home = checkpoint.codexSession?.homeFingerprint;
  return home !== undefined && codex.home?.fingerprint === home;
}

function provenRuntime(codex: CodexState): boolean {
  return VERDICTS_THAT_MAY_RESUME.has(codex.runtime.verdict ?? '') && codex.runtime.strict_rules === 'proven';
}

/** The confirmation before anything stops (design §6.2 step 1): no paid work, and no allowance spent, without a yes. */
export function switchConfirmLine(to: EngineKind, toModel: string): string {
  return to === 'codex'
    ? "Stop and continue this task with Codex? That uses your ChatGPT plan's allowance."
    : `Stop Codex and continue this task with ${toModel}? That uses your API providers, which RAVIS counts as spend.`;
}
