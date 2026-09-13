import { ungroundedClaims } from './grounded';
import { character, ONLY_WHAT_YOU_WERE_GIVEN } from './character';

/**
 * Every sentence Clarvis says to a person goes through here.
 *
 * **The mistake this exists to correct.** Personality was built as a feature — a bank
 * of quips — rather than as the medium. Everything built afterwards wrote its own
 * strings at the call site, in the developer's voice: "Switching to `main`.",
 * "1 file(s) changed.", "Operation completed." Each was fine on its own, and together
 * they made a character who is witty in the chat panel and dead in every dialog.
 *
 * So: one place, one voice. A surface declares *what it needs to say and why*; this
 * decides how it sounds.
 *
 * **What is never touched.** A line's load-bearing content — the command in a gate, the
 * branch a merge targets, the consequence of a deletion — is passed through verbatim.
 * The character lives in the framing, never in the facts, because a warning that got
 * witty about the wrong part is worse than a plain one.
 */

/**
 * Why a line exists, which is what decides how much personality it can carry.
 *
 * Not a style knob — a constraint. Somebody deciding whether to delete work needs the
 * consequence unambiguous; somebody being told a task finished can have the joke.
 */
export type Purpose =
  /** A thing happened. Room for character. */
  | 'report'
  /** Something might go wrong, or be lost. Character is heavily constrained. */
  | 'warn'
  /** A choice with consequences. Plain, and the consequence stays exact. */
  | 'ask'
  /** Pure comic relief, after the information has already landed. */
  | 'aside';

export interface Line {
  purpose: Purpose;
  /** The written line. Always usable on its own — this is the fallback, not a hint. */
  fallback: string;
  /** Facts the rewrite must preserve exactly: branch names, counts, commands. */
  keep?: string[];
  /**
   * What is actually happening, when the line alone does not say.
   *
   * **Added after a rewrite invented its own occasion.** Clicking the bowtie produced
   * *"Clearly a compliment from someone who hasn't seen me disagree with you yet"* — a
   * reply to praise nobody had given. The written line behind it was *"A second opinion
   * on my own intelligence. Bracing."*, and with nothing but that to go on, reading it as
   * a response to a compliment is a fair inference. The model was not wrong, it was blind.
   *
   * Most lines carry their own occasion — a briefing about a branch is unmistakably that.
   * A remark *about* a moment rather than *containing* it needs the moment supplied, or
   * the rewrite is free to invent one.
   */
  situation?: string;
}

/**
 * How much freedom each purpose gets.
 *
 * **Rewritten after the first version made him worse.** That one was a list of things
 * not to do — never enthusiastic, no exclamation marks, keep every fact — with no
 * instruction to be funny at all. A model given only prohibitions writes the safest
 * sentence it can, and the safest sentence is a talking fridge. The bans are still
 * here, but they are no longer the whole brief.
 */
const LICENCE: Record<Purpose, string> = {
  report:
    'Make it land. Dry, specific, a little put-upon — the sort of line someone would read out to a colleague. ' +
    'Understatement beats a joke; a joke beats a status update. Never neutral.',
  warn:
    'State the risk first and unmistakably. You may be dry about it afterwards, but never funny about what could be lost.',
  ask:
    'Plain and brief. The consequence of the choice must survive exactly, and the user is deciding something — so no jokes.',
  aside:
    'This is the exhale after the facts. Be funny, in his register: dry, faintly exasperated, at your own expense or the work’s. ' +
    'Never restate the facts, never at the user’s expense.',
};

/**
 * Purposes where a rewrite is not worth the risk.
 *
 * A prompt asking someone to confirm a deletion was already plain, exact and fine.
 * Rewriting it gained nothing and cost stiffness — which is most of what made the last
 * version feel worse than the strings it replaced.
 */
export function worthRewriting(purpose: Purpose): boolean {
  return purpose === 'report' || purpose === 'aside';
}

/**
 * The instruction for rewriting one line in character.
 *
 * The fallback is included as the *meaning*, not as a draft to improve: a model handed
 * "make this better" writes something longer, and length is the failure mode this
 * character has.
 */
