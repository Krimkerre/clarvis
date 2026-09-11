import { InterviewState, TopicId } from './interviewTopics';
import { agreedResolution, FindingVerdict } from './verdictSummary';
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

/**
 * The three lines of a handoff task that point at `plan.md`, in both worlds.
 *
 * With no plan there is nowhere for the conventions to live except the task itself —
 * they were still decided during the interview, so they travel inline rather than being
 * dropped.
 *
 * Extracted rather than written as three ternaries in `handoffTask`, which sits close
 * enough to `eslint.config.mjs`'s complexity ceiling that adding them broke the build.
 * Pure and tested, which is the better home for them anyway.
 */
/**
 * Whether a run has a `plan.md` behind it, or is the whole brief on its own.
 *
 * **Named rather than `hasPlan: boolean`.** It read as `handoffTask(state, seed,
 * verdicts, undefined, false)` at the call site — false what? — and it is threaded
 * through three functions here from a caller that was itself handed it, so splitting
 * each into a pair would only move the same ternary one level up into `offerToBuild`,
 * which the comment on `planFacingLines` records as already too branchy to take one.
 * `plannedFacingLines` / `standaloneFacingLines` *is* that split, done where the two
 * halves genuinely differ; this is what carries the choice to them.
 */
export type PlanBacking = 'plan' | 'no-plan';

export interface FacingLines {
  opening: string;
  conventions: string[];
  heading: string;
  standalone: string[];
}

/**
 * The lines for a task with a plan behind it — which is to say, pointers to it.
 *
 * One argument, because that is all this half ever used. It was
 * `planFacingLines(name, hasPlan, comments, planOnly)` with the other three arguments
 * ignored whenever `hasPlan` was true: the flag was hiding that the two halves do not
 * take the same inputs.
 */
export function plannedFacingLines(name: string): FacingLines {
  return {
    opening: `Start building ${name}, following the approved plan.md in this workspace.`,
    conventions: ['Follow the Conventions section in plan.md — it says how this project writes code.'],
    heading: 'Milestone 1 — build these, ticking each off in plan.md as it lands:',
    standalone: [],
  };
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

/** Milestone one, as a task the agent can act on. */
export function handoffTask(
  state: InterviewState,
  seed: string,
  verdicts: FindingVerdict[],
  /** The one milestone being handed over, and where it sits in the plan. */
  milestone?: { current: Milestone; number: number; total: number },
  /**
   * Whether a `plan.md` was actually written.
   *
   * `'no-plan'` is the `NO-PLAN-NEEDED` path, where the whole point is that no plan
   * exists. That branch fired for the first time on 19 Aug and this task text sent the
   * agent to read a file that was never created — three separate references to it, none
   * of which had ever been exercised because the branch downstream of them had never run.
   */
  backing: PlanBacking = 'plan'
): string {
  const name = state.projectName ?? seed;
  const language = answerText(state, 'language');
  const done = answerText(state, 'definition-of-done');
  const comments = answerText(state, 'comment-style');

  const { opening, conventions, heading, standalone } =
    backing === 'plan'
      ? plannedFacingLines(name)
      : standaloneFacingLines(name, comments, {
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
    // Named rather than restated: the plan carries the rules in full, and a summary
    // of them in the task would be a second copy to drift from the first.
    ...conventions,
    ...(answerText(state, 'scope') ? [`Scope: ${answerText(state, 'scope')}`] : []),
    ...standalone,
    '',
    ...(done ? [`Done when: ${done}`, ''] : []),
    milestone
      ? `Milestone ${milestone.number} of ${milestone.total} — ${milestone.current.title}. Build these, ticking each off in plan.md as it lands:`
      : heading,
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
    // **A check has to end on its own.** Found live, 11 September 2026: "run with a
    // 5-second interval" was run as `python timer.py 5`, which the plan's own CLI step
    // reads as minutes — the run was stopped as hung, and milestone 1 never finished.
    'A check has to finish in seconds: anything that waits on the clock — a timer, a sleep,',
    'a countdown — gets the shortest duration the program accepts, never the real one.',
    'Never tick a step whose check did not pass. If a check could not run — something it',
    'needs is missing, or it would not start — leave the step unticked, keep its wording, and say why.',
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
 * A pure function rather than a ternary at the call site, for the same reason as
 * `planningIsSettled`: the caller sits at the complexity ceiling, and this is the half
 * worth testing anyway.
 */
export const BUILD_OFFER_QUESTION: Record<PlanBacking, string> = {
  plan: 'Plan approved. Shall I go and build the first milestone, then?',
  'no-plan': 'No plan needed for this one. Shall I just write it?',
};
