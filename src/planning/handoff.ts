import { InterviewState, TopicId } from './interviewTopics';
import { agreedResolution, FindingVerdict } from './verdictSummary';

/**
 * The whole brief for a build with no plan behind it (M9e — §4.6/§4.9).
 *
 * Pure and tested: the prompt is the whole handoff, and getting it wrong means the
 * agent builds the wrong thing.
 *
 * **Assembled from what was agreed, never hidden.** §4.9 is explicit that the handoff
 * prompt is shown and editable before it runs — a plan signed off on and then silently
 * rewritten into something else is the one thing sign-off exists to prevent.
 *
 * **Only the no-plan path, since M9i.** A planned build is handed its milestone from the
 * approved plan.md by `nextMilestoneTask`, as every later milestone already was. This task
 * used to copy the interview's answers and the milestones as generated instead, so feedback
 * applied to the plan — and steps deleted from it by hand — never reached the agent, which was
 * still told `Scope: …cloud sync` after cloud sync had been taken out. With no plan, the task
 * is the only place the answers can live, so here they still travel.
 */

function answerText(state: InterviewState, topic: TopicId): string | undefined {
  return state.answers.find((answer) => answer.topic === topic)?.text;
}

/** Whether a build has a `plan.md` behind it, or is the whole brief on its own. It decides how the offer opens. */
export type PlanBacking = 'plan' | 'no-plan';

export interface FacingLines {
  opening: string;
  conventions: string[];
  heading: string;
  standalone: string[];
}

/** The lines for a task with no plan behind it, where the task itself is the brief. */
export function standaloneFacingLines(
  name: string,
  comments: string | undefined,
  /** Answers that would normally live in `plan.md` rather than in the task. */
  planOnly: { data?: string; linter?: string } = {}
): FacingLines {
  return {
    opening: `Start building ${name}. It was judged too small to need a plan, so there is no plan.md — this task is the whole brief.`,
    conventions: comments ? [`Comments: ${comments}`] : [],
    heading: 'Build the smallest thing that does this, and run it before you call it done:',
    // **Every answer, because there is nowhere else for them to be.** This task was written
    // as a pointer to the plan: `plan.md` carries `data` and `linter`, so the task did not
    // need to. With no plan the task *is* the brief, and each omission is an answer the
    // user gave that reaches nobody. Found live on 19 Aug — "generate a dozen or so, and
    // embed them in the script" never left the interview, and the agent wrote five and
    // reported success.
    standalone: [
      ...(planOnly.data ? [`Data: ${planOnly.data}`] : []),
      ...(planOnly.linter ? [`Linter: ${planOnly.linter}`] : []),
    ],
  };
}

/** The task for a project judged too small to need a plan: every answer, and how to finish. */
export function handoffTask(state: InterviewState, seed: string, verdicts: FindingVerdict[]): string {
  const name = state.projectName ?? seed;
  const language = answerText(state, 'language');
  const done = answerText(state, 'definition-of-done');

  const { opening, conventions, heading, standalone } = standaloneFacingLines(name, answerText(state, 'comment-style'), {
    data: answerText(state, 'data'),
    linter: answerText(state, 'linter'),
  });

  // **The steps are the work; the findings are questions.** Handing over a list of
  // "Clarify whether…" items produced a run that read the plan, found nothing to do,
  // and stopped — found live. They are still passed on, named for what they are.
  const settle = verdicts.filter((verdict) => verdict.status !== 'rejected').map(agreedResolution);

  return [
    opening,
    '',
    `What it is: ${answerText(state, 'what-it-does') ?? seed}`,
    ...(answerText(state, 'who-and-where') ? [`Where it runs: ${answerText(state, 'who-and-where')}`] : []),
    ...(language ? [`Language: ${language}`] : []),
    ...conventions,
    ...(answerText(state, 'scope') ? [`Scope: ${answerText(state, 'scope')}`] : []),
    ...standalone,
    '',
    ...(done ? [`Done when: ${done}`, ''] : []),
    heading,
    '- (no build steps were written — work out the smallest thing that runs, and do that)',
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
    // **A check has to end on its own.** Found live, 11 September 2026: "run with a
    // 5-second interval" was run as `python timer.py 5`, which the plan's own CLI step
    // reads as minutes — the run was stopped as hung, and milestone 1 never finished.
    'A check has to finish in seconds: anything that waits on the clock — a timer, a sleep,',
    'a countdown — gets the shortest duration the program accepts, never the real one.',
    // Found live, 13 September 2026: a check started a web server and curled it, and the
    // sandbox refused the bind twice before the run tested the handler instead.
    'Nothing a check runs can listen on a port or reach the network, localhost included, so a',
    'server cannot be started and connected to here. Check it in-process instead — call its',
    'handler with a test client or a fake request — and say that is how it was checked.',
    'Never tick a step whose check did not pass. If a check could not run — something it',
    'needs is missing, or it would not start — leave the step unticked, keep its wording, and say why.',
    'Then stop. Do not build past milestone 1, and do not start the next one.',
    '',
    // **Announced, so the panel can show where the run has got to.** Parsed out
    // before the user sees it — same mechanism the reply's facial expression uses,
    // and for the same reason: the model already knows which step it is on, and
    // asking separately would double the cost of every step to find out.
    'Before you begin each step above, output a line on its own containing exactly:',
    'STEP: <the step, copied from the list>',
    'Nothing else on that line. It is read by the editor, not by them.',
    // Found live: the model called a tool named STEP, spent a step on
    // `unknown tool "STEP"`, and recovered. It is a line of text, and saying so
    // costs a clause where not saying so cost a step.
    'That is a line of ordinary text in your reply, not a tool call — there is no tool called STEP.',
    '',
    'Start with the smallest thing that runs.',
  ].join('\n');
}

/**
 * How the build offer opens, given whether there is a plan to build from.
 *
 * **The no-plan path used to end in silence.** `NO-PLAN-NEEDED` is a legitimate outcome —
 * a thirty-line script told plainly that a plan would be ceremony — and §7's M9 exit
 * checklist has always said he then *offers to just write it instead*. He did not: the
 * build offer was gated on the plan being approved, so the one outcome that most obviously
 * ends in "shall I write it, then" was the one that offered nothing. Found on the 19 Aug
 * re-walk, the first time the branch had ever fired.
 *
 * A table rather than a ternary at the call site: the caller sat at the complexity
 * ceiling when this was written, and this is the half worth testing anyway.
 */
export const BUILD_OFFER_QUESTION: Record<PlanBacking, string> = {
  plan: 'Plan approved. Shall I go and build the first milestone, then?',
  'no-plan': 'No plan needed for this one. Shall I just write it?',
};
