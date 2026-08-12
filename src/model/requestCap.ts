/**
 * A ceiling on how many model requests a day can cost.
 *
 * §6 already limits how often Clarvis *interrupts*; this limits what he spends. They are
 * different failures: an agent loop that misreads a task can burn a hundred requests
 * without saying anything unusual, and the first anyone hears of it is the invoice.
 *
 * Found missing while walking the M8 exit checklist, which tests
 * `clarvis.chat.dailyRequestCap` — a setting that was specified, documented in the
 * manual's settings table, and never implemented. The voice side had one; the model side
 * did not, which is backwards, since a model request costs more than a sentence of TTS.
 *
 * Pure, so the rollover and the boundary can be tested without a clock or a keychain.
 */

/** The stored tally: which day it belongs to, and how far through it we are. */
export interface RequestTally {
  /** Local calendar day, as `YYYY-MM-DD`. */
  day: string;
  count: number;
}

/**
 * The day a timestamp belongs to, in local time.
 *
 * Local rather than UTC deliberately: the cap exists so someone does not wake up to a
 * bill, and "today" for that purpose is their today, not Greenwich's.
 */
export function dayOf(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface CapDecision {
  /** Whether this request may go ahead. */
  allowed: boolean;
  /** The tally to store back. */
  tally: RequestTally;
  /**
   * True only on the request that first crosses the line.
   *
   * The notice fires once, not on every refusal afterwards: being told you are out of
   * budget forty times is worse than being out of budget.
   */
  justHitCap: boolean;
}

/**
 * Counts a request against today's allowance.
 *
 * A cap of zero or less means no cap at all, which is the honest reading of "unlimited"
 * and avoids a setting that silently bricks the extension at 0.
 */
export function countRequest(
  stored: RequestTally | undefined,
  cap: number,
  at: number
): CapDecision {
  const today = dayOf(at);
  const tally = stored?.day === today ? { ...stored } : { day: today, count: 0 };

  if (cap <= 0) return { allowed: true, tally, justHitCap: false };

  if (tally.count >= cap) return { allowed: false, tally, justHitCap: false };

  tally.count++;
  return { allowed: true, tally, justHitCap: tally.count === cap };
}

/** What to say when the ceiling is reached. Stated plainly: this one costs money. */
export function capReachedMessage(cap: number): string {
  return (
    `That is ${cap} model requests today, which is the daily cap. ` +
    'Nothing else will be sent until tomorrow — raise `clarvis.chat.dailyRequestCap` if that is too low.'
  );
}
