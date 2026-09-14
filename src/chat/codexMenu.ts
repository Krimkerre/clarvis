/**
 * The Codex section of the bowtie's fold-out, decided (plan.md M15, C2b+; the owner's decisions of 14 September 2026).
 *
 * **What it shows.** Under **API config**, a section for Codex: the models RAVIS lists (`GET /api/v1/codex` →
 * `models`) with the default one marked, the chosen model's efforts with its default marked, the note that a bigger
 * model or higher effort uses the ChatGPT plan's allowance faster, and one compact line of that allowance — the
 * tightest window's percentage left and when it resets, in this Mac's time, with every window and when it was read
 * in the tooltip, like NERVIS's Codex tile.
 *
 * **When it can't.** The controls apply only to Codex, so with another coding model they are drawn disabled, with one
 * short line pointing at API config; the allowance still shows, because it's the owner's plan either way. A window
 * that doesn't use RAVIS, or has no key for it, says so. RAVIS not answering is said, never shown as an empty list.
 *
 * **Read when the menu opens**, once; nothing is polled while it's closed. Everything RAVIS sends is passed on as
 * text: `media/bowtieMenu.js` sets it with `textContent` and `title`, never as markup.
 *
 * vscode-free: `codexMenuHost.ts` reads the settings and RAVIS, and posts the result.
 */

import { CODEX_CHOICE_LINES, effectiveCodexChoice, type StoredCodexChoice } from '../engine/codexChoice';
import { CODEX_LINES, ravisUnusableLine } from '../engine/codex/translate';
import { CODEX_MODEL_ID } from '../engine/engineChoice';
import type { RelayOutcome } from '../engine/relay/relayFailure';
import type { CodexModel, CodexState, CodexUsage, CodexUsageWindow } from '../engine/relay/relayTypes';

/** What this window knows of RAVIS when the menu opens. */
export type RavisReach =
  | { kind: 'ready'; state: RelayOutcome<CodexState> }
  | { kind: 'not_used' }
  | { kind: 'no_credential' }
  | { kind: 'unusable'; reason: string };

export interface CodexMenuInputs {
  /** The coding model in effect. */
  codingModel: string;
  ravis: RavisReach;
  stored: StoredCodexChoice;
  /** A Codex task is running in this window. */
  taskRunning: boolean;
  /** This Mac's time zone, unless a test names one. */
  timeZone?: string;
}

export interface CodexMenuModel {
  id: string;
  label: string;
  isDefault: boolean;
  efforts: { id: string; isDefault: boolean }[];
}

/** What `media/bowtieMenu.js` draws (`codex-menu`). */
export interface CodexMenuState {
  /** The controls may be used: the coding model is Codex. */
  enabled: boolean;
  /** One short line, when the controls are off or can't be filled. */
  line?: string;
  models: CodexMenuModel[];
  /** The model and effort a new task would use. */
  chosen?: { model: string; effort: string };
  note: string;
  running?: string;
  allowance?: { line: string; tooltip: string };
}

export const CODEX_MENU_LINES = {
  onlyForCodex: 'These apply only to Codex: choose ravis/clarvis-codex under API config.',
  ravisDown: "RAVIS isn't answering, so Codex's models and allowance can't be shown right now.",
  malformed: "RAVIS answered in a way this Clarvis doesn't understand, so Codex's models can't be shown.",
  noModels: 'Codex lists no models right now.',
} as const;

/** The Codex section for what the settings and RAVIS say right now. */
export function codexMenuState(inputs: CodexMenuInputs): CodexMenuState {
  const enabled = inputs.codingModel.trim() === CODEX_MODEL_ID;
  const note = CODEX_CHOICE_LINES.allowance;
  const running = inputs.taskRunning ? CODEX_CHOICE_LINES.running : undefined;
  const reached = reach(inputs.ravis);
  if ('line' in reached) return { enabled, ...unreached(enabled, reached.line, inputs.ravis.kind), models: [], note, running };
  const models = reached.state.models ?? [];
  const chosen = effectiveCodexChoice(models, inputs.stored);
  return {
    enabled,
    line: sectionLine(enabled, models, reached.state.reason),
    models: models.map(menuModel),
    chosen: chosen && { model: chosen.model.id, effort: chosen.effort },
    note,
    running,
    allowance: allowanceView(reached.state.usage, inputs.timeZone),
  };
}

