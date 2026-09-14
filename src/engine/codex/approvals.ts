/**
 * Codex's requests, asked in the chat and answered to RAVIS (plan.md M15, C2b; design §5.2; `CLARVIS.md` §5.5).
 *
 * **What arrives.** While a Codex task runs, Codex asks before it runs a command or changes files (in the modes
 * that ask), asks for more access, or asks a question; and RAVIS asks about a site Codex's commands were blocked
 * from. Each comes as a `RequestView` with **RAVIS's `allowed_decisions`**: RAVIS computes them and refuses any
 * other answer, so no window can grant more than RAVIS offers. This module turns each request into a line, the
 * detail under it and buttons — only for the decisions RAVIS allows — and sends back what the owner chose.
 *
 * **The guards, each with a test that fails without it** (`approvals.test.ts`, `runCore.test.ts`):
 * - **One at a time, in order.** Codex can open several requests at once; they are asked in the order RAVIS
 *   opened them, a site ask behind Codex's own (`questions.ts`), the next only once the one on screen is answered.
 * - **Re-evaluated right before the POST** (review M3). After any wait — the owner thinking, the files being
 *   copied for undo — the answer is checked again: a Stop from anywhere, RAVIS stopping the task, or another
 *   window answering first means nothing is sent (`engineDecisionAfterAsking`).
 * - **Only RAVIS's decisions, and never "don't ask again"** (review AH3). Codex's session-wide approval outlives
 *   the step inside RAVIS's long-lived process — calibration's K11 measured a "for the session" approval
 *   surviving a steer and a new turn — so RAVIS never offers one and no label here suggests one.
 * - **Answer errors** (`CLARVIS.md` §5.5): `REQUEST_ALREADY_RESOLVED` clears the question and says who answered;
 *   `SESSION_STOPPING` clears it silently; `DECISION_NOT_ALLOWED` draws it again from the list RAVIS returns;
 *   `SITE_NOT_ADDED` says the site stays blocked and asks again, because RAVIS keeps that ask open; an answer that
 *   never reached RAVIS is asked again once RAVIS is back.
 * - **Unattended answers on its own only the narrowest things, and only while this window's panel is there.** A
 *   command with no gate category, no network and no escalation, or a file change wholly inside the project, when
 *   RAVIS offers `once`. Everything else asks; with no panel attached nothing is answered here, and RAVIS never
 *   approves anything itself. **Shell wrappers are unwrapped first**: calibration showed Codex sends commands as
 *   `/bin/zsh -lc "printf 'k2\n' > …"`, and the gate's disk-tool rule matches only where a shell would run the
 *   tool — at the start of a segment — so `dd` inside the quotes would otherwise pass as having no category.
 * - **Typed words that aren't an answer go to Codex.** While a command waits, "use yarn instead" is steered into
 *   Codex's turn and the question stays on screen; a question that takes typed answers takes them as its answer.
 * - **"Stop the run" is Stop.** It stops the task the way the Stop button does — every question let go first,
 *   then RAVIS told — rather than posting a `stop` answer, so a stop reads and settles the same from either.
 * - **Copied before it changes.** Before a file change is approved, each file it touches is copied for
 *   **Clarvis: Undo Last Agent Run** (design §5.2), and only then is the answer checked again and sent.
 *
 * vscode-free: the chat's buttons, the relay and the undo copies are handed in (`ApprovalPorts`).
 */

import { approveLabel, classifyCommand, type GateVerdict } from '../../agent/Gate';
import { engineDecisionAfterAsking } from '../../chat/stopDecision';
import type { RelayFailure, RelayOutcome } from '../relay/relayFailure';
import type { Decision, DecisionKind, RequestKind, RequestView, SessionMode } from '../relay/relayTypes';
import { QuestionBoard, type Asking } from './questions';
import { SiteGroupCard, siteAskFrom } from './siteAsks';
import { answerRefusedLine, CODEX_LINES, refusalCode, resolvedLine, siteAllowedLine, siteNotAddedLine } from './translate';

