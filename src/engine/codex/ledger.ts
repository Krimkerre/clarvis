/**
 * What Codex did, written down once per thing it did (plan.md M15, C2a; design §5.5).
 *
 * **What arrives.** RAVIS relays each finished piece of a Codex turn as `item.completed`, with the item
 * normalised to one of three shapes (`event-stream.json` normalised_items): a message Codex wrote, a
 * command it ran, or files it changed.
 *
 * **What the rest of Clarvis needs from them**, in the shapes Clarvis's own engine already produces:
 * - one `text` event per message, whole — so a `STEP:` line in it moves the progress bar exactly as it
 *   does for Clarvis's engine (`RunSession.takeStepMarkers`), and the milestone is ticked from it;
 * - one `tool` event per command, with the detail `runCommand: <command> → exit <code>`;
 * - one `tool` event per changed file, with the detail the run ledger reads (`runLedger.ts`):
 *   `writeFile: path` for an added file, `deleteFile: path` for a deleted one, `applyEdit: path` for an
 *   update or a rename — and the path added to the files the review and the settle commit cover.
 *
 * **Recorded, never done again.** Codex has already made these changes in the project. Nothing here
 * edits a file or runs a command; the ledger only remembers. And the same item can arrive twice — a
 * reconnect that overlaps, a replay after an expired cursor, RAVIS re-sending after a restart — so each
 * is keyed, messages and commands by item id and file changes by item id and path, and a second arrival
 * adds nothing: no second chat line, no second entry in the run record.
 *
 * Pure.
 */

import type { AgentEvent } from '../../agent/AgentRunner';

export interface ChangedFile {
  path: string;
  change: string;
  moved_to?: string;
}

export interface CheckRun {
  command: string;
  exitCode: number | null;
  outputTail: string;
}

type Item =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'commandExecution'; id: string; command: string; exit_code: number | null; output_tail: string }
  | { type: 'fileChange'; id: string; status: string; changes: ChangedFile[] };

/** The run-ledger tool each kind of change is recorded as. */
const TOOL_FOR_CHANGE = new Map([
  ['add', 'writeFile'],
  ['delete', 'deleteFile'],
  ['update', 'applyEdit'],
  ['rename', 'applyEdit'],
]);

const VERB_FOR_CHANGE = new Map([
  ['add', 'added'],
  ['delete', 'deleted'],
]);

export class CodexLedger {
  /** Every command Codex ran and how it ended, for the "checks Codex ran" lines. */
  readonly checks: CheckRun[] = [];
  private readonly seen = new Set<string>();
  private readonly changed: string[] = [];
  private lastText = '';

  /** Every path Codex changed, in the order it changed them, each once. */
  get files(): string[] {
    return [...this.changed];
  }

  /** The last thing Codex wrote: its closing summary, when the turn is over. */
  get lastMessage(): string {
    return this.lastText;
  }

  /** The events a completed item adds. None for one already recorded, or one this doesn't recognise. */
  record(value: unknown): AgentEvent[] {
    const item = readItem(value);
    if (!item) return [];
    if (item.type === 'agentMessage') return this.message(item);
    if (item.type === 'commandExecution') return this.command(item);
    return this.fileChange(item);
  }

  private message(item: Extract<Item, { type: 'agentMessage' }>): AgentEvent[] {
    if (!this.first(`message\0${item.id}`) || item.text.trim() === '') return [];
    this.lastText = item.text;
    // Whole lines, so a message ending mid-line doesn't run into the next one in the terminal.
    return [{ kind: 'text', text: item.text.endsWith('\n') ? item.text : `${item.text}\n` }];
  }

  private command(item: Extract<Item, { type: 'commandExecution' }>): AgentEvent[] {
    if (!this.first(`command\0${item.id}`)) return [];
    this.checks.push({ command: item.command, exitCode: item.exit_code, outputTail: item.output_tail });
    const exit = item.exit_code === null ? 'unknown' : String(item.exit_code);
    return [{ kind: 'tool', text: `Codex ran ${item.command}`, detail: `runCommand: ${item.command} → exit ${exit}` }];
  }

  private fileChange(item: Extract<Item, { type: 'fileChange' }>): AgentEvent[] {
    // Only a change that happened. The fixtures show `completed`; anything else was not applied.
    if (item.status !== 'completed') return [];
    return item.changes.flatMap((change) => this.change(item.id, change));
  }

  private change(itemId: string, change: ChangedFile): AgentEvent[] {
    if (!this.first(`file\0${itemId}\0${change.path}`)) return [];
    const path = change.moved_to ?? change.path;
    // A rename changes two paths, and a commit of it needs both.
    for (const touched of [change.path, change.moved_to]) this.note(touched);
    const tool = TOOL_FOR_CHANGE.get(change.change) ?? 'applyEdit';
    const verb = VERB_FOR_CHANGE.get(change.change) ?? 'changed';
    return [{ kind: 'tool', text: `Codex ${verb} ${path}`, detail: `${tool}: ${path}`, toChat: true }];
  }

  private note(path: string | undefined): void {
    if (path && !this.changed.includes(path)) this.changed.push(path);
  }

  /** True the first time a key is seen. */
  private first(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

function readItem(value: unknown): Item | undefined {
  const item = value as Partial<Record<string, unknown>> | null;
  if (!item || typeof item.id !== 'string') return undefined;
  if (item.type === 'agentMessage') return typeof item.text === 'string' ? (item as Item) : undefined;
  if (item.type === 'commandExecution') return readCommand(item);
  if (item.type === 'fileChange') return readFileChange(item);
  return undefined;
}

function readCommand(item: Partial<Record<string, unknown>>): Item | undefined {
  if (typeof item.command !== 'string') return undefined;
  const exit = typeof item.exit_code === 'number' ? item.exit_code : null;
  const tail = typeof item.output_tail === 'string' ? item.output_tail : '';
  return { type: 'commandExecution', id: item.id as string, command: item.command, exit_code: exit, output_tail: tail };
}

function readFileChange(item: Partial<Record<string, unknown>>): Item | undefined {
  if (typeof item.status !== 'string' || !Array.isArray(item.changes)) return undefined;
  const changes = item.changes.filter(isChangedFile);
  return { type: 'fileChange', id: item.id as string, status: item.status, changes };
}

function isChangedFile(value: unknown): value is ChangedFile {
  const change = value as Partial<ChangedFile> | null;
  return Boolean(change) && typeof change?.path === 'string' && typeof change.change === 'string';
}