export function rewritePrompt(line: Line): string {
  return [
    character(),
    '',
    line.situation ? `What is happening: ${line.situation}` : '',
    `Say this: ${line.fallback}`,
    line.keep?.length ? `Include these exactly: ${line.keep.join(', ')}` : '',
    '',
    LICENCE[line.purpose],
    ONLY_WHAT_YOU_WERE_GIVEN,
    'One sentence. No emoji, no exclamation marks, no quotation marks, no preamble.',
    'Reply with the line alone.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Longer than this and it has stopped being a line. */
const MAX_LENGTH = 160;

/**
 * Whether a rewrite is usable, or the written line stands.
 *
 * Rejection is cheap and silent: the fallback was always going to be fine. What is
 * expensive is a rewrite that dropped the branch name, added a question, or turned a
 * warning into a joke — so each of those is checked rather than hoped for.
 */
export function acceptRewrite(line: Line, raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  const text = raw
    .trim()
    .split('\n')[0]
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();

  if (!text || text.length > MAX_LENGTH) return undefined;

  // Every fact must survive. A rewrite that lost the branch name is a rewrite that
  // changed what the sentence means.
  if (line.keep?.some((fact) => !text.includes(fact))) return undefined;

  // The character has neither of these, and a model reaches for both when asked to be
  // charming.
  if (/[\p{Extended_Pictographic}]/u.test(text)) return undefined;
  if (text.includes('!')) return undefined;

  // A statement that became a question has changed what the user is expected to do.
  if (!line.fallback.trim().endsWith('?') && text.endsWith('?')) return undefined;

  if (!stillTheLine(line.fallback, text)) return undefined;

  // **A number that was not in the written line is a number nobody supplied.** The rules
  // forbid this in prose — `ONLY_WHAT_YOU_WERE_GIVEN` says every count and timing must come
  // from what was actually given — and on a capable model the rules hold. On a small one
  // they do not: told "40 minutes ago", one answered "failed for the 40th time", and told
  // "2 error(s)" it produced "the past two commits". Neither invented a *value*; each
  // re-filed one it had been handed under a different noun, which is why the check compares
  // the pairing rather than the digits (see `grounded.ts`).
  //
  // The facts here are the written line and whatever had to be preserved — between them,
  // everything this rewrite was entitled to say.
  if (ungroundedClaims(text, `${line.fallback} ${line.situation ?? ''} ${(line.keep ?? []).join(' ')}`).length > 0) {
    return undefined;
  }

  return text;
}

/** The instruction's own words. A written line almost never uses them; a reply about the task does. */
const TALKS_ABOUT_THE_TASK = /\brewrit(?:e|es|ten|ing)\b|\bin character\b/i;

/**
 * Whether the rewrite still does the job the written line does.
 *
 * **Found live, 13 September 2026, on gpt-4.1-mini.** The build offer's lead-in "This is
 * what I would be handing myself:" introduces the task printed under it. One rewrite
 * finished the sentence with a thought of its own — "…: turning this single swallowed
 * exception into something actionable takes precedent over clever silence." — and another
 * answered the instruction instead: "A line rewritten in character requires a line to
 * rewrite." Both passed every check above, because none of them asked whether the result
 * was still the line.
 */
function stillTheLine(fallback: string, text: string): boolean {
  // A lead-in introduces what follows it, so the rewrite must still end by introducing it.
  if (fallback.trim().endsWith(':') && !text.endsWith(':')) return false;
  // A remark about being asked to rewrite something is not a line at all.
  return !TALKS_ABOUT_THE_TASK.test(text) || TALKS_ABOUT_THE_TASK.test(fallback);
}

/**
 * Phrases that mean nobody wrote this.
 *
 * Not a style preference — these are the tell that a string was typed by a developer
 * filling in a dialog rather than by a character speaking. The test at the bottom of
 * the suite fails on any of them appearing in a written line.
 */
export const DEAD_PHRASES = [
  /\bsuccessfully\b/i,
  /\boperation (completed|failed)\b/i,
  /\bplease note\b/i,
  /\ban error occurred\b/i,
  /\binvalid input\b/i,
  /\bunable to complete\b/i,
  /\bN\/A\b/,
  /\bplease try again\b/i,
];

/** Whether a written line reads as a person speaking rather than a form. */
export function soundsWritten(text: string): boolean {
  return !DEAD_PHRASES.some((pattern) => pattern.test(text));
}