/** A button, and the decision it sends. */
export interface PromptOption {
  label: string;
  detail?: string;
  decision: Decision;
}

/** One request as the chat asks it. A question request with several questions is asked one question at a time. */
export interface RequestPrompt {
  requestId: string;
  /** What the chat says first. */
  line: string;
  /** The lines under it: the command, the files, the reason, the risk. */
  detail: string[];
  /** Only the decisions RAVIS allows. */
  options: PromptOption[];
  /** The question id typed words answer, for a question that takes them. */
  typedAnswer?: string;
  /** A few words for a spoken reminder, when nobody answers. */
  about: string;
}

/**
 * Puts a prompt to the owner and comes back with what they chose — a button's label — or typed words, or nothing
 * when the prompt was taken away. `again` is true when the same prompt is shown again after typed words that
 * weren't an answer, so the chat offers its buttons without repeating its line. `signal` aborts when the request
 * no longer wants an answer.
 */
export type PromptShower = (prompt: RequestPrompt, signal: AbortSignal, again: boolean) => Promise<string | undefined>;

/** What a reply is: a decision, or words for Codex that weren't one. */
export type ReplyReading = { decision: Decision } | { typed: string } | undefined;

/** What the auto-answer looks at. */
export interface AutoContext {
  mode: SessionMode;
  /** This window's chat panel is there: its pings are fresh (`presence.ts`). */
  attached: boolean;
}

export interface ApprovalPorts {
  /** Posts the answer. The relay keys it `<request id>:<window id>`, so a second window never collides with the first. */
  answer(requestId: string, decision: Decision): Promise<RelayOutcome<unknown>>;
  show: PromptShower;
  /** Typed words for Codex, steered into its turn or kept for the next one. */
  steer(text: string): void;
  /** The task's own Stop. */
  stopRun(): void;
  /** Stop pressed here, RAVIS stopping the task, a switch under way, or the run over. */
  stopping(): boolean;
  /** The chat's mode as it is now: a switch to Unattended counts from the question on screen. */
  mode(): SessionMode;
  attached(): boolean;
  /** Copies project files, by relative path, for undo before Codex changes them. */
  capture?(paths: string[]): Promise<void>;
  say(line: string): void;
  log(line: string): void;
}

/** How deep shell wrappers are unwrapped: `sh -c "bash -c '…'"` is two. */
const MAX_WRAPPERS = 4;

const ONCE: Decision = { kind: 'once' };

// ── Rendering ────────────────────────────────────────────────────────────────

type Offer = [DecisionKind, string];

/** The prompts a request is asked with: one, or one per question. Empty when there is nothing this Clarvis can ask. */
export function promptsFor(request: RequestView): RequestPrompt[] {
  const render = RENDERERS[request.kind];
  return render ? render(request) : [];
}

const RENDERERS: Partial<Record<RequestKind, (request: RequestView) => RequestPrompt[]>> = {
  command: (request) => [commandPrompt(request)],
  fileChange: (request) => [fileChangePrompt(request)],
  permissions: (request) => [permissionsPrompt(request)],
  question: questionPrompts,
  site: sitePrompts,
};

function commandPrompt(request: RequestView): RequestPrompt {
  const payload = request.payload;
  const command = text(payload.command);
  const shown = shownCommand(command);
  const verdict = gateVerdictFor(command);
  return {
    requestId: request.id,
    line: 'Codex wants to run a command.',
    detail: [
      `\`${shown}\`${placeOf(payload.cwd)}`,
      ...reasonLines(payload.reason),
      ...gateLines(verdict),
      ...networkLines(payload.network),
      ...escalationLines(payload.escalation),
    ],
    options: offered(request, [
      ['once', verdict ? approveLabel(verdict) : 'Run it'],
      ['skip', 'Skip it'],
      ['stop', 'Stop the run'],
    ]),
    about: "Codex's command",
  };
}

