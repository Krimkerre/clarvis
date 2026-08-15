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
 */
export function nextMilestoneTask(milestone: MilestoneState, projectName: string): string {
  return [
    `Continue building ${projectName}, following the approved plan.md in this workspace.`,
    '',
    `Milestone ${milestone.number} — ${milestone.title}.`,
    '',
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
    '',
    `Then stop. Build milestone ${milestone.number} and no further — the next one is a`,
    'separate decision, and not yours.',
  ].join('\n');
}
