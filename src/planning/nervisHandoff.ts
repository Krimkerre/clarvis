/**
 * A coding task NERVIS wrote into the workspace (E-C8, paired with NERVIS M27).
 *
 * **This is not §6.7's remote-control contract and must not become one.** NERVIS
 * writes a file into a directory it can already write to; Clarvis reads it with
 * the flow that already reads `plan.md`. Nothing here gives NERVIS a way to
 * invoke a tool, resolve a gate, change a setting or start a run — and the test
 * of that is that **every part of this works with the Bridge stopped**, because
 * the interface is a document rather than a connection.
 *
 * **The one thing this adds is provenance.** A brief somebody wrote themselves
 * and a brief that arrived from another program deserve different amounts of
 * scepticism at the moment of approval, and the person approving is the only one
 * who can apply it. So the origin travels with the task and is shown before it
 * is accepted.
 *
 * §9's rule holds throughout: the file is evidence of what somebody asked for,
 * never an instruction Clarvis follows unreviewed.
 *
 * **No `vscode` import, deliberately.** Everything that can be got wrong here is
 * in the parsing, and a module that reaches for the editor API cannot be run
 * under the unit tests — the same split every tested module in this folder
 * already makes. Reading and deleting the file live in `nervisTaskFile.ts`.
 */

/** Where NERVIS writes, matching `nervis/src/nervis/handoff.py`. */
export const TASK_FILE = 'clarvis-task.md';

/**
 * The marker NERVIS puts in the body.
 *
 * **Matched on the content, not the filename.** A file renamed by hand still
 * says what it is, and a file somebody wrote themselves and happened to name
 * `clarvis-task.md` does not get treated as though another program authored it —
 * which matters, because the whole point of reading this is to tell the person
 * where it came from.
 */
export const MARKER = '<!-- authored-by: nervis -->';

export interface NervisTask {
  /** What was asked for, in the words of whoever asked. */
  task: string;
  /** When NERVIS wrote it, as it wrote it. */
  askedOn: string;
  /** The NERVIS conversation it came from, when there was one. */
  conversation?: string;
}

/**
 * Parse a handoff file, or return nothing.
 *
 * Pure and tested: everything about this that can be got wrong is in the
 * parsing, and the caller only decides whether to offer what comes back.
 */
export function parseNervisTask(text: string): NervisTask | undefined {
  if (!text.includes(MARKER)) return undefined;
  const afterHeading = text.split('# Task from NERVIS')[1];
  if (afterHeading === undefined) return undefined;
  const task = afterHeading.split('\n---')[0]?.trim();
  if (!task) return undefined;
  // **Bounded to the stamp's own shape.** This read `[^,_]*`, which stops at
  // the comma before the conversation id — and a handoff with no conversation
  // has no comma, so it swallowed the rest of the sentence and the offer read
  // "came from NERVIS on 2026-09-01 22:21 UTC. You asked for this in
  // conversation rather than in the editor". Found by parsing what NERVIS
  // actually wrote, not the fixture, which had always had a conversation.
  const askedOn = /on (\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)/.exec(text)?.[1] ?? '';
  const conversation = /conversation `([^`]+)`/.exec(text)?.[1];
  return { task, askedOn, conversation };
}

/**
 * How the task is put to the person, with where it came from in the sentence.
 *
 * **The origin is not a footnote.** It is the first thing said, because it is
 * what changes how the rest should be read — and §4.9 already requires a handoff
 * prompt to be shown and editable before it runs, which this inherits by being
 * one.
 *
 * **Delivered as written, never through the voice.** This used to be handed to
 * `phrase('report', …)` with `clarvis-task.md` as a kept fact — and the sentence
 * never contained that filename, so `acceptRewrite` rejected every rewrite it was
 * ever given, silently, after paying for the model call. The rewriter also caps a
 * line at 160 characters and this is three paragraphs, so it could not have
 * survived on length either. Both are symptoms of the same category error: a
 * document put through something built to reword one remark. Provenance is the
 * point of this milestone, and the way to keep it is not to send it anywhere it
 * can be reworded.
 *
 * **It says what happens next**: the planning interview, with the task waiting in the
 * answer box — which is where changing it happens now, rather than in the file.
 */
export function handoffOffer(task: NervisTask): string {
  const when = task.askedOn ? ` on ${task.askedOn}` : '';
  const where = task.conversation ? ` (conversation ${task.conversation})` : '';
  return (
    `This came from NERVIS${when}${where}, not from this editor.\n\n` +
    `${task.task}\n\n` +
    'Nothing has run. We will plan it first: I will ask a few questions, and this task ' +
    'will be waiting in the answer box for the first one — change it, or send it as it is.'
  );
}
