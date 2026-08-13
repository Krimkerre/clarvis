import { branchFlowSection } from '../agent/branchFlow';
import { Answer, InterviewState, TopicId } from './interviewTopics';
import { FindingVerdict } from './verdictSummary';
import { Milestone } from './milestonePrompt';
import { conventionsSection, parseCommentStyle } from './conventions';

/**
 * Renders a finished interview + its analysis verdicts into `plan.md` (M9d — §4.9).
 *
 * Pure and `vscode`-free, same discipline as everywhere else in M9: this is the part
 * worth testing without a workspace. `extension.ts` is the thin glue that checks
 * whether `plan.md` already exists and writes the file.
 *
 * **Only what was actually said.** No section here invents content the interview
 * didn't establish — an unanswered topic renders as "Not yet determined," the same
 * honesty rule as everywhere else in this project.
 */

export interface PlanInput {
  projectName?: string;
  seed: string;
  state: InterviewState;
  verdicts: FindingVerdict[];
  /** The milestones, in build order. Empty means none could be written. */
  milestones?: Milestone[];
}

/**
 * §0 of this project's own `plan.md`, inherited by every project Clarvis plans —
 * Plan Mode / Code Mode discipline is generic across languages, unlike the
 * clean-code rules (M9d2, not built yet), which need per-language adaptation before
 * they can be handed to a Python or Rust project without looking pasted-in.
 */
const WORKING_PROCESS_SECTION = [
  '## 0. Working Process — Plan Mode vs. Code Mode',
  '',
  'Building this project follows the same discipline this plan itself was built',
  'under: propose before you touch anything. Two modes, no blending.',
  '',
  '### Plan Mode (default)',
  '',
  'Agent and user brainstorm the roadmap together. **The only file the agent may',
  'write to is `plan.md`.** No project code gets created or edited in this mode, no',
  'matter how small.',
  '',
  '- **Sign-off gate.** The agent cannot write a single line of project code until',
  '  the user explicitly approves the plan. Silence is not approval.',
  '- **Gap analysis, not agreement.** The agent\'s job is to poke holes — surface',
  '  missing edge cases and open questions, not nod along.',
  '',
  '### Code Mode',
  '',
  'Entered only after sign-off. The agent builds piece by piece against the approved',
  'plan.',
  '',
  '- **`plan.md` becomes a live checklist.** Each milestone gets ticked off as it',
  '  completes.',
  '- Scope changes discovered mid-build kick back to Plan Mode — new gap analysis,',
  '  new sign-off — rather than growing silently inside Code Mode.',
].join('\n');

function findAnswer(state: InterviewState, topic: TopicId): Answer | undefined {
  return state.answers.find((answer) => answer.topic === topic);
}

function answerText(state: InterviewState, topic: TopicId): string | undefined {
  return findAnswer(state, topic)?.text;
}

/**
 * A section rendered with the question that produced it, not just the answer.
 *
 * Found live: a plan with only answers — "no GUI", "the most common ones" — reads as
 * vague once you're a few sections in, because half the meaning was in what was
 * actually asked. Showing the question restores that context for a later reader who
 * wasn't in the room for the interview.
 */
function section(heading: string, answer: Answer | undefined): string {
  if (!answer?.text) return [heading, '', '_Not yet determined._'].join('\n');
  return [heading, '', ...(answer.question ? [`**Asked:** ${answer.question}`, ''] : []), answer.text].join('\n');
}

export function renderPlan({ projectName, seed, state, verdicts, milestones = [] }: PlanInput): string {
  const title = projectName ?? seed;
  const language = state.answers.find((answer) => answer.topic === 'language');
  const accepted = verdicts.filter((verdict) => verdict.status !== 'rejected');
  const rejected = verdicts.filter((verdict) => verdict.status === 'rejected');
  const open = state.answers.filter((answer) => answer.text === undefined);

  return [
    `# ${title}`,
    ...(projectName ? [`*${seed}*`] : []),
    ...(state.workspaceContext ? [`*${state.workspaceContext}*`] : []),
    '',
    '---',
    '',
    WORKING_PROCESS_SECTION,
    '',
    '---',
    '',
    section('## 1. Concept', findAnswer(state, 'what-it-does')),
    '',
    section('## 2. Where it runs', findAnswer(state, 'who-and-where')),
    '',
    section(
      '## 3. Language',
      language?.text
        ? { ...language, text: `**${language.text}**${language.reasoning ? ` — ${language.reasoning}` : ''}` }
        : undefined
    ),
    '',
    section('## 4. Scope', findAnswer(state, 'scope')),
    '',
    section('## 5. Data', findAnswer(state, 'data')),
    '',
    section('## 6. Linter', findAnswer(state, 'linter')),
    '',
    // **The standard, not just the task list** (§4.9/M9d2). A plan that says how to
    // work and nothing about how to write leaves the agent building in whatever
    // style its model reaches for — which is the drift §0 exists to prevent, and
    // generated projects were inheriting only half of it.
    conventionsSection(answerText(state, 'language'), parseCommentStyle(answerText(state, 'comment-style'))),
    '',
    ...(state.notes && state.notes.length > 0 ? ['## Notes', '', ...state.notes.map((note) => `- ${note}`), ''] : []),
    '## 7. Milestones',
    '',
    ...(answerText(state, 'definition-of-done') ? [`**v1 is done when:** ${answerText(state, 'definition-of-done')}`, ''] : []),
    // **Every milestone, not only the first.** The plan used to hold exactly one, so
    // finishing it left the project with nowhere to go — a second interview over a
    // project that already had a plan. The numbering here is what `readMilestones`
    // reads back to decide which one is next, so the heading shape is load-bearing.
    //
    // Each step carries its check and a result line, written now and saying plainly
    // that it has not been run: a checklist with no space for the outcome is one
    // where "done" means "someone typed something".
    ...(milestones.length > 0
      ? milestones.flatMap((milestone, index) => [
          `### Milestone ${index + 1} — ${milestone.title}`,
          '',
          ...milestone.steps.flatMap((step) => [
            `- [ ] ${step.step}`,
            ...(step.check ? [`  - Check: ${step.check}`, '  - Result: not run yet'] : []),
          ]),
          '',
        ])
      : ['_No milestones written — planning could not reach a model._', '']),
    // The findings keep their own section — as the record of what was agreed and
    // why, not a second checklist. Whichever of them described actual work is
    // already above, folded into the steps in the order it belongs; the rest are
    // questions, and mixing questions into the work is what emptied the work.
    ...(accepted.length > 0
      ? [
          '**Agreed during review** — the actionable ones are in the steps above; the rest are still open:',
          ...accepted.map(
            (verdict) =>
              `- ${verdict.status === 'modified' ? (verdict.reasoning ?? verdict.finding.what) : verdict.finding.suggestedResolution}`
          ),
          '',
        ]
      : []),
    '## 8. Decisions',
    ...(rejected.length > 0
      ? rejected.map(
          (verdict) => `- **[${verdict.finding.class}]** ${verdict.finding.what} — rejected. ${verdict.reasoning ?? '(no reason given)'}`
        )
      : ['_None rejected._']),
    '',
    '## 9. Open Questions',
    ...(open.length > 0 ? open.map((answer) => `- ${answer.topic} — not yet known`) : ['_None._']),
    '',
    branchFlowSection('main'),
  ].join('\n');
}
