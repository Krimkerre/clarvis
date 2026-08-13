import { InterviewState, TopicId } from './interviewTopics';
import { FindingVerdict } from './verdictSummary';

/**
 * Turning an approved plan into the first agent task (M9e — §4.6/§4.9).
 *
 * Pure and tested: the prompt is the whole handoff, and getting it wrong means the
 * agent builds the wrong thing from a plan the user just approved.
 *
 * **Assembled from the plan, never hidden.** §4.9 is explicit that the handoff
 * prompt is shown and editable before it runs — a plan signed off on and then
 * silently rewritten into something else is the one thing sign-off exists to prevent.
 */

function answerText(state: InterviewState, topic: TopicId): string | undefined {
  return state.answers.find((answer) => answer.topic === topic)?.text;
}

/** Milestone one, as a task the agent can act on. */
export function handoffTask(
  state: InterviewState,
  seed: string,
  verdicts: FindingVerdict[],
  steps: string[] = []
): string {
  const name = state.projectName ?? seed;
  const language = answerText(state, 'language');
  const done = answerText(state, 'definition-of-done');

  // **The steps are the work; the findings are questions.** Handing over a list of
  // "Clarify whether…" items produced a run that read the plan, found nothing to do,
  // and stopped — found live. They are still passed on, named for what they are.
  const settle = verdicts
    .filter((verdict) => verdict.status !== 'rejected')
    .map((verdict) =>
      verdict.status === 'modified' ? (verdict.reasoning ?? verdict.finding.what) : verdict.finding.suggestedResolution
    );

  return [
    `Start building ${name}, following the approved plan.md in this workspace.`,
    '',
    `What it is: ${answerText(state, 'what-it-does') ?? seed}`,
    ...(answerText(state, 'who-and-where') ? [`Where it runs: ${answerText(state, 'who-and-where')}`] : []),
    ...(language ? [`Language: ${language}`] : []),
    ...(answerText(state, 'scope') ? [`Scope: ${answerText(state, 'scope')}`] : []),
    '',
    ...(done ? [`Done when: ${done}`, ''] : []),
    'Milestone 1 — build these, ticking each off in plan.md as it lands:',
    ...(steps.length > 0
      ? steps.map((step) => `- ${step}`)
      : ['- (no build steps were written — work out the smallest thing that runs, and do that)']),
    ...(settle.length > 0 ? ['', 'Open questions to settle as you go, not before you start:', ...settle.map((item) => `- ${item}`)] : []),
    '',
    'Start with the smallest thing that runs. Do not build past milestone 1.',
  ].join('\n');
}
