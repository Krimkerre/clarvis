import { InterviewState, TopicId } from './interviewTopics';
import { FindingVerdict } from './verdictSummary';
import { Milestone } from './milestonePrompt';

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
  /** The one milestone being handed over, and where it sits in the plan. */
  milestone?: { current: Milestone; number: number; total: number }
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
    milestone
      ? `Milestone ${milestone.number} of ${milestone.total} — ${milestone.current.title}. Build these, ticking each off in plan.md as it lands:`
      : 'Milestone 1 — build these, ticking each off in plan.md as it lands:',
    ...(milestone && milestone.current.steps.length > 0
      ? milestone.current.steps.flatMap((step) => [
          `- ${step.step}`,
          ...(step.check ? [`  Check: ${step.check}`] : []),
        ])
      : ['- (no build steps were written — work out the smallest thing that runs, and do that)']),
    ...(settle.length > 0
      ? [
          '',
          'Agreed during review. Whichever of these was work is already a step above —',
          'the rest are questions to settle as you go, not before you start:',
          ...settle.map((item) => `- ${item}`),
        ]
      : []),
    '',
    '',
    // **Run the checks, then stop.** A milestone reported as finished on the model's
    // own say-so is a milestone nobody verified; the checks are written into the plan
    // precisely so that "done" means something ran.
    'When the steps are done, run each check above and report what actually happened —',
    'the command you ran and its real output, not what you expect it to say. A check',
    'that fails is a result, not a failure to hide: say so and stop.',
    milestone
      ? `Then stop. Build milestone ${milestone.number} and no further — the next one is a separate decision, and not yours.`
      : 'Then stop. Do not build past milestone 1, and do not start the next one.',
    '',
    // **Announced, so the panel can show where the run has got to.** Parsed out
    // before the user sees it — same mechanism the reply's facial expression uses,
    // and for the same reason: the model already knows which step it is on, and
    // asking separately would double the cost of every step to find out.
    'Before you begin each step above, output a line on its own containing exactly:',
    'STEP: <the step, copied from the list>',
    'Nothing else on that line. It is read by the editor, not by them.',
    '',
    'Start with the smallest thing that runs.',
  ].join('\n');
}