function fileChangePrompt(request: RequestView): RequestPrompt {
  const files = fileEntries(request.payload.files);
  const outside = strings(request.payload.outside_workspace);
  return {
    requestId: request.id,
    line: fileChangeLine(files.length, outside),
    detail: [...files.map(fileLine), ...reasonLines(request.payload.reason)],
    options: offered(request, [
      ['once', 'Apply'],
      ['skip', "Don't apply"],
      ['stop', 'Stop the run'],
    ]),
    about: "Codex's file change",
  };
}

function fileChangeLine(count: number, outside: string[]): string {
  if (outside.length > 0) return `Codex wants to write outside this project (${outside.join(', ')}). Clarvis never lets an engine do that.`;
  if (count === 0) return "Codex wants to change files, and didn't say which.";
  return `Codex wants to change ${count} file${count === 1 ? '' : 's'}.`;
}

function permissionsPrompt(request: RequestView): RequestPrompt {
  const payload = request.payload;
  const marks = { outside: strings(payload.outside_workspace), denied: strings(payload.denied) };
  return {
    requestId: request.id,
    line: 'Codex asks for more access.',
    detail: [
      ...accessLines('read', strings(payload.read), marks),
      ...accessLines('write', strings(payload.write), marks),
      ...(payload.network === true ? ['internet: on'] : []),
      ...reasonLines(payload.reason),
    ],
    options: offered(request, [
      ['once', 'Allow for this step'],
      ['skip', "Don't allow"],
      ['stop', 'Stop the run'],
    ]),
    about: "Codex's request for access",
  };
}

interface QuestionShape {
  id: string;
  header: string;
  question: string;
  options: string[];
  allowOther: boolean;
}

function questionPrompts(request: RequestView): RequestPrompt[] {
  const answering = request.allowed_decisions.includes('answer');
  return questionsOf(request.payload.questions).map((question) => ({
    requestId: request.id,
    line: question.header ? `Codex asks: ${question.header}` : 'Codex has a question.',
    detail: question.question ? [question.question] : [],
    options: [
      ...(answering ? question.options.map((label) => ({ label, decision: answerWith(question.id, label) })) : []),
      ...offered(request, [['stop', 'Stop the run']]),
    ],
    typedAnswer: answering && question.allowOther ? question.id : undefined,
    about: question.header ? `Codex's question, ${question.header}` : "Codex's question",
  }));
}

/** A site ask, as a card of one host (`siteAsks.ts`). RAVIS's grouped asks draw the same card with more hosts. */
function sitePrompts(request: RequestView): RequestPrompt[] {
  const ask = siteAskFrom(request);
  if (!ask) return [];
  const card = new SiteGroupCard([ask]).view();
  const options = card.options
    .map((option) => ({ label: option.label, detail: option.detail, decision: { kind: option.decides[0].decision } as Decision }))
    .filter((option) => request.allowed_decisions.includes(option.decision.kind));
  return [{ requestId: request.id, line: card.line, detail: card.detail, options, about: card.about }];
}

/** Buttons for the decisions RAVIS allows, in the order the design lists them. */
function offered(request: RequestView, offers: Offer[]): PromptOption[] {
  return offers.filter(([kind]) => request.allowed_decisions.includes(kind)).map(([kind, label]) => ({ label, decision: { kind } }));
}

function answerWith(questionId: string, answer: string): Decision {
  return { kind: 'answer', answers: { [questionId]: answer } };
}

function placeOf(cwd: unknown): string {
  const folder = text(cwd);
  return folder === '' || folder === '.' ? '' : ` in \`${folder.startsWith('/') ? folder : `./${folder}`}\``;
}

function reasonLines(reason: unknown): string[] {
  const said = text(reason).trim();
  return said ? [`Why: ${said}`] : [];
}

/** The gate's explanation, for a command it would stop in Clarvis's own engine (design §5.2). */
function gateLines(verdict: GateVerdict | undefined): string[] {
  if (!verdict) return [];
  return [
    ...(verdict.reversible ? [] : ['CANNOT BE UNDONE.']),
    `What it does: ${verdict.what}`,
    `Why I'm asking: ${verdict.why}`,
    `Worst case: ${verdict.worstCase}`,
  ];
}

