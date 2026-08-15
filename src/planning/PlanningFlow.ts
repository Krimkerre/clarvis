import * as vscode from 'vscode';
import { ModelService } from '../model/ModelService';
import { runInterview } from './Interview';
import { planMilestone, runAnalysis } from './Analysis';
import { collectVerdicts } from './Verdicts';
import { formatVerdict, FindingVerdict } from './verdictSummary';
import { renderPlan } from './PlanWriter';
import { InterviewState, openQuestions, readyToDraft } from './interviewTopics';
import { describeProgress, InterviewSnapshot, worthResuming } from './interviewStore';
import { PlanningIO } from './PlanningIO';
import { handoffTask } from './handoff';
import { Milestone } from './milestonePrompt';
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
/**
 * Hands milestone one to the agent. The steps travel with the task so the panel can
 * show which one is in progress — the task text alone is prose to everything
 * downstream of it.
 */
export type StartBuild = (task: string, steps: string[]) => Promise<void>;

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

/**
 * Where a half-finished interview is kept between windows. Supplied by the caller,
 * which owns the storage; planning owns what is worth keeping and when to offer it.
 */
export interface InterviewMemory {
  save(state: InterviewState, seed: string): Promise<void>;
  load(): InterviewSnapshot | undefined;
  clear(): Promise<void>;
}

export async function runPlanning(
  models: ModelService,
  io: PlanningIO,
  lines: PlanningLines,
  log: (message: string) => void,
  startBuild?: StartBuild,
  memory?: InterviewMemory,
  /**
   * Already decided elsewhere, so it is not asked twice.
   *
   * Chat now offers the resume at startup — that is where someone reopening a window
   * actually is — and hands the answer down rather than letting this ask again two
   * seconds later.
   */
  decided?: 'carry-on'
): Promise<void> {
  // **Offered before anything else, including the plan.md question.** Someone
  // halfway through an interview does not want to be asked whether to replace a
  // plan that does not exist yet.
  const result = await gatherAnswers(models, io, lines, log, memory, decided);
  // A paused interview keeps its snapshot: cancelling is not abandoning, and the
  // next window should still offer to carry on.
  if (!result) return;
  await memory?.clear();

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

  // The build steps, written before the draft is shown — a plan whose milestone is
  // empty is not a plan anyone can approve, and it is what the agent reads next.
  // The accepted findings go in with them: a fix the user just agreed to is part of
  // building, not a note beside it. The model decides which are work and which are
  // only questions — folding all of them in is what emptied milestone one before.
  const milestones =
    readyToDraft(state) && !noPlanNeeded
      ? await planMilestone(models, state, log, verdicts.filter((verdict) => verdict.status !== 'rejected'))
      : [];

  const approved = readyToDraft(state) && !noPlanNeeded
    ? await draftAndApprovePlan(state, seed, verdicts, milestones, io, lines, log)
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
  if (approved && startBuild) await offerToBuild(state, seed, verdicts, milestones, io, log, startBuild);
}

/**
 * Everything before the analysis: resume or start, and then the interview itself.
 *
 * Split out because it is the one stretch with three ways to not happen — leave the
 * old interview alone, keep the existing plan, or cancel mid-question — and folding
 * those into the main flow made it unreadable.
 */
async function gatherAnswers(
  models: ModelService,
  io: PlanningIO,
  lines: PlanningLines,
  log: (message: string) => void,
  memory?: InterviewMemory,
  decided?: 'carry-on'
): Promise<{ state: InterviewState; seed: string } | undefined> {
  const { resume, stop } = await offerResume(io, log, memory, decided);
  if (stop) return undefined;

  if (!resume && !(await okToReplaceExistingPlan(io, log))) return undefined;

  if (!resume) {
    const opening = await lines.acknowledge('plan this project');
    if (opening) await io.say(opening);
  }

  return runInterview(models, io, log, memory ? (state, seed) => memory.save(state, seed) : undefined, resume);
}

/**
 * Offers to carry on a half-finished interview, if there is one worth carrying on.
 *
 * Declining clears it. An offer that keeps coming back after "no" is the nagging
 * §6 exists to prevent, and a snapshot nobody wants is not worth a second question.
 */
async function offerResume(
  io: PlanningIO,
  log: (message: string) => void,
  memory?: InterviewMemory,
  decided?: 'carry-on'
): Promise<{ resume?: { state: InterviewState; seed: string }; stop?: boolean }> {
  const snapshot = memory?.load();
  if (!snapshot || !worthResuming(snapshot, Date.now())) return {};

  // Asked and answered upstairs. Asking again is how a resume offer becomes two
  // identical questions in a row, which reads as the product not listening.
  if (decided === 'carry-on') {
    log(`planning: resuming an interview — ${describeProgress(snapshot)}`);
    return { resume: { state: snapshot.state, seed: snapshot.seed } };
  }

  const choice = await io.confirm(
    await phrase('ask', 'We were part-way through planning something.', []),
    `${describeProgress(snapshot)}. Carry on from there, throw it away and start fresh, or leave it for now?`,
    ['Carry on', 'Start again', 'Leave it']
  );

  if (choice === 'Carry on') {
    log(`planning: resuming an interview — ${describeProgress(snapshot)}`);
    return { resume: { state: snapshot.state, seed: snapshot.seed } };
  }

  if (choice === 'Start again') {
    log('planning: unfinished interview thrown away, starting fresh');
    await memory?.clear();
    return {};
  }

  // **Escape means "not now", not "delete it".** Cancelling used to discard the
  // interview *and* start a new one — two decisions out of one keypress, and the
  // destructive half was the one nobody chose.
  log('planning: unfinished interview left where it is');
  return { stop: true };
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
  milestones: Milestone[],
  io: PlanningIO,
  log: (message: string) => void,
  startBuild: StartBuild
): Promise<void> {
  // Milestone one, and only milestone one: the rest of the plan is written down and
  // waiting, and starting the next is its own decision after this one lands.
  const first = milestones[0];
  const task = handoffTask(
    state,
    seed,
    verdicts,
    first ? { current: first, number: 1, total: milestones.length } : undefined
  );

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
  await startBuild(finalTask, first ? first.steps.map((step) => step.step) : []);
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
  milestones: Milestone[],
  io: PlanningIO,
  lines: PlanningLines,
  log: (message: string) => void
): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return false;

  const planUri = vscode.Uri.joinPath(folder.uri, 'plan.md');
  let firstDraft = true;
  for (;;) {
    const planText = renderPlan({ projectName: state.projectName, seed, state, verdicts, milestones });
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
        // The draft goes before the file arrives, not after: two tabs holding the
        // same plan, one of them editable and one of them not the file, is how
        // someone spends ten minutes improving the document that gets thrown away.
        await io.closeDocument();
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
