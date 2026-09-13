/**
 * What the chat says about a Codex task: why it didn't start, how it stopped, what went wrong
 * (plan.md M15, C2a; design §9, §5.2–§5.4).
 *
 * **The design's words where it gives them.** Design §9 fixes what the owner sees for each failure, and
 * those sentences are used as written. **RAVIS's own words otherwise**: a refusal's `message`, a state's
 * `reason`, a turn error's `message` are passed through rather than paraphrased, because a paraphrase can
 * drift from what actually happened. A turn failure whose `error.kind` the contract doesn't fix yet is
 * never guessed at — it is shown as RAVIS's message.
 *
 * **Kept apart on purpose.** An allowance that ran out, throttling, being signed out, a version that
 * needs re-testing and RAVIS not answering each lead somewhere different — wait for the reset, try again
 * shortly, sign in, re-test, check RAVIS — so each says its own thing (`relayFailure.ts` keeps the
 * kinds apart for exactly this).
 *
 * Pure.
 */

import type { RelayFailure } from '../relay/relayFailure';
import type { RequestView, SessionSummary } from '../relay/relayTypes';
import type { TokenRead } from '../relay/tokenStore';

export const CODEX_LINES = {
  ravisDownAtStart: "RAVIS isn't answering, so Codex can't start. Clarvis's own engine still works.",
  ravisDownMidTurn: "RAVIS stopped answering; Codex's step may have been cut off. I'll reconnect when it's back.",
  ravisBack: 'RAVIS is answering again, and Codex is back in view.',
  stopping: 'Stopping Codex…',
  stopUnreachable: "RAVIS isn't answering, so Codex can't be told to stop from here yet. I'll keep trying.",
  stopped: 'Stopped.',
  keptForLater: "Noted — I'll pass that on when the task continues.",
  passedOn: 'Passed to Codex.',
  queued: 'Passed to Codex for its next turn.',
  notDelivered: "Codex couldn't take that in yet; I'll pass it on when the task continues.",
  lockedForTurns: "Clarvis's own engine is working on this project; Codex can continue after a switch back.",
  uncertain:
    'RAVIS restarted while Codex was working. The last step may not have finished; its changes are in the project.',
  superseded: "Codex's task is paused until Clarvis's own run here finishes.",
  adoptedFromGoneEditor:
    "The editor that paused this Codex task has closed, so this one stopped what it left running and took the project over to save Codex's work.",
  carryOnOffer: 'Codex used all the steps it may take in one go. Carry on where it stopped?',
  cannotSwitch: "This Codex task can't be handed over from here right now, so nothing was stopped.",
  stoppingForSwitch: 'Stopping Codex to hand the task over…',
  handedOver: "Codex has stopped, and its work is saved on the task's branch for the other engine to carry on.",
  transferExpired: "The hand-over ran out of time, so Codex didn't start. Nothing was released; try the switch again.",
  checkpointNotSaved: "The task's checkpoint couldn't be saved, so Codex's work wasn't marked as saved. It waits to be saved.",
  switchAbandoned: "The switch didn't go ahead. Codex's work is committed on the task's branch and waits to be saved; open the task again to finish that.",
  otherEditorSaving: "The other editor is saving Codex's work.",
  savedElsewhere: "Codex's work was saved from the other editor.",
  tokenRefused: "RAVIS no longer accepts this editor's key to that Codex task, so it can't be followed from here.",
  tokenMissing: 'Codex is working on this project, but this editor has lost its key to the task.',
  pausedUnanswered: 'Codex waited for an answer, then paused. Nothing ran.',
  pausedForUpdate: 'Codex paused while it waited, because a new version of Codex arrived.',
  fileRules:
    "The rules that keep Codex away from your key files aren't proven for this Codex version, so Codex is paused. Re-test from the menu bar: NERVIS → Codex → Re-test the file rules…",
  malformed: "RAVIS answered in a way this Clarvis doesn't understand. Check that both are up to date.",
  noCredential:
    "To run or follow Codex tasks from this editor, point Clarvis at RAVIS's key once, in the setting Clarvis › Ravis: Credential File.",
  tasksUnreachable: "RAVIS isn't answering; Codex tasks for this project can't be shown yet. I'll look again shortly.",
  noFolder: 'There is no folder open, so there is nothing for Codex to work on.',
} as const;

/** Why RAVIS can't be used from this window, from `relayEndpoint`'s reason. */
export function ravisUnusableLine(reason: string): string {
  return `Clarvis can't use RAVIS from here (${reason.replace(/_/g, ' ')}).`;
}

type AnyFailure = any;