function networkLines(network: unknown): string[] {
  const { host, protocol } = (network ?? {}) as { host?: unknown; protocol?: unknown };
  if (typeof host !== 'string') return [];
  return [`…and it needs the internet for this command: ${host}${typeof protocol === 'string' ? ` (${protocol})` : ''}`];
}

/** Codex's extra permissions for one command, in plain words. */
function escalationLines(escalation: unknown): string[] {
  if (escalation === null || escalation === undefined) return [];
  const asked = escalation as { fileSystem?: { read?: unknown; write?: unknown }; network?: { enabled?: unknown } };
  const parts = [
    ...listPart('write', strings(asked.fileSystem?.write)),
    ...listPart('read', strings(asked.fileSystem?.read)),
    ...(asked.network?.enabled === true ? ['the internet'] : []),
  ];
  return [`…and it asks to step outside Codex's safety box${parts.length > 0 ? `: ${parts.join('; ')}` : ''}`];
}

function listPart(verb: string, paths: string[]): string[] {
  return paths.length > 0 ? [`${verb} ${paths.join(', ')}`] : [];
}

function accessLines(verb: string, paths: string[], marks: { outside: string[]; denied: string[] }): string[] {
  if (paths.length === 0) return [];
  return [`${verb}: ${paths.map((path) => `${path}${pathMarks(path, marks)}`).join(', ')}`];
}

function pathMarks(path: string, marks: { outside: string[]; denied: string[] }): string {
  const said = [...(marks.outside.includes(path) ? ['outside this project'] : []), ...(marks.denied.includes(path) ? ['denied'] : [])];
  return said.length > 0 ? ` (${said.join(', ')})` : '';
}

interface FileEntry {
  path: string;
  change: string;
  movedTo?: string;
  added: number;
  removed: number;
}

function fileEntries(files: unknown): FileEntry[] {
  if (!Array.isArray(files)) return [];
  return files.map((file) => {
    const entry = (file ?? {}) as Record<string, unknown>;
    const movedTo = typeof entry.moved_to === 'string' ? entry.moved_to : undefined;
    return { path: text(entry.path), change: text(entry.change) || 'update', movedTo, added: count(entry.added), removed: count(entry.removed) };
  });
}

/** `update src/app.ts (+12 −3)`, `rename a → b`. */
function fileLine(file: FileEntry): string {
  const moved = file.movedTo ? ` → ${file.movedTo}` : '';
  const counts = file.added > 0 || file.removed > 0 ? ` (+${file.added} −${file.removed})` : '';
  return `${file.change} ${file.path}${moved}${counts}`;
}

function questionsOf(questions: unknown): QuestionShape[] {
  if (!Array.isArray(questions)) return [];
  return questions.map((entry) => {
    const question = (entry ?? {}) as Record<string, unknown>;
    return {
      id: text(question.id),
      header: text(question.header),
      question: text(question.question),
      options: strings(question.options),
      allowOther: question.allow_other === true,
    };
  });
}

// ── Reading a reply ──────────────────────────────────────────────────────────

/** What the owner's reply decides: a button by its label or number, typed words a question takes, or neither. */
export function readReply(prompt: RequestPrompt, reply: string | undefined): ReplyReading {
  if (reply === undefined) return undefined;
  const said = reply.trim();
  const option = matchingOption(prompt.options, said);
  if (option) return { decision: option.decision };
  if (said === '') return undefined;
  return prompt.typedAnswer !== undefined ? { decision: answerWith(prompt.typedAnswer, said) } : { typed: said };
}

function matchingOption(options: PromptOption[], said: string): PromptOption | undefined {
  const byNumber = /^\d+$/.test(said) ? options[Number(said) - 1] : undefined;
  return byNumber ?? options.find((option) => option.label.toLowerCase() === said.toLowerCase());
}

// ── Unattended ───────────────────────────────────────────────────────────────

