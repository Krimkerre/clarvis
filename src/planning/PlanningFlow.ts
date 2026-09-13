import * as vscode from 'vscode';
import { ModelService } from '../model/ModelService';
import { runInterview } from './Interview';
import { researchWorkspace } from './workspaceResearch';
import { describeProgress, worthResuming } from './interviewStore';
import { PLANNING_PAUSED_LINE, PlanningIO, PlanningPaused } from './PlanningIO';
import { GatheredInterview, InterviewMemory, PlanningLines, settlePlanning, StartBuild } from './planReview';
import { phrase } from '../personality/Voice';
import { GitFacts } from '../engine/checkpoint/gitFacts';

/**
 * The whole planning milestone, end to end, independent of where it's driven from.
 *
 * Interview (M9a) → analysis (M9b) → verdicts (M9c) → draft, refine, approve, write
 * `plan.md` (M9d) → the offer to build (M9e). Every question, menu and confirmation goes
 * through `PlanningIO`, so the same flow runs against input boxes from the command palette
 * and against the chat panel — the two front ends differ in `PlanningIO`, not here.
 *
 * **This file is the half that needs `vscode`:** where a sitting starts, what the workspace
 * says about itself, and where plan.md is written. Everything after the interview is
 * `planReview.ts`, which never imports it, so the half with the decisions in it runs under
 * `node --test` (M9i).
 */

/**
 * The branch the open folder's repository is on, for the plan's branch flow.
 *
 * Undefined with no folder, no repository or a detached HEAD, and when git itself fails —
 * the plan then falls back to declaring `main`, which is no worse than before.
 */
async function currentBranch(): Promise<string | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  try {
    return (await new GitFacts(root).head()).branch;
  } catch {
    return undefined;
  }
}

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
 * How a sitting starts, when that was settled somewhere else.
 *
 * `'carry-on'`: chat offered the resume at startup and the answer was yes.
 * `{ brief }`: a task handed over from NERVIS (E-C8) — a fresh interview whose first
 * answer waits pre-typed in the box, for the person to change or send as it is.
 */
export type PlanningStart = 'carry-on' | { brief: string };

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
   *
   * Or a task handed over from NERVIS, which starts a fresh interview with the task
   * waiting in the first answer box — see `PlanningStart`.
   */
  decided?: PlanningStart
): Promise<void> {
  try {
    // **Offered before anything else, including the plan.md question.** Someone
    // halfway through an interview does not want to be asked whether to replace a
    // plan that does not exist yet.
    const gathered = await gatherAnswers(models, io, lines, log, memory, decided);
    // A paused interview keeps its snapshot: cancelling is not abandoning, and the
    // next window should still offer to carry on.
    if (!gathered) return;
    await settlePlanning({ models, io, lines, log, startBuild, memory, writePlan: planWriter(io, log), currentBranch }, gathered);
  } catch (error) {
    if (!(error instanceof PlanningPaused)) throw error;
    // **Stopped is not finished (M9i).** Nothing on screen was decided, nothing was started,
    // and the saved interview — with its draft, once there is one — stays for the next sitting.
    // In chat the stop has already been answered and this line goes nowhere; in the command
    // palette, where Escape is the stop, this is the only place it can be said.
    log('planning: paused — nothing on screen decided, nothing started');
    await io.say(PLANNING_PAUSED_LINE);
  }
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
  decided?: PlanningStart
): Promise<GatheredInterview | undefined> {
  const { resume, stop } = await offerResume(io, log, memory, decided);
  if (stop) return undefined;

  if (!resume && !(await okToReplaceExistingPlan(io, log))) return undefined;

  if (!resume) {
    const opening = await lines.acknowledge('plan this project');
    if (opening) await io.say(opening);
  }

  // Read here rather than inside the interview: `researchWorkspace` needs `vscode`, and
  // importing it there put all of `Interview.ts` out of reach of `node --test`.
  const answers = await runInterview(models, io, log, {
    remember: memory ? (state, seed) => memory.save(state, seed) : undefined,
    resume,
    brief: typeof decided === 'object' ? decided.brief : undefined,
    workspace: await researchWorkspace(),
  });
  // A draft left at the approve gate comes back with the interview it was drafted from (M9i).
  return answers && { ...answers, draft: resume?.draft };
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
  decided?: PlanningStart
): Promise<{ resume?: GatheredInterview; stop?: boolean }> {
  const snapshot = memory?.load();
  if (!snapshot || !worthResuming(snapshot, Date.now())) return {};

  // Asked and answered upstairs. Asking again is how a resume offer becomes two
  // identical questions in a row, which reads as the product not listening.
  if (decided === 'carry-on') {
    log(`planning: resuming an interview — ${describeProgress(snapshot)}`);
    return { resume: { state: snapshot.state, seed: snapshot.seed, draft: snapshot.draft } };
  }

  const choice = await io.confirm(
    await phrase('ask', 'We were part-way through planning something.', []),
    `${describeProgress(snapshot)}. Carry on from there, throw it away and start fresh, or leave it for now?`,
    ['Carry on', 'Start again', 'Leave it']
  );

  if (choice === 'Carry on') {
    log(`planning: resuming an interview — ${describeProgress(snapshot)}`);
    return { resume: { state: snapshot.state, seed: snapshot.seed, draft: snapshot.draft } };
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
 * How the approved plan reaches disk — or `undefined` when there is no folder to write it
 * into, where planning ends at its summary as it always has.
 *
 * The draft goes before the file arrives, not after: two tabs holding the same plan, one of
 * them editable and one of them not the file, is how someone spends ten minutes improving
 * the document that gets thrown away.
 */
function planWriter(io: PlanningIO, log: (message: string) => void): ((text: string) => Promise<void>) | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;

  const planUri = vscode.Uri.joinPath(folder.uri, 'plan.md');
  return async (text) => {
    await vscode.workspace.fs.writeFile(planUri, Buffer.from(text, 'utf8'));
    log(`planning: wrote plan.md\n${text}`);
    await io.closeDocument();
    const written = await vscode.workspace.openTextDocument(planUri);
    await vscode.window.showTextDocument(written, { preview: false });
  };
}
