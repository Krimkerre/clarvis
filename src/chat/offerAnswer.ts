/**
 * Whether a message is an answer to the question just asked, or a change of subject.
 *
 * **Two bugs, one on each side of this.** Declining the planning offer used to fall
 * through to a normal reply, so "No" was met with "That is not a question. I remain
 * here, unimpressed but ready" — him baffled by the answer to his own question. The fix
 * consumed everything that was not a yes, and immediately ate a real question:
 * "anything wrong in here?" arrived while the offer was up, was recorded as a decline,
 * and got "Noted. I will not bring it up again here."
 *
 * Both come from treating one question as two possible answers. There are three: yes,
 * no, and *they have moved on* — and the third is the common one, because an offer
 * appears unprompted while someone was already typing something else.
 *
 * Pure, and deliberately conservative: only a recognisable yes or no counts as an
 * answer. Everything else is the user's own business, and the offer quietly goes away.
 */

export type OfferAnswer = 'yes' | 'no' | 'unrelated';

/** Short, and either a plain agreement or one of the buttons. */
const YES = /^(y|yes|yeah|yep|sure|ok|okay|go on|please|do it|start it|carry on|let'?s)\b/i;

/**
 * A refusal, and nothing that merely *contains* a refusal.
 *
 * Anchored to the start because "no idea what's wrong in here" is a question, not a
 * decline, and a substring match would file it as one.
 */
const NO = /^(n|no|nope|nah|not now|leave it|later|no thanks|not really|don'?t)\b/i;

export function offerAnswer(message: string): OfferAnswer {
  const text = message.trim();

  // A question is never an answer to a question, however it starts. "No idea, what is
  // wrong here?" opens with a refusal and is plainly not one.
  if (text.includes('?')) return 'unrelated';

  if (YES.test(text)) return 'yes';
  if (NO.test(text)) return 'no';

  // **Length is the honest tiebreak.** A one-word reply to a yes-or-no is an answer to
  // it; a sentence is someone getting on with their day, and consuming that is how a
  // question gets silently thrown away.
  return 'unrelated';
}