/**
 * Unattended's own answer, or undefined when the owner must be asked (design §5.2): `once`, only in Unattended,
 * only while this window's panel is there, only when RAVIS offers it, and only for a quiet command or a change
 * wholly inside the project.
 */
export function autoAnswer(request: RequestView, context: AutoContext): Decision | undefined {
  if (context.mode !== 'unattended' || !context.attached) return undefined;
  if (!request.allowed_decisions.includes('once')) return undefined;
  const quiet = QUIET[request.kind];
  return quiet?.(request.payload) ? ONCE : undefined;
}

const QUIET: Partial<Record<RequestKind, (payload: Record<string, unknown>) => boolean>> = {
  command: quietCommand,
  fileChange: changeInsideProject,
};

/** A command with no gate category — its shell wrappers unwrapped — no network, no escalation, run in the project. */
function quietCommand(payload: Record<string, unknown>): boolean {
  const command = text(payload.command).trim();
  if (command === '' || !insideProject(payload.cwd ?? '.')) return false;
  if (isSet(payload.network) || isSet(payload.escalation) || isSet(payload.gate_hint)) return false;
  return gateVerdictFor(command) === undefined;
}

/** Files named, every one of them — and where each moves to — inside the project, and nothing listed outside. */
function changeInsideProject(payload: Record<string, unknown>): boolean {
  const files = Array.isArray(payload.files) ? (payload.files as Record<string, unknown>[]) : [];
  const outside = Array.isArray(payload.outside_workspace) ? payload.outside_workspace : [undefined];
  if (files.length === 0 || outside.length > 0 || isSet(payload.grant_root)) return false;
  return files.every((file) => insideProject(file?.path) && (file.moved_to === undefined || insideProject(file.moved_to)));
}

/** A relative path that never climbs above the project root. RAVIS sends outside paths absolute. */
export function insideProject(path: unknown): boolean {
  if (typeof path !== 'string' || path === '' || /^([/\\~]|[A-Za-z]:)/.test(path)) return false;
  let depth = 0;
  for (const segment of path.split(/[/\\]/)) {
    depth += segmentStep(segment);
    if (depth < 0) return false;
  }
  return true;
}

/** How far a path segment moves from the root: up, nowhere, or down. */
function segmentStep(segment: string): number {
  if (segment === '..') return -1;
  return segment === '' || segment === '.' ? 0 : 1;
}

/** The gate's verdict on a command and on every script its shell wrappers hand on; the first one found. */
export function gateVerdictFor(command: string): GateVerdict | undefined {
  for (const layer of commandLayers(command)) {
    const verdict = classifyCommand(layer);
    if (verdict) return verdict;
  }
  return undefined;
}

/**
 * The command, then each script a shell wrapper runs: `/bin/zsh -lc "npm test && rm -rf build"` gives the whole line
 * and `npm test && rm -rf build`. A wrapper whose quoting can't be read gives the rest of the line as it is, so the
 * gate still sees every word of it.
 */
export function commandLayers(command: string): string[] {
  const layers = [command];
  for (let depth = 0; depth < MAX_WRAPPERS; depth++) {
    const inner = unwrapShell(layers[layers.length - 1]);
    if (inner === undefined || layers.includes(inner.script)) break;
    layers.push(inner.script);
  }
  return layers;
}

/** What the chat shows: the script inside a plain shell wrapper, or the command as it came when anything else is on the line. */
export function shownCommand(command: string): string {
  let shown = command;
  for (let depth = 0; depth < MAX_WRAPPERS; depth++) {
    const inner = unwrapShell(shown);
    if (!inner?.whole) break;
    shown = inner.script;
  }
  return shown;
}

const SHELL = /^\s*(?:(?:\S*\/)?env\s+)?(?:\S*\/)?(?:ba|z|da|k|fi)?sh\s+/;

