/**
 * Whether a task is small and clear enough to skip the planning questions (19 September 2026).
 *
 * Found live: handed "a Python script that prints today's date" from NERVIS, the interview
 * walked all eight topics, and the owner spent longer answering than writing the script would
 * have taken. §4.9 already says a round asks "only what would actually change the plan" and
 * the count is "a guide, not a gate"; this is that rule applied to the whole interview.
 *
 * The model judges, since "small" is about meaning, not length. **Anything it cannot answer
 * cleanly is FULL** — a missed shortcut costs a few questions, a wrong one skips the review
 * of a task that needed it. And the prompt sends anything touching credentials, personal data,
 * files beyond its own, or the network to FULL: `data` drives every safety finding, and the
 * 13 September ShopFloor walkthrough was a "small web app" whose one sentence hid a plaintext
 * password file.
 *
 * Even SMALL only offers the shortcut: the person is asked, one click either way, and the
 * draft still goes through analysis and their approval.
 */

export function smallTaskPrompt(seed: string): string {
  return [
    'Decide whether this task is small and clearly described enough to plan without asking questions.',
    '',
    'Answer SMALL only if ALL of these hold: it is one small, self-contained thing (a single script,',
    'one small change, a tiny tool); what it should do is stated plainly; and it does not involve',
    'passwords or keys, personal data, other people using it, storing data, reading or changing',
    'files other than its own, or talking to the network or another service.',
    '',
    'Answer FULL otherwise, and whenever you are unsure.',
    '',
    'Reply with the one word SMALL or FULL and nothing else.',
    '',
    `The task: ${seed}`,
  ].join('\n');
}

/** SMALL only when the reply says SMALL and not FULL; everything else — empty, both, prose — is FULL. */
export function isSmallVerdict(reply: string): boolean {
  const said = reply.toUpperCase();
  return /\bSMALL\b/.test(said) && !/\bFULL\b/.test(said);
}
