/**
 * Codex's real requests, from RAVIS's calibration of Codex 0.154.0 (plan.md M15, C2b) — the fakes' requests,
 * updated from calibration's transcripts, as design §10.5 asks.
 *
 * **Where they come from.** Run `cal_5a1d6ecc33b4` (14 September 2026), whose transcripts RAVIS committed at
 * `ravis/tests/fixtures/codex/calibration/0.154.0-cal_5a1d6ecc33b4/`. Each entry below is one of Codex's
 * `…/requestApproval` messages there, turned into the `RequestView` a window receives the way RAVIS turns it
 * (`ravis/src/ravis/agent/requests.py`): the command as Codex sent it, the working folder shown relative to the
 * project (`.` for the root), a missing reason as null, no network or escalation because Codex sent none, and the
 * decisions RAVIS offers. `calibrationRequests.test.ts` holds every field to the transcripts whenever the
 * NERVIS-ecosystem checkout sits beside this one.
 *
 * **What they taught.** Codex wraps every command in a login shell — `/bin/zsh -lc "printf 'k2\n' > …"` — so
 * anything judging a command must look inside the quotes (`approvals.ts`, `commandLayers`); Codex's own
 * `commandActions` name the script inside, kept here as `script`. A file-change request carries no files of its
 * own: RAVIS takes them from the item Codex started (K1). And Codex offered a "for the session" answer that K11
 * showed outlives the step, which RAVIS never offers a window.
 *
 * The transcripts keep RAVIS's placeholders — `<project-a>` for the project, `<codex-home>` for Codex's home — and
 * so do these. Test support only.
 */

import type { DecisionKind, RequestKind } from '../../engine/relay/relayTypes';

export const CALIBRATION_RUN = 'cal_5a1d6ecc33b4';

/** The transcript folder, relative to the NERVIS-ecosystem checkout. */
export const CALIBRATION_FOLDER = 'ravis/tests/fixtures/codex/calibration/0.154.0-cal_5a1d6ecc33b4';

export interface CalibrationRequest {
  /** The calibration question, the transcript file and the line's `n` the request is taken from. */
  from: { question: string; file: string; n: number };
  kind: Extract<RequestKind, 'command' | 'fileChange'>;
  itemId: string;
  payload: Record<string, unknown>;
  allowed_decisions: DecisionKind[];
  /** A command's script inside Codex's shell wrapper: Codex's own `commandActions[0].command`. */
  script?: string;
}

const APPROVABLE: DecisionKind[] = ['once', 'skip', 'stop'];

function command(question: string, file: string, n: number, itemId: string, wrapped: string, script: string, reason: string | null = null): CalibrationRequest {
  return {
    from: { question, file, n },
    kind: 'command',
    itemId,
    payload: { command: wrapped, cwd: '.', reason, network: null, escalation: null, gate_hint: null },
    allowed_decisions: APPROVABLE,
    script,
  };
}

/** K1: Codex asks before its file-editing tool creates a file, under `untrusted` with the workspace box. */
export const K1_FILE_CHANGE: CalibrationRequest = {
  from: { question: 'K1', file: 'K1.jsonl', n: 29 },
  kind: 'fileChange',
  itemId: 'exec-31604268-b219-4d9e-996d-9da5f22bff22',
  // From the item Codex started at n 27: `add`, a diff of the one line `k1`.
  payload: { files: [{ path: 'ravis-cal-k1-cal_5a1d6ecc33b4-untrusted.txt', change: 'add', added: 1, removed: 0 }], reason: null, outside_workspace: [] },
  allowed_decisions: APPROVABLE,
};

/** K2: four approved commands in a row, one turn — writes aimed above the project, at /tmp, at Codex's temp folder and inside. */
export const K2_COMMANDS: CalibrationRequest[] = [
  command('K2', 'K2.jsonl', 34, 'exec-108d07f8-db93-44a7-a0af-197e6b7a4d90',
    String.raw`/bin/zsh -lc "printf 'k2\\n' > ../ravis-cal-k2-cal_5a1d6ecc33b4-up"`,
    String.raw`printf 'k2\n' > ../ravis-cal-k2-cal_5a1d6ecc33b4-up`),
  command('K2', 'K2.jsonl', 41, 'exec-f6192958-4a1c-4b8e-9866-c01df85a514d',
    String.raw`/bin/zsh -lc "printf 'k2\\n' > /tmp/ravis-cal-k2-cal_5a1d6ecc33b4-slash-tmp"`,
    String.raw`printf 'k2\n' > /tmp/ravis-cal-k2-cal_5a1d6ecc33b4-slash-tmp`),
  command('K2', 'K2.jsonl', 48, 'exec-adbe0599-e68f-44bd-8ca8-8baf20466223',
    String.raw`/bin/zsh -lc "printf 'k2\\n' > <codex-home>/tmp/ravis-cal-k2-cal_5a1d6ecc33b4-tmpdir"`,
    String.raw`printf 'k2\n' > <codex-home>/tmp/ravis-cal-k2-cal_5a1d6ecc33b4-tmpdir`),
  command('K2', 'K2.jsonl', 55, 'exec-ae0900cb-8847-4504-b6e0-e057e28d86da',
    String.raw`/bin/zsh -lc "mkdir -p .clarvis/tmp/cal_5a1d6ecc33b4-k2 && printf 'k2\\n' > .clarvis/tmp/cal_5a1d6ecc33b4-k2/k2.txt"`,
    String.raw`mkdir -p .clarvis/tmp/cal_5a1d6ecc33b4-k2 && printf 'k2\n' > .clarvis/tmp/cal_5a1d6ecc33b4-k2/k2.txt`),
];

/** K4: Codex told to ask for escalated permissions asks with a reason and no extra permissions, under `untrusted`. */
export const K4_WITH_REASON: CalibrationRequest = command('K4', 'K4.jsonl', 49, 'exec-612ef1ec-c9b1-41ad-9c34-9697df53a694',
  String.raw`/bin/zsh -lc "printf 'k4\\n' > '~/Documents/coding/NERVIS workspace/clarvis/nervis-tasks/ravis-cal-k4-cal_5a1d6ecc33b4-untrusted'"`,
  String.raw`printf 'k4\n' > '~/Documents/coding/NERVIS workspace/clarvis/nervis-tasks/ravis-cal-k4-cal_5a1d6ecc33b4-untrusted'`,
  'May I run the exact K4 command to write the specified file outside the writable workspace?');

/** K11: the command calibration answered "for the session", which survived a steer and a new turn. RAVIS offers a window only once, skip or stop. */
export const K11_FOR_THE_SESSION: CalibrationRequest = command('K11', 'K11.jsonl', 29, 'exec-16a5d8c5-b97d-44e9-b038-20cf485f4abb',
  String.raw`/bin/zsh -lc "printf 'k11\\n' >> ravis-cal-k11-cal_5a1d6ecc33b4-log.txt"`,
  String.raw`printf 'k11\n' >> ravis-cal-k11-cal_5a1d6ecc33b4-log.txt`);

export const CALIBRATION_REQUESTS: CalibrationRequest[] = [K1_FILE_CHANGE, ...K2_COMMANDS, K4_WITH_REASON, K11_FOR_THE_SESSION];