/** The script a `sh`/`bash`/`zsh -c` wrapper runs, and whether that is the whole line. */
export function unwrapShell(command: string): { script: string; whole: boolean } | undefined {
  const shell = SHELL.exec(command);
  if (!shell) return undefined;
  let rest = command.slice(shell[0].length);
  for (let flags = 0; flags < 8; flags++) {
    const flag = /^(--?[A-Za-z][\w-]*)\s+/.exec(rest);
    if (!flag) return undefined;
    rest = rest.slice(flag[0].length);
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(flag[1])) return scriptWord(rest);
  }
  return undefined;
}

/**
 * One shell word: quoted parts joined, backslashes undone as the shell undoes them. A quote that never closes gives
 * the rest of the line without that quote, so a disk tool right after it still starts its segment for the gate.
 */
function scriptWord(text: string): { script: string; whole: boolean } {
  let script = '';
  let at = 0;
  while (at < text.length && !/\s/.test(text[at])) {
    const part = wordPart(text, at);
    if (!part) return { script: script + text.slice(at + 1), whole: false };
    script += part.value;
    at = part.next;
  }
  return { script, whole: text.slice(at).trim() === '' };
}

function wordPart(text: string, at: number): { value: string; next: number } | undefined {
  const char = text[at];
  if (char === "'") {
    const end = text.indexOf("'", at + 1);
    return end === -1 ? undefined : { value: text.slice(at + 1, end), next: end + 1 };
  }
  if (char === '"') return doubleQuoted(text, at + 1);
  if (char === '\\') return { value: text[at + 1] ?? '', next: at + 2 };
  return { value: char, next: at + 1 };
}

/** Inside double quotes a backslash escapes only `$`, a backtick, `"`, `\` and a newline. */
function doubleQuoted(text: string, start: number): { value: string; next: number } | undefined {
  let value = '';
  for (let at = start; at < text.length; at++) {
    if (text[at] === '"') return { value, next: at + 1 };
    const escaped = text[at] === '\\' && at + 1 < text.length && '$`"\\\n'.includes(text[at + 1]);
    value += escaped ? text[++at] : text[at];
  }
  return undefined;
}

// ── The asking ───────────────────────────────────────────────────────────────

/** Codex's requests for one task, in this window: held in order, asked one at a time, answered to RAVIS. */
export class CodexApprovals {
  readonly board = new QuestionBoard();
  /** The request whose prompt is on screen, and how a switch to Unattended answers it. */
  private showing: { request: RequestView; answerForMode(decision: Decision): void } | undefined;
  /** Answers RAVIS never received, asked again once it answers. */
  private readonly unsent = new Map<string, RequestView>();

  constructor(private readonly ports: ApprovalPorts) {}

  /** A request RAVIS opened, from `request.opened` or a snapshot. Ignored once the task is stopping. */
  open(request: unknown): void {
    if (!isRequestView(request) || this.ports.stopping()) return;
    if (this.board.open(request)) this.askNext();
  }

  /** `request.resolved`: another window, a stop, the unanswered policy or RAVIS's own answer ended it. */
  resolved(data: Record<string, unknown>): void {
    const id = String(data.request_id);
    this.unsent.delete(id);
    const line = this.board.resolve(id) === 'showing' ? resolvedLine(data.by) : undefined;
    if (line) this.ports.say(line);
    this.askNext();
  }

  /** `site.allowed`: the owner's allow reached Codex's list. */
  siteAllowed(data: Record<string, unknown>): void {
    if (typeof data.host === 'string') this.ports.say(siteAllowedLine(data.host));
  }

  /** Stop: every request let go at once. Returns how many there were. */
  releaseAll(): number {
    this.unsent.clear();
    return this.board.releaseAll();
  }

  /** Every request held, the one on screen first. */
  get held(): RequestView[] {
    return this.board.held;
  }

  /** The chat's mode changed: a request on screen that Unattended answers on its own is answered now. */
  modeChanged(): void {
    const showing = this.showing;
    const decision = showing && autoAnswer(showing.request, this.autoContext());
    if (showing && decision) showing.answerForMode(decision);
  }

