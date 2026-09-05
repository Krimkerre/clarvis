import { OfferAnswer } from './offerAnswer';
import { NervisTask } from '../planning/nervisHandoff';

/**
 * What to do with a task NERVIS handed over, once the person has answered (E-C8).
 *
 * **The file used to be deleted at the moment of offering**, before anybody had said
 * anything. The reasoning was sound as far as it went — NERVIS overwrites an unread
 * task rather than queueing, so a file left behind would be re-offered every time the
 * window opened, which is the nagging §6 exists to prevent — but the milestone's own
 * exit says the prompt is *"editable before it runs, as any other handoff is"*, and the
 * document somebody was invited to edit was already gone by the time they read the
 * offer. What survived was text in a transcript, which is not a thing you can edit.
 *
 * So the answer decides, and there are four of them rather than two:
 *
 *  - **Yes**, and the task is read from disk *again* — because the whole point of
 *    leaving the file there is that it may have been edited in between, and running the
 *    copy captured at offer time would make the invitation to edit it a lie.
 *  - **Yes**, and it has gone. Someone deleted or accepted it elsewhere between the
 *    question and the answer. Starting the remembered copy would run a document its
 *    author has withdrawn.
 *  - **No.** Now the file goes, and for the original reason: a decline that left it
 *    behind would ask again at every window.
 *  - **Neither** — they were mid-sentence about something else when the offer appeared,
 *    which `offerAnswer` treats as the common case. The offer goes quietly and the file
 *    stays, because nobody has answered it yet.
 *
 * Pure, so the four can be told apart in a test rather than by opening two windows.
 */
export type HandoffDecision = 'run' | 'withdrawn' | 'forget' | 'left-alone';

export function decideHandoff(answer: OfferAnswer, stillOnDisk: NervisTask | undefined): HandoffDecision {
  if (answer === 'yes') return stillOnDisk ? 'run' : 'withdrawn';
  if (answer === 'no') return 'forget';
  return 'left-alone';
}

/**
 * Whether the decision means the file should be removed.
 *
 * Stated once, here, rather than as two `if`s at the call site: "run" and "forget" are
 * both endings, and the two that are not — a withdrawn file and an unanswered offer —
 * must not delete anything, one because there is nothing to delete and the other
 * because it is not ours to throw away.
 */
export function clearsTheFile(decision: HandoffDecision): boolean {
  return decision === 'run' || decision === 'forget';
}
