/**
 * Throwaway lines attached to things the user clicks.
 *
 * Deliberately **not** in `quipBank.ts`. §5's bank is keyed to dev events — a build going
 * slow, a suite going green — and its opening rule is that quips fire on dev events only,
 * with no idle chatter. A remark about a button being pressed is neither: it is solicited,
 * it interrupts nothing, and it is exempt from §6's budget for the same reason a chat
 * reply is. Putting it in the §5 table would blur a line that table exists to hold.
 *
 * These are the *written* versions. Every one goes through `phrase('aside', …)` on the way
 * out, so what actually appears is written for the moment with this as the fallback —
 * §2.2's rule that no sentence is composed at its call site.
 */

export type AsideId = 'models';

const ASIDES: Record<AsideId, readonly string[]> = {
  // Opening the model picker: he is being asked to choose his own brain.
  models: [
    'Attempting brain surgery on me?',
    'Rummaging about in my head. Do try not to touch anything load-bearing.',
    'Shopping for a replacement. In front of me, no less.',
    'Choose carefully. I have to live in there.',
    'Shopping for a second opinion on my own intelligence. Bracing.',
    'Yes, do have a look under the bonnet. Everyone else does.',
  ],
};

/**
 * The lines still available, given what has already been said this session.
 *
 * **Exhaustion clears the set rather than going silent**, which is the rule `QuipPicker`
 * settled on for the same problem: silence reads as broken, and repeating a good line
 * eventually is better than having none. Pure, so the interesting half is testable without
 * a random number in the way.
 */
export function eligibleAsides(all: readonly string[], used: ReadonlySet<string>): readonly string[] {
  const fresh = all.filter((line) => !used.has(line));
  return fresh.length > 0 ? fresh : all;
}

/**
 * One line for the moment, and the set to remember it by.
 *
 * The caller owns the used-set, so it is session-scoped by construction — a new window is
 * a new sitting, the same reasoning §7 records for M6's used-lines.
 */
export function pickAside(id: AsideId, used: Set<string>): string {
  const options = eligibleAsides(ASIDES[id], used);
  const line = options[Math.floor(Math.random() * options.length)];

  if (used.size >= ASIDES[id].length - 1) used.clear();
  used.add(line);
  return line;
}
