/**
 * Whether Codex may start a task right now, from `GET /api/v1/codex` (plan.md M15, C2a; design §5.1).
 *
 * **Asked before anything is touched.** A Codex task starts by making a checkpoint and a branch, and a
 * refusal that arrived only after those would leave an empty `clarvis/…` branch behind for nothing —
 * the thing `plan.md` M15's risks already list for an old Clarvis. So the runner reads RAVIS's state
 * first and refuses, with the reason, unless all of these hold (design §5.1 step 1):
 * - Codex is signed in (`state` is `signed_in`);
 * - the installed Codex has been tested or accepted (`runtime.verdict`);
 * - the rules that keep Codex's commands away from key and password files are proven for it
 *   (`runtime.strict_rules` is `proven`; the owner's decision D2);
 * - Codex's process is running.
 *
 * Each refusal is one of `relayFailure.ts`'s kinds, the same ones RAVIS's `409 CODEX_NOT_READY` becomes,
 * so the chat words a refusal found here and one RAVIS gives later identically.
 *
 * Pure.
 */

import { failureForCodexState, type RelayFailure } from './relayFailure';
import type { CodexState } from './relayTypes';

const VERDICTS_THAT_MAY_RUN = new Set(['tested', 'accepted']);

/** Undefined when Codex may start; otherwise why not. */
export function codexReadiness(body: CodexState): RelayFailure | undefined {
  if (body.state !== 'signed_in') return failureForCodexState(body.state, body.reason);
  const runtime = body.runtime ?? {};
  if (!VERDICTS_THAT_MAY_RUN.has(runtime.verdict ?? '')) {
    return { kind: 'untested_version', fileRulesUnproven: false, reason: body.reason };
  }
  if (runtime.strict_rules !== 'proven') {
    return { kind: 'untested_version', fileRulesUnproven: true, reason: 'strict_file_rules_unproven' };
  }
  if (runtime.process?.state !== 'running') return { kind: 'codex_not_ready', state: 'runtime_down', reason: '' };
  return undefined;
}
