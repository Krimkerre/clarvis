/**
 * The one line of a run worth hearing.
 *
 * A finished run has said several things: an opening remark, whatever the model
 * narrated while it worked, and a closing note about where the work sits. Reading all
 * of that aloud takes half a minute and buries the only sentence anyone is waiting
 * for — *what actually changed*.
 *
 * That sentence is almost always the **last** substantial one: the model works, then
 * says what it did. Pure, because picking it is the whole job.
 */

/** Below this, a line is a reaction rather than a result: "Done.", "There we go." */
const MIN_SUBSTANTIAL = 20;

/** Long enough for a real summary, short enough that nobody waits through it. */
const MAX_SPOKEN = 200;

/** Lines that belong to the machinery rather than the result. */
const NOT_A_RESULT = [
  /^your own work on/i, // the closing branch note
  /^nothing of mine to keep/i,
  /^i couldn't work on a copy/i,
];

export function headline(narration: string): string | undefined {
  const lines = narration
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !NOT_A_RESULT.some((pattern) => pattern.test(line)));

  if (lines.length === 0) return undefined;

  // Last substantial line first: the model narrates as it goes and summarises at the
  // end, so the summary is at the bottom. Falling back to the last line at all means
  // a short answer ("Done.") is still spoken rather than met with silence.
  const substantial = [...lines].reverse().find((line) => line.length >= MIN_SUBSTANTIAL);
  const chosen = substantial ?? lines[lines.length - 1];

  return trimToSentence(chosen);
}

/** Cuts at a sentence end rather than mid-word, when it has to cut at all. */
function trimToSentence(text: string): string {
  if (text.length <= MAX_SPOKEN) return text;

  const cut = text.slice(0, MAX_SPOKEN);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));

  return lastStop > MAX_SPOKEN / 2 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`;
}