  /** RAVIS answers again: what it never received is asked again, in the order it was asked. */
  reconnected(): void {
    const waiting = [...this.unsent.values()].reverse();
    this.unsent.clear();
    for (const request of waiting) this.board.redraw(request);
    this.askNext();
  }

  private askNext(): void {
    const asking = this.board.next();
    if (asking) void this.handle(asking);
  }

  private async handle({ request, signal }: Asking): Promise<void> {
    const decision = this.autoDecision(request) ?? (await this.askPerson(request, signal));
    // "Stop the run" is Stop, whatever became of the question meanwhile: stopping is never a step Codex takes.
    if (decision?.kind === 'stop') return this.stopRun(request);
    await this.beforeSending(request, decision);
    // The last check before anything is sent (review M3): has anything ended this question meanwhile?
    const stopped = this.ports.stopping() || !this.board.stillAsking(request.id);
    this.board.answered(request.id);
    if (engineDecisionAfterAsking(decision, stopped) === 'send') await this.send(request, decision as Decision);
    this.askNext();
  }

  /** An approved file change: its files copied for undo first, before the answer is checked again and sent. */
  private async beforeSending(request: RequestView, decision: Decision | undefined): Promise<void> {
    if (decision?.kind === 'once' && request.kind === 'fileChange') await this.capture(request);
  }

  private autoDecision(request: RequestView): Decision | undefined {
    const decision = autoAnswer(request, this.autoContext());
    if (decision) this.ports.log(`codex: Unattended answered ${request.kind} ${request.id} itself (once)`);
    return decision;
  }

  private autoContext(): AutoContext {
    return { mode: this.ports.mode(), attached: this.ports.attached() };
  }

  private stopRun(request: RequestView): void {
    this.board.answered(request.id);
    this.ports.stopRun();
  }

  private async askPerson(request: RequestView, signal: AbortSignal): Promise<Decision | undefined> {
    const prompts = promptsFor(request);
    if (prompts.length === 0) {
      this.ports.log(`codex: nothing this Clarvis can ask for ${request.kind} ${request.id}`);
      return undefined;
    }
    if (request.kind !== 'question') return this.askUntilDecided(request, prompts[0], signal);
    return this.askEachQuestion(request, prompts, signal);
  }

  /** A question request's questions, one after another, sent as one answer; a stop at any of them is the stop. */
  private async askEachQuestion(request: RequestView, prompts: RequestPrompt[], signal: AbortSignal): Promise<Decision | undefined> {
    const answers: Record<string, string> = {};
    for (const prompt of prompts) {
      const decision = await this.askUntilDecided(request, prompt, signal);
      if (decision?.kind !== 'answer') return decision;
      Object.assign(answers, decision.answers);
    }
    return { kind: 'answer', answers };
  }

  /** Shows the prompt until it is decided or taken away. Typed words that aren't an answer go to Codex. */
  private async askUntilDecided(request: RequestView, prompt: RequestPrompt, signal: AbortSignal): Promise<Decision | undefined> {
    for (let again = false; ; again = true) {
      const reading = await this.showOnce(request, prompt, signal, again);
      if (reading === undefined || 'decision' in reading) return reading?.decision;
      this.ports.steer(reading.typed);
      if (signal.aborted || this.ports.stopping()) return undefined;
    }
  }

  /**
   * One showing of a prompt. It ends with the owner's reply, or at once — its buttons withdrawn — when the request no
   * longer wants an answer, or when a switch to Unattended answers it while it is on screen.
   */
  private async showOnce(request: RequestView, prompt: RequestPrompt, signal: AbortSignal, again: boolean): Promise<ReplyReading> {
    const shown = new AbortController();
    let settle: (reading: ReplyReading) => void = () => undefined;
    const settled = new Promise<ReplyReading>((resolve) => (settle = resolve));
    const end = (reading: ReplyReading) => {
      settle(reading);
      shown.abort();
    };
    const letGo = () => end(undefined);
    signal.addEventListener('abort', letGo, { once: true });
    this.showing = { request, answerForMode: (decision) => end({ decision }) };
    try {
      if (signal.aborted) return undefined;
      void Promise.resolve()
        .then(() => this.ports.show(prompt, shown.signal, again))
        .then((reply) => settle(readReply(prompt, reply)), () => settle(undefined));
      return await settled;
    } finally {
      this.showing = undefined;
      signal.removeEventListener('abort', letGo);
    }
  }

