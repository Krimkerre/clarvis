import { isDoItNow, needsClassification, RouteDecision } from './routing';
import { canEdit, ChatMode } from './modes';

/**
 * Whether a message becomes a job — the decision, separated from carrying it out.
 *
 * This is the branch that decides whether Clarvis writes to your files, so it is the
 * one most worth being able to test. It lived inside `ChatService.jobIn()`, tangled
 * with a log line, a piece of mutable state and a model call, in a class that has no
 * test file at all — which meant the mode gate protecting every edit was checked by
 * nobody.
 *
 * Four outcomes, in the order they are decided:
 *  - `none` — the mode forbids editing, or nothing here reads as work.
 *  - `escalate` — "do it" meaning the thing just answered, rather than this message.
 *  - `job` — the router recognised work.
 *  - `classify` — the verb list missed; worth one cheap model call to be sure.
 */
export type JobPlan =
  | { kind: 'none' }
  | { kind: 'escalate' }
  | { kind: 'job'; because: string }
  | { kind: 'classify' };

export function planJob(
  question: string,
  mode: ChatMode,
  decision: RouteDecision,
  hasLastAnswered: boolean
): JobPlan {
  // **The mode gate comes first and answers for everything below it.** A mode that
  // cannot edit cannot be talked into it by a convincing verb, an escalation, or the
  // classifier — so none of them are consulted.
  if (!canEdit(mode)) return { kind: 'none' };

  // "Do it" refers to the last thing *answered*, not to itself. Only meaningful when
  // there is something to refer back to.
  if (hasLastAnswered && isDoItNow(question)) return { kind: 'escalate' };

  if (decision.route === 'agent') {
    // Agent mode says so plainly; every other editing mode explains what it saw.
    return { kind: 'job', because: mode === 'agent' ? 'Agent mode — treating that as a job.' : decision.because };
  }

  // Plan mode is excluded on purpose: §0 allows planning to touch `plan.md` and
  // nothing else, so a message that merely *sounds* like work must not become work.
  if (mode !== 'plan' && needsClassification(question)) return { kind: 'classify' };

  return { kind: 'none' };
}