/** The one-sentence reason for each kind; `failureLine` adds what it means for the task. */
const FAILURE_LINES: Record<RelayFailure['kind'], (failure: AnyFailure) => string> = {
  unreachable: () => CODEX_LINES.ravisDownAtStart,
  cancelled: () => CODEX_LINES.stopped,
  throttled: () => 'OpenAI kept refusing Codex for now (too many requests); try again in a little while.',
  quota_exhausted: (failure) => failure.reason || "This ChatGPT plan's allowance is used up.",
  signed_out: (failure) =>
    failure.expired ? 'OpenAI signed Codex out; sign in again on the NERVIS dashboard.' : 'Codex is signed out; sign in on the NERVIS dashboard.',
  untested_version: (failure) =>
    failure.fileRulesUnproven ? CODEX_LINES.fileRules : failure.reason || 'Codex changed and needs re-testing before new work.',
  codex_not_ready: (failure) => notReadyLine(failure.state, failure.reason),
  runtime_unavailable: () => "Codex's process didn't answer RAVIS; try again in a moment.",
  refused: (failure) => refusedLine(failure),
  malformed: () => CODEX_LINES.malformed,
};

/** Codex refusing work, as opposed to RAVIS refusing a request. */
const CODEX_REFUSALS = new Set<RelayFailure['kind']>([
  'throttled',
  'quota_exhausted',
  'signed_out',
  'untested_version',
  'codex_not_ready',
  'runtime_unavailable',
]);

/** What to say when a call to RAVIS failed, before a task started or while one runs. */
export function failureLine(failure: RelayFailure, when: 'start' | 'during'): string {
  if (failure.kind === 'unreachable') return when === 'start' ? CODEX_LINES.ravisDownAtStart : CODEX_LINES.ravisDownMidTurn;
  const line = FAILURE_LINES[failure.kind](failure);
  if (!CODEX_REFUSALS.has(failure.kind)) return line;
  return when === 'start' ? `Codex can't start. ${line}` : `${line} Its work so far is in the project.`;
}

const NOT_READY_LINES = new Map([
  ['account_changed', 'Codex is signed in to a different account than the one you confirmed.'],
  ['runtime_down', "Codex's process is restarting; try again in a moment."],
  ['not_installed', "Codex isn't installed for RAVIS."],
  ['checking', 'RAVIS is still checking Codex; try again in a moment.'],
]);

function notReadyLine(state: string, reason: string): string {
  return NOT_READY_LINES.get(state) ?? (reason || `Codex isn't ready (${state}).`);
}

const REFUSAL_LINES = new Map<string, (failure: AnyFailure) => string>([
  ['PROJECT_LOCKED', (failure) => lockedLine(failure.details)],
  ['NESTED_PROJECT_LOCKED', () => 'A folder inside or around this project is locked by another task.'],
  ['LOCK_SUPERSEDED', () => CODEX_LINES.superseded],
  ['SESSION_STOPPING', () => 'This Codex task is stopping.'],
  ['AGENT_SESSION_NOT_FOUND', () => CODEX_LINES.tokenRefused],
]);

function refusedLine(failure: Extract<RelayFailure, { kind: 'refused' }>): string {
  const line = failure.code === null ? undefined : REFUSAL_LINES.get(failure.code);
  if (line) return line(failure);
  return failure.message || `RAVIS refused that (HTTP ${failure.status}).`;
}

/** Who holds the project, from a `PROJECT_LOCKED` refusal's lock. */
export function lockedLine(details: Record<string, unknown>): string {
  const holder = (details.lock as { holder?: { kind?: unknown } } | undefined)?.holder;
  if (holder?.kind === 'codex_session') return 'Codex is already working on this project.';
  return "Clarvis's own engine is working on this project in another window. Stop it there first.";
}

/** The code of a RAVIS refusal, or null for any other failure. */
export function refusalCode(failure: RelayFailure): string | null {
  return failure.kind === 'refused' ? failure.code : null;
}

/** What steering was refused with means for the text: it is kept either way. */
export function steerRefusedLine(failure: RelayFailure): string {
  return refusalCode(failure) === 'PROJECT_LOCKED' ? CODEX_LINES.lockedForTurns : CODEX_LINES.keptForLater;
}

/** What an answer RAVIS didn't take means, when it means something to the owner. */
export function answerRefusedLine(failure: RelayFailure): string | undefined {
  const code = refusalCode(failure);
  if (code === 'REQUEST_ALREADY_RESOLVED') return 'Answered in the other editor.';
  // Stopping: the stop has already said everything there is to say.
  if (code === 'SESSION_STOPPING') return undefined;
  if (code === 'DECISION_NOT_ALLOWED') return "RAVIS no longer offers that choice for Codex's request.";
  return failure.kind === 'unreachable' ? "RAVIS isn't answering, so that answer didn't reach Codex." : failureLine(failure, 'during');
}

const STOPPED_BY = new Map([
  ['menu_bar', 'Stopped from the menu bar.'],
  ['dashboard', 'Stopped from the dashboard.'],
  ['window', 'Stopped from another editor.'],
]);

/** Where a stop this window didn't press came from (design §5.3). */
export function stoppedByLine(by: unknown): string | undefined {
  return typeof by === 'string' ? STOPPED_BY.get(by) : undefined;
}