/** RAVIS's state, or the line that stands in for it. */
function reach(ravis: RavisReach): { state: CodexState } | { line: string } {
  if (ravis.kind === 'not_used') return { line: CODEX_MENU_LINES.onlyForCodex };
  if (ravis.kind === 'no_credential') return { line: CODEX_LINES.noCredential };
  if (ravis.kind === 'unusable') return { line: ravisUnusableLine(ravis.reason) };
  if (ravis.state.ok) return { state: ravis.state.value };
  return { line: ravis.state.failure.kind === 'malformed' ? CODEX_MENU_LINES.malformed : CODEX_MENU_LINES.ravisDown };
}

/**
 * Without RAVIS's state: the reason, once. With Codex the coding engine it stands for both the list and the allowance;
 * otherwise the controls say they are Codex's and the reason takes the allowance's place, since that line shows either
 * way — except in a window that doesn't use RAVIS at all, which has no allowance to speak of.
 */
function unreached(enabled: boolean, line: string, kind: RavisReach['kind']): Pick<CodexMenuState, 'line' | 'allowance'> {
  if (enabled) return { line };
  return { line: CODEX_MENU_LINES.onlyForCodex, allowance: kind === 'not_used' ? undefined : { line, tooltip: '' } };
}

function sectionLine(enabled: boolean, models: CodexModel[], reason: string): string | undefined {
  if (!enabled) return CODEX_MENU_LINES.onlyForCodex;
  if (models.length === 0) return reason ? `${CODEX_MENU_LINES.noModels} ${reason}` : CODEX_MENU_LINES.noModels;
  return undefined;
}

function menuModel(model: CodexModel): CodexMenuModel {
  return {
    id: model.id,
    label: model.display_name || model.id,
    isDefault: model.is_default,
    efforts: model.efforts.map((effort) => ({ id: effort, isDefault: effort === model.default_effort })),
  };
}

// ── The allowance ────────────────────────────────────────────────────────────

/**
 * The allowance's one line and its tooltip: the tightest window's percentage left and its reset — "used up" once any
 * limit is reached, the contract's words — or "not known right now"; a stale reading keeps its figure, marked old.
 */
export function allowanceView(usage: CodexUsage | undefined, timeZone?: string): { line: string; tooltip: string } | undefined {
  if (!usage) return undefined;
  const windows = Array.isArray(usage.windows) ? usage.windows.filter(isWindow) : [];
  const tooltip = allowanceTooltip(usage, windows, timeZone);
  const tightest = tightestWindow(windows);
  if (limitReached(usage) || (tightest && tightest.remaining_percent <= 0)) return { line: `Allowance: used up${resets(tightest, timeZone)}`, tooltip };
  if (!usage.known || !tightest) return { line: 'Allowance: not known right now', tooltip };
  const old = usage.stale ? ' (an old reading)' : '';
  return { line: `Allowance: ${tightest.remaining_percent}% left${old}${resets(tightest, timeZone)}`, tooltip };
}

function limitReached(usage: CodexUsage): boolean {
  return (usage.limit_reached !== null && usage.limit_reached !== undefined && usage.limit_reached !== false) || usage.spend_control_reached === true;
}

/** The window with the least left; on a tie, the one that resets first. */
function tightestWindow(windows: CodexUsageWindow[]): CodexUsageWindow | undefined {
  return [...windows].sort((a, b) => a.remaining_percent - b.remaining_percent || Date.parse(a.resets_at) - Date.parse(b.resets_at))[0];
}

function allowanceTooltip(usage: CodexUsage, windows: CodexUsageWindow[], timeZone?: string): string {
  const lines = windows.map((window) => `${window.label}: ${window.used_percent}% used, ${window.remaining_percent}% left${resets(window, timeZone, ', ')}`);
  if (!usage.known) lines.push("RAVIS hasn't had a reading from Codex yet.");
  if (usage.stale) lines.push("This reading is old: Codex hasn't reported for a while.");
  if (limitReached(usage)) lines.push("The ChatGPT plan's allowance is used up.");
  if (usage.observed_at) lines.push(`Read ${clock(usage.observed_at, timeZone)}`);
  return lines.join('\n');
}

function resets(window: CodexUsageWindow | undefined, timeZone?: string, separator = ' · '): string {
  return window && !Number.isNaN(Date.parse(window.resets_at)) ? `${separator}resets ${clock(window.resets_at, timeZone)}` : '';
}

/** "Fri 00:43", in this Mac's time zone: a reset within the week is told apart by its day. */
export function clock(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(date);
}

function isWindow(value: unknown): value is CodexUsageWindow {
  const window = value as Partial<CodexUsageWindow> | null;
  return typeof window?.label === 'string' && typeof window.remaining_percent === 'number' && typeof window.used_percent === 'number';
}
