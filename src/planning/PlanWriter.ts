import { branchFlowSection } from '../agent/branchFlow';
import { InterviewState, TopicId } from './interviewTopics';
import { FindingVerdict } from './verdictSummary';

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

function answerText(state: InterviewState, topic: TopicId): string | undefined {
  return state.answers.find((answer) => answer.topic === topic)?.text;
}

function section(heading: string, body: string | undefined): string {
  return [heading, '', body ?? '_Not yet determined._'].join('\n');
}

export function renderPlan({ projectName, seed, state, verdicts }: PlanInput): string {
  const title = projectName ?? seed;
  const language = state.answers.find((answer) => answer.topic === 'language');
  const accepted = verdicts.filter((verdict) => verdict.status !== 'rejected');
  const rejected = verdicts.filter((verdict) => verdict.status === 'rejected');
  const open = state.answers.filter((answer) => answer.text === undefined);

  return [
    `# ${title}`,
    ...(projectName ? [`*${seed}*`] : []),
    '',
    '---',
    '',
    WORKING_PROCESS_SECTION,
    '',
    '---',
    '',
    section('## 1. Concept', answerText(state, 'what-it-does')),
    '',
    section('## 2. Where it runs', answerText(state, 'who-and-where')),
    '',
    section(
      '## 3. Language',
      language?.text ? `**${language.text}**${language.reasoning ? ` — ${language.reasoning}` : ''}` : undefined
    ),
    '',
    section('## 4. Scope', answerText(state, 'scope')),
    '',
    section('## 5. Data', answerText(state, 'data')),
    '',
    section('## 6. Linter', answerText(state, 'linter')),
    '',
    '## 7. Milestone 1 — v1',
    '',
    '**Exit checklist:**',
    ...(answerText(state, 'definition-of-done') ? [`- [ ] ${answerText(state, 'definition-of-done')}`] : []),
    ...accepted.map((verdict) => `- [ ] ${verdict.finding.suggestedResolution}`),
    ...(answerText(state, 'definition-of-done') || accepted.length > 0 ? [] : ['_Not yet determined._']),
    '',
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
