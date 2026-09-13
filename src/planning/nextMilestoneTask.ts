import { MilestoneState } from './planUpdate';

/**
 * The task for a milestone that is already written down in `plan.md`.
 *
 * **Read from the plan, not rebuilt from an interview.** By the time milestone two
 * starts, the interview may have happened last week in another window — the plan is
 * the only thing that survived, and it has everything: the steps, their checks, and
 * what came before them.
 *
 * Deliberately thin. The agent is being pointed at a document it can read rather
 * than handed a copy of it, which is also the only version of this that stays true
 * when the user edits the plan by hand between milestones.
 *
 * **Milestone one as well, since M9i**, handed over the moment its plan is approved — so an
 * untouched first milestone is started rather than continued.
 */
export function nextMilestoneTask(
  milestone: MilestoneState,
  projectName: string,
  /**
   * Every milestone in the plan, so this one knows where it sits.
   *
   * **Without it he does not know how many there are.** Found live at the end of
   * project 2: "That's Milestone 4 finished — Milestone 5, if there is one, is a
   * separate conversation." There were four. A build that cannot tell whether it has
   * finished the project is one nobody can trust to say when it has, and the answer
   * was in the plan he had just been told to read.
   */
  all: MilestoneState[] = []
): string {
  const total = all.length;
  const later = all.filter((entry) => entry.number > milestone.number);
  const last = total > 0 && later.length === 0;
  const verb = milestone.number === 1 && milestone.done === 0 ? 'Start' : 'Continue';

  return [
    `${verb} building ${projectName}, following the approved plan.md in this workspace.`,
    '',
    total > 0
      ? `Milestone ${milestone.number} of ${total} — ${milestone.title}.`
      : `Milestone ${milestone.number} — ${milestone.title}.`,
    '',
    // **Named so the code written now can accommodate them.** Not to be built — the
    // instruction to stop is unchanged and comes last — but a cache written in
    // milestone 2 with no idea that milestone 3 is a week forecast is how a build
    // paints itself into a corner one milestone at a time.
    ...(later.length > 0
      ? [
          'Still to come after this one, so do not design against them:',
          ...later.map((entry) => `- Milestone ${entry.number} — ${entry.title}`),
          'Do not build any of that now. Knowing it is there is enough.',
          '',
        ]
      : []),
    ...(last
      ? [
          'This is the last milestone in the plan. When its steps are ticked the project',
          'as planned is finished — say so plainly rather than wondering aloud whether',
          'there is another one after it. There is not.',
          '',
        ]
      : []),
    'Read plan.md first. Build only the unticked steps under that milestone heading,',
    'in order, and tick each one off in plan.md as it lands.',
    '',
    'Before you begin each step, output a line on its own containing exactly:',
    'STEP: <the step, copied from the plan>',
    'Nothing else on that line. It is read by the editor, not by them.',
    // Found live: the model called a tool named STEP, spent a step on
    // `unknown tool "STEP"`, and recovered. It is a line of text, and saying so
    // costs a clause where not saying so cost a step.
    'That is a line of ordinary text in your reply, not a tool call — there is no tool called STEP.',
    '',
    'When the steps are done, run each check listed under them and report what actually',
    'happened — the command you ran and its real output, not what you expect it to say.',
    'A check that fails is a result, not a failure to hide: say so and stop.',
    'A check has to finish in seconds: anything that waits on the clock — a timer, a sleep,',
    'a countdown — gets the shortest duration the program accepts, never the real one.',
    // Found live, 13 September 2026: a check started a web server and curled it, and the
    // sandbox refused the bind twice before the run tested the handler instead.
    'Nothing a check runs can listen on a port or reach the network, localhost included, so a',
    'server cannot be started and connected to here. Check it in-process instead — call its',
    'handler with a test client or a fake request — and say that is how it was checked.',
    'Never tick a step whose check did not pass. If a check could not run — something it',
    'needs is missing, or it would not start — leave the step unticked, keep its wording, and say why.',
    '',
    ...(last
      ? ['Then stop. The plan is complete at that point.']
      : [
          `Then stop. Build milestone ${milestone.number} and no further — the next one is a`,
          'separate decision, and not yours.',
        ]),
  ].join('\n');
}
