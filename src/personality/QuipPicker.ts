import { Quip, QuipTrigger, QUIPS, Tone } from './quipBank';

/**
 * How much evidence of a rough session unlocks the sharper lines (§2 rule 2).
 *
 * Named and documented rather than left as a bare number, because "when does he start
 * being rude" is a product decision, not an implementation detail. Roughly: two things
 * going wrong is a bad morning; three is a pattern he's allowed to notice.
 */
export const EARNED_SASS_THRESHOLD = 3;

/**
 * Chooses what Clarvis says, and makes sure he doesn't repeat himself.
 *
 * Pure apart from its own state — no vscode import — so the selection rules are
 * testable without an extension host.
 */
export class QuipPicker {
  /** Lines already used this session, so nothing repeats while you're watching. */
  private readonly used = new Set<string>();

  /** Things that have gone wrong this session. Sass is unlocked by evidence, not time. */
  private evidence = 0;

  constructor(
    private readonly bank: Quip[] = QUIPS,
    private readonly random: () => number = Math.random
  ) {}

  /** Records that something went badly — a failure, a repeat, an eleven-minute build. */
  noteEvidence(): void {
    this.evidence += 1;
  }

  /** Whether the sharper lines are currently unlocked. */
  get sassUnlocked(): boolean {
    return this.evidence >= EARNED_SASS_THRESHOLD;
  }

  /**
   * Picks a line for a trigger, or nothing if the bank has none.
   *
   * **When every line for a trigger has been used, the used-set for that trigger is
   * cleared and lines become available again.** The alternative — going silent — reads
   * as broken rather than restrained, and the rate limiter (§7) is what actually
   * governs how often he speaks. Repetition is capped by the bank being exhausted
   * first, which takes a while.
   */
  pick(trigger: QuipTrigger): Quip | undefined {
    const allowed: Tone[] = this.sassUnlocked ? ['polite', 'earned'] : ['polite'];
    const eligible = this.bank.filter((q) => q.trigger === trigger && allowed.includes(q.tone));
    if (eligible.length === 0) return undefined;

    const unused = eligible.filter((q) => !this.used.has(q.id));
    const pool = unused.length > 0 ? unused : this.resetAndReturn(eligible);

    const chosen = pool[Math.floor(this.random() * pool.length)];
    this.used.add(chosen.id);
    return chosen;
  }

  /** Clears just this trigger's used lines, leaving other triggers' history intact. */
  private resetAndReturn(eligible: Quip[]): Quip[] {
    eligible.forEach((q) => this.used.delete(q.id));
    return eligible;
  }
}
