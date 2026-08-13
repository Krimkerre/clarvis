import * as vscode from 'vscode';
import { ModelService } from '../model/ModelService';
import { runInterview } from './Interview';
import { runAnalysis } from './Analysis';
import { collectVerdicts } from './Verdicts';
import { formatVerdict, FindingVerdict } from './verdictSummary';
import { renderPlan } from './PlanWriter';
import { InterviewState, openQuestions, readyToDraft } from './interviewTopics';
import { PlanningIO } from './PlanningIO';
import { handoffTask } from './handoff';
import { phrase } from '../personality/Voice';

/**
 * The whole planning milestone, end to end, independent of where it's driven from.
 *
 * Interview (M9a) → analysis (M9b) → verdicts (M9c) → draft, refine, approve, write
 * `plan.md` (M9d). Every question, menu and confirmation goes through `PlanningIO`,
 * so the same flow runs against input boxes from the command palette and against the
 * chat panel — the two front ends differ in `PlanningIO`, not here.
 *
 * The one thing still reached for directly is `vscode.workspace.fs`: writing
 * `plan.md` is the same act whoever asked for it, and routing a file write through a
 * conversation abstraction would be indirection for its own sake.
 */

/** Written by the caller so the aside and the opening line stay in his voice. */
export interface PlanningLines {
  acknowledge(task: string): Promise<string | undefined>;
  afterTask(task: string, summary: string): Promise<string | undefined>;
}

/**
 * Handing an approved plan to the agent (M9e) — supplied by whoever can run one.
 *
 * Optional: the command-palette route has no run session of its own, and planning
 * that ends at a written plan is still a complete outcome. Where it exists, plan
 * mode flows into code mode without the user having to restate what was just agreed.
 */
export type StartBuild = (task: string) => Promise<void>;

/**
 * Whether it's fine to run the interview and eventually replace `plan.md` —
 * `true` when there's nothing there yet, or the user explicitly says to redo it.
 *
 * **Asked before the interview, not after it.** Found live: an unconditional "never
 * overwrite" meant a stale `plan.md` kept getting silently kept, run after run — and
 * asking at the end would waste every question and model call that led there.
 */
export async function okToReplaceExistingPlan(io: PlanningIO, log: (message: string) => void): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return true;

  const exists = await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, 'plan.md')).then(
    () => true,
    () => false
  );
  if (!exists) return true;

  const choice = await io.confirm(
    await phrase('ask', 'There is already a plan.md here. Someone was organised once.', ['plan.md']),
    await phrase('ask', 'Keep it untouched, or start over and replace it?', ['plan.md']),
    ['Keep Existing', 'Plan Again']
  );
  if (choice !== 'Plan Again') {
    log('planning: plan.md already exists here, kept as-is, interview skipped');
    return false;
  }
  log('planning: replacing existing plan.md — running the interview again');
  return true;
}

export async function runPlanning(
  models: ModelService,
  io: PlanningIO,
  lines: PlanningLines,
  log: (message: string) => void,
  startBuild?: StartBuild
): Promise<void> {
  if (!(await okToReplaceExistingPlan(io, log))) return;

  const opening = await lines.acknowledge('plan this project');
  if (opening) await io.say(opening);

  const result = await runInterview(models, io, log);
  if (!result) return;

  const { state, seed } = result;
  const summary = summaryLines(state, seed);

  let verdicts: FindingVerdict[] = [];
  let noPlanNeeded: string | undefined;

  if (readyToDraft(state)) {
    const analysis = await runAnalysis(models, state, log);
    noPlanNeeded = analysis.noPlanNeeded;
    if (noPlanNeeded) {
      summary.push('', '## Analysis', `This may not need a plan: ${noPlanNeeded}`);
    } else if (analysis.findings.length > 0) {
      verdicts = await collectVerdicts(analysis.findings, io, log);
      summary.push('', '## Analysis');
      for (const verdict of verdicts) summary.push(...formatVerdict(verdict));
    }
  }

  const approved = readyToDraft(state) && !noPlanNeeded
    ? await draftAndApprovePlan(state, seed, verdicts, io, lines, log)
    : false;

  // Logged, not just shown. An untitled document exists only until the tab closes or
  // VS Code restarts — a two-minute interview producing an artifact neither the user
  // nor a later "check the log" request could recover was found the first time this
  // ran live.
  log(`planning summary:\n${summary.join('\n')}`);
  await io.showDocument(summary.join('\n'));

  // The aside, same rule as everywhere else it appears: separate from the summary,
  // never folded into it, so the document stays trustworthy and the joke stays a
  // joke. Said, not written into the document — it is a remark about the moment, not
  // part of the plan.
  const aside = await lines.afterTask('plan this project', summary.join('\n'));
  if (aside) await io.say(aside);

  // **Plan mode flows into code mode** (M9e): the plan was just approved, milestone
  // one is right there, and making the user restate it as a fresh request would be
  // the seam §0's two-mode discipline exists to make invisible. Still asked — the
  // sign-off gate is on writing the plan, and starting to build is its own decision.
  if (approved && startBuild) await offerToBuild(state, seed, verdicts, io, log, startBuild);
}

