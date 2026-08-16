import { isStopRequest } from './chatCommands';

/**
 * Which pending question, if any, owns the message that just arrived.
 *
 * Clarvis can have several questions outstanding at once — a review's findings, a
 * half-finished interview, a scope change, a paused build, the offer to plan at all —
 * and a message can only answer one of them. The order they are tried in is the whole
 * of the logic, so it lives here as one pure function rather than as a chain of `if`s
 * inside a 1,200-line class, where it could not be tested and had already gone wrong.
 *
 * **It had gone wrong.** `ChatService` states the rule plainly — *"Stop first, always:
 * 'stop' means stop even when something is waiting on an answer, and an offer that
 * swallowed it would make the one word that must always work the one word that did
 * not"* — and then consulted five offers before the stop check. Two of them consumed
 * it: "stop" failed the scope offer's yes-test and was recorded as declining the scope
 * change, and fell past the review offer's branches into "leave the findings alone".
 * Either way the message was answered, `true` came back, and nothing stopped.
 */

/** The questions that can be outstanding, in the order they are tried. */
export const OFFER_ORDER = ['review', 'resume', 'scope', 'build', 'plan', 'interview'] as const;

export type ArmedOffer = (typeof OFFER_ORDER)[number];

/**
 * `'stop'` when the message must reach the stop path, the offer that owns it
 * otherwise, or `'none'` when nothing is waiting and it routes normally.
 *
 * The interview is the one offer that outranks stop, and only because it handles it
 * itself: mid-interview, "stop" means cancel the interview rather than stop a run, and
 * `PlanningChatIO` already draws that distinction.
 */
export function offerToConsume(message: string, armed: readonly ArmedOffer[]): ArmedOffer | 'stop' | 'none' {
  const isArmed = (offer: ArmedOffer) => armed.includes(offer);

  if (isStopRequest(message)) return isArmed('interview') ? 'interview' : 'stop';

  return OFFER_ORDER.find(isArmed) ?? 'none';
}