const RESOLVED_BY = new Map<string, string>([
  ['window', 'Answered in the other editor.'],
  ['policy_timeout', CODEX_LINES.pausedUnanswered],
  ['policy_secret', "Codex asked for a secret. Clarvis doesn't pass secrets through the chat."],
]);

/** Why a request on screen went away (design §5.2). A stop's own line covers `stop` and `owner_stop`. */
export function resolvedLine(by: unknown): string | undefined {
  return typeof by === 'string' ? RESOLVED_BY.get(by) : undefined;
}

const FEEDBACK_LINES = new Map<string, string>([
  ['steered', CODEX_LINES.passedOn],
  ['queued', CODEX_LINES.queued],
]);

/** What a `feedback` event tells every attached window (design §5.4). */
export function feedbackLine(how: unknown): string | undefined {
  return typeof how === 'string' ? FEEDBACK_LINES.get(how) : undefined;
}

/** What a finished turn says, when it says anything: the step cap, or a failure in RAVIS's words. */
export function turnEndLine(status: unknown, error: unknown): string | undefined {
  const failure = error as { kind?: unknown; message?: unknown } | undefined;
  const message = typeof failure?.message === 'string' ? failure.message : '';
  if (failure?.kind === 'step_cap') return `${message} Codex stopped there; its work so far is kept.`.trim();
  if (status !== 'failed') return undefined;
  return message ? `Codex's turn failed: ${message}` : "Codex's turn failed, and RAVIS didn't say why.";
}

/** Processes a stop could not confirm gone (design §9 "Leftover processes"). */
export function leftoverLine(processes: unknown): string {
  const leftover = (processes as { leftover?: { pid?: unknown; comm?: unknown }[] } | undefined)?.leftover ?? [];
  const named = leftover.map((process) => `\`${String(process.comm)}\` (pid ${String(process.pid)})`).join(', ');
  const what = named ? `Something Codex started is still running: ${named}.` : 'Something Codex started is still running.';
  return `${what} Nothing is saved until it stops.`;
}

const SETTLE_STATE_LINES = new Map<string, string>([
  ['uncertain', CODEX_LINES.uncertain],
  ['paused_unanswered', CODEX_LINES.pausedUnanswered],
  ['paused_for_update', CODEX_LINES.pausedForUpdate],
]);

/** What a state that needs its work saved says first, when it isn't simply the end of a turn. */
export function settleStateLine(state: string): string | undefined {
  return SETTLE_STATE_LINES.get(state);
}

/**
 * Until approvals arrive (C2b), a request is declined where RAVIS allows declining, and said so. A
 * question can't be declined, so it stays open: the task waits, and Stop still ends it.
 */
export function declinedLine(request: RequestView): string {
  const pending = 'answering Codex from the chat comes with the approvals step';
  if (request.kind === 'question') return `Codex asked a question (${questionHeader(request)}). It waits: ${pending}. Stop ends the task.`;
  return `Codex asked to ${requestedAction(request)}. I declined: ${pending}.`;
}

/** An open request as a checkpoint lists it when a switch let it go unanswered (C3). */
export function requestSummary(request: RequestView): string {
  if (request.kind === 'question') return `Codex asked a question (${questionHeader(request)})`;
  return `Codex asked to ${requestedAction(request)}`;
}

/** Why Codex didn't take a task over: a transfer token that ran out is said plainly, anything else as at a start. */
export function switchStartLine(failure: RelayFailure): string {
  return refusalCode(failure) === 'LOCK_TRANSFER_INVALID' ? CODEX_LINES.transferExpired : failureLine(failure, 'start');
}

function requestedAction(request: RequestView): string {
  const payload = request.payload;
  if (request.kind === 'command') return `run \`${String(payload.command ?? 'a command')}\``;
  if (request.kind === 'fileChange') return `change ${Array.isArray(payload.files) ? payload.files.length : 'some'} file(s)`;
  return 'have more access';
}

function questionHeader(request: RequestView): string {
  const questions = request.payload.questions;
  const first = Array.isArray(questions) ? (questions[0] as { header?: unknown } | undefined) : undefined;
  return typeof first?.header === 'string' ? `"${first.header}"` : 'no title';
}

/** Said when a window picks a task back up (design §5.7 step 4). */
export function reattachedLine(summary: SessionSummary): string {
  const waiting = summary.waiting_on_you ? '; a question is waiting' : '';
  return `Codex is still working on this project (started ${clockTime(summary.created_at)}${waiting}). Reconnected.`;
}

/** Said when a token file couldn't be used to follow a task. */
export function tokenLine(read: Exclude<TokenRead, { kind: 'found' }>): string {
  if (read.kind === 'missing') return CODEX_LINES.tokenMissing;
  return `The file holding this editor's key to the Codex task isn't safe to use (${read.reason}), so it was left alone.`;
}

/** `HH:MM` in this Mac's time zone, or the text as it came when it isn't a time. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