/**
 * Offers to start building milestone one, with the prompt shown before it runs.
 *
 * §4.9: the handoff prompt is **shown to the user and editable before it runs** —
 * not a hidden prompt. Declining leaves the plan exactly where it is; nothing about
 * planning depends on the agent being asked to act on it.
 */
async function offerToBuild(
  state: InterviewState,
  seed: string,
  verdicts: FindingVerdict[],
  io: PlanningIO,
  log: (message: string) => void,
  startBuild: StartBuild
): Promise<void> {
  const task = handoffTask(state, seed, verdicts);

  const choice = await io.confirm(
    await phrase('ask', 'Plan approved. Shall I go and build the first milestone, then?', []),
    `${await phrase('report', 'This is what I would be handing myself:', [])}\n\n${task}`,
    ['Start Building', 'Edit The Task First', 'Not Yet']
  );
  if (!choice || choice === 'Not Yet') {
    log('planning: handoff declined, plan.md written and left at that');
    return;
  }

  let finalTask = task;
  if (choice === 'Edit The Task First') {
    const edited = await io.askText(
      await phrase('ask', 'The task, as it will be given to the agent:', []),
      task
    );
    if (!edited?.trim()) {
      log('planning: handoff edit cancelled, nothing started');
      return;
    }
    finalTask = edited.trim();
  }

  log(`planning: handing milestone 1 to the agent\n${finalTask}`);
  await startBuild(finalTask);
}

/** What was established and what is still open, as the summary document's lines. */
function summaryLines(state: InterviewState, seed: string): string[] {
  const settled = state.answers.filter((answer) => answer.text);
  const open = openQuestions(state);

  const lines = [
    state.projectName ? `# ${state.projectName}` : `# Interview — ${seed}`,
    ...(state.projectName ? [`*${seed}*`] : []),
    '',
    readyToDraft(state)
      ? 'Enough to draft.'
      : 'Paused — start planning again to pick this up. (Nothing is saved between sessions yet.)',
    '',
    '## Established',
    ...settled.flatMap((answer) =>
      answer.reasoning
        ? [`- **${answer.topic}**: ${answer.text}`, `  Reasoning: ${answer.reasoning}`]
        : [`- **${answer.topic}**: ${answer.text}`]
    ),
  ];

  if (open.length > 0) {
    lines.push('', '## Open questions', ...open.map((answer) => `- ${answer.topic} — not yet known`));
  }

  return lines;
}

/**
 * Drafts `plan.md`, shows it, and lets the user refine or approve before it's
 * written (M9d) — Claude Code's own plan-mode shape: present a draft, iterate on it,
 * gate the actual write behind an explicit approval rather than writing the moment
 * there's enough to draft.
 *
 * **Refining adds a note and redraws, nothing more.** No re-interrogation, no
 * re-running analysis — a "keep refining" loop that reopened the whole Q&A would be
 * exactly the interrogation this interview has avoided since M9a. The note becomes a
 * `## Notes` line in the redrawn plan, and the loop shows it again.
 */
async function draftAndApprovePlan(
  state: InterviewState,
  seed: string,
  verdicts: FindingVerdict[],
  io: PlanningIO,
  lines: PlanningLines,
  log: (message: string) => void
): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return false;

  const planUri = vscode.Uri.joinPath(folder.uri, 'plan.md');
  let firstDraft = true;
  for (;;) {
    const planText = renderPlan({ projectName: state.projectName, seed, state, verdicts });
    await io.showDocument(planText);

    if (firstDraft) {
      firstDraft = false;
      const draftLine = await lines.acknowledge('look over a plan draft');
      if (draftLine) await io.say(draftLine);
    }

    const choice = await io.confirm(
      await phrase('ask', 'There it is. Read it before you agree to it.', []),
      await phrase(
        'ask',
        'Approve writes plan.md. Keep refining lets you add anything missing first.',
        ['plan.md', 'Approve']
      ),
      ['Approve', 'Keep Refining']
    );

    if (choice !== 'Keep Refining') {
      if (choice === 'Approve') {
        await vscode.workspace.fs.writeFile(planUri, Buffer.from(planText, 'utf8'));
        log(`planning: wrote plan.md\n${planText}`);
        const written = await vscode.workspace.openTextDocument(planUri);
        await vscode.window.showTextDocument(written, { preview: false });
        return true;
      }
      log('planning: draft not approved, plan.md not written');
      return false;
    }

    const note = await io.askText(await phrase('ask', 'What should be added or changed?', []));
    if (note?.trim()) {
      state.notes = [...(state.notes ?? []), note.trim()];
      log(`planning: refinement note — ${note.trim()}`);
    }
  }
}