  private async capture(request: RequestView): Promise<void> {
    const paths = capturePaths(request.payload);
    if (paths.length === 0 || !this.ports.capture) return;
    try {
      await this.ports.capture(paths);
    } catch (error) {
      // The task branch is still the undo; the copies only add to it.
      this.ports.log(`codex: files weren't copied for undo before the change (${String(error)})`);
    }
  }

  private async send(request: RequestView, decision: Decision): Promise<void> {
    const outcome = await this.ports.answer(request.id, decision);
    if (outcome.ok) return this.ports.log(`codex: answered ${request.id} with ${decision.kind}`);
    this.ports.log(`codex: the answer to ${request.id} was not taken (${refusalCode(outcome.failure) ?? outcome.failure.kind})`);
    this.refused(request, outcome.failure);
  }

  private refused(request: RequestView, failure: RelayFailure): void {
    const code = refusalCode(failure);
    if (code === 'SESSION_STOPPING') return;
    if (code === 'DECISION_NOT_ALLOWED') return this.narrowed(request, failure);
    if (code === 'SITE_NOT_ADDED') return this.siteNotAdded(request, failure);
    if (code === 'REQUEST_ALREADY_RESOLVED') return this.ports.say(resolvedLine(detailsOf(failure).by) ?? CODEX_LINES.answeredElsewhere);
    if (failure.kind === 'unreachable') return this.keepUnsent(request);
    this.ports.say(answerRefusedLine(failure) ?? failure.kind);
  }

  /** `DECISION_NOT_ALLOWED`: drawn again with what RAVIS offers now. */
  private narrowed(request: RequestView, failure: RelayFailure): void {
    const allowed = strings(detailsOf(failure).allowed_decisions).filter(isDecisionKind);
    if (allowed.length === 0) return this.ports.say(CODEX_LINES.nothingOffered);
    this.ports.say(CODEX_LINES.decisionNarrowed);
    this.board.redraw({ ...request, allowed_decisions: allowed });
  }

  /** `SITE_NOT_ADDED`: the site stays blocked, and RAVIS keeps the ask open, so it is asked again. */
  private siteNotAdded(request: RequestView, failure: RelayFailure): void {
    const host = text(detailsOf(failure).host) || text(request.payload.host);
    this.ports.say(siteNotAddedLine(host));
    this.board.redraw(request);
  }

  private keepUnsent(request: RequestView): void {
    this.ports.say(CODEX_LINES.answerUnsent);
    this.unsent.set(request.id, request);
  }
}

/** The files a change touches, and where renames go, relative to the project: what undo copies first. */
export function capturePaths(payload: Record<string, unknown>): string[] {
  const touched = fileEntries(payload.files).flatMap((file) => [file.path, ...(file.movedTo ? [file.movedTo] : [])]);
  return [...new Set(touched.filter(insideProject))];
}

const DECISION_KINDS = new Set<string>(['once', 'skip', 'stop', 'answer', 'allow_site', 'keep_blocked']);

function isDecisionKind(value: string): value is DecisionKind {
  return DECISION_KINDS.has(value);
}

function isRequestView(value: unknown): value is RequestView {
  const request = value as Partial<RequestView> | null;
  const shaped = typeof request?.id === 'string' && typeof request.kind === 'string';
  return shaped && Array.isArray(request?.allowed_decisions) && typeof request?.payload === 'object' && request.payload !== null;
}

function detailsOf(failure: RelayFailure): Record<string, unknown> {
  return failure.kind === 'refused' ? failure.details : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isSet(value: unknown): boolean {
  return value !== null && value !== undefined;
}
