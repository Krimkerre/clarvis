import { ModelService } from '../model/ModelService';
import { phrase } from '../personality/Voice';
import { planMilestone, revisePlan, runAnalysis } from './Analysis';
import { BUILD_OFFER_QUESTION, handoffTask, PlanBacking } from './handoff';
import { InterviewSnapshot } from './interviewStore';
import { InterviewState, openQuestions, readyToDraft } from './interviewTopics';
import { nextMilestoneTask } from './nextMilestoneTask';
import { PlanningIO, PlanningPaused } from './PlanningIO';
import { changedLine, conflictLine } from './planRevision';
import { buildBlocker, ChecklistStep, milestoneChecklist, planTitle, readMilestones } from './planUpdate';
import { renderPlan } from './PlanWriter';
import { collectVerdicts } from './Verdicts';
import { FindingVerdict, formatVerdict } from './verdictSummary';

/**
 * Planning after the interview: the review, the findings, the milestones, the draft and its
 * approval, and the offer to build (M9b–M9e, reworked by M9i).
 *
 * **No `vscode` here, on purpose.** Writing plan.md is handed in, so this whole stretch —
 * where feedback is applied, a stop is honoured, and a review that failed is told apart from
 * one that found nothing — runs under `node --test` against a scripted person and a scripted
 * model. It could not while it lived in `PlanningFlow.ts`, and every defect M9i fixes lived
 * in it untested.
 */

/** Written by the caller so the aside and the opening line stay in his voice. */
export interface PlanningLines {
  acknowledge(task: string): Promise<string | undefined>;
  afterTask(task: string, summary: string): Promise<string | undefined>;
}

/**
 * Hands milestone one to the agent (M9e). The steps travel with the task so the panel can
 * show which one is in progress — the task text alone is prose to everything downstream of it.
 */
export type StartBuild = (task: string, steps: string[]) => Promise<void>;

/**
 * Where a half-finished interview is kept between windows. Supplied by the caller, which
 * owns the storage; planning owns what is worth keeping and when to offer it.
 */
export interface InterviewMemory {
  /** `draft`, once there is one, is the plan as it read at the approve gate (M9i). */
  save(state: InterviewState, seed: string, draft?: string): Promise<void>;
  load(): InterviewSnapshot | undefined;
  clear(): Promise<void>;
}

/** Everything a sitting needs once the interview is done, supplied by whoever runs it. */
export interface PlanningSession {
  models: ModelService;
  io: PlanningIO;
  lines: PlanningLines;
  log: (message: string) => void;
  /** Writes the approved plan.md and puts it in front of the reader. Absent when there is no folder to write into. */
  writePlan?: (text: string) => Promise<void>;
  /**
   * Optional: the command-palette route has no run session of its own, and planning that
   * ends at a written plan is still a complete outcome.
   */
  startBuild?: StartBuild;
  memory?: InterviewMemory;
}

/** What the interview established — and, for a sitting paused at the approve gate, its draft. */
export interface GatheredInterview {
  state: InterviewState;
  seed: string;
  draft?: string;
}

const APPROVE = 'Approve';
const KEEP_REFINING = 'Keep Refining';
const TRY_AGAIN = 'Try Again';
const GO_ON = 'Go On Without It';
const START = 'Start Building';
const EDIT_TASK = 'Edit The Task First';
const NOT_YET = 'Not Yet';

/**
 * Takes a finished interview to an outcome: a written plan and the offer to build it, the
 * no-plan brief, or — paused part-way through, or with nowhere to write a plan — its summary.
 *
 * **The saved interview is dropped only on an outcome**: the plan was written, or there was
 * no plan to write. It used to go the moment the questions ran out, and a reload at the
 * approve gate threw away the review, the findings and the draft (19 Aug). A stop is not an
 * outcome either — `PlanningPaused` passes straight through, and the snapshot stays.
 */
export async function settlePlanning(session: PlanningSession, gathered: GatheredInterview): Promise<void> {
  const { state, seed } = gathered;
  const summary = summaryLines(state, seed);
  const drafted = readyToDraft(state) ? (gathered.draft ?? (await draftPlan(session, state, seed, summary))) : undefined;

  if (typeof drafted === 'string' && session.writePlan) {
    const plan = await approveDraft(session, gathered, drafted);
    await session.writePlan(plan);
    await session.memory?.clear();
    // Logged, not shown: plan.md is the document now, and the summary opened beside it as a
    // second untitled tab was one more thing to mistake for the plan (M9i).
    session.log(`planning summary:\n${summary.join('\n')}`);
    await sayAside(session, summary);
    await offerPlannedBuild(session, plan);
    return;
  }

  if (typeof drafted === 'object') {
    await session.memory?.clear();
    await showSummary(session, summary);
    await sayAside(session, summary);
    await offerToStart(session, 'no-plan', handoffTask(state, seed, []), []);
    return;
  }

  await showSummary(session, summary);
  await sayAside(session, summary);
}

/**
 * The review, the findings and the milestones, drawn up as the first draft — or the reason
 * `NO-PLAN-NEEDED` gave, when the review said a plan would be ceremony.
 */
async function draftPlan(
  session: PlanningSession,
  state: InterviewState,
  seed: string,
  summary: string[]
): Promise<string | { noPlanNeeded: string }> {
  const { io, log, models } = session;

  const analysis = await untilFinished(session, 'gap review', () => runAnalysis(models, state, log));
  if (analysis.noPlanNeeded) {
    summary.push('', '## Analysis', `This may not need a plan: ${analysis.noPlanNeeded}`);
    return { noPlanNeeded: analysis.noPlanNeeded };
  }

  const verdicts = analysis.findings.length > 0 ? await collectVerdicts(analysis.findings, io, log) : [];
  summary.push(...analysisSummary(verdicts, analysis.problem));

  // The build steps, written before the draft is shown — a plan whose milestone is empty is
  // not a plan anyone can approve, and it is what the agent reads next. The accepted findings
  // go in with them: a fix the user just agreed to is part of building, not a note beside it.
  // The model decides which are work and which are only questions — folding all of them in is
  // what emptied milestone one before.
  const planned = await untilFinished(session, 'milestone plan', () =>
    planMilestone(
      models,
      state,
      log,
      verdicts.filter((verdict) => verdict.status !== 'rejected'),
      // **Rejections travel too.** They used to be filtered out here, so the planner never
      // learned a decision had been made and planned the rejected thing anyway — F5, found live.
      verdicts.filter((verdict) => verdict.status === 'rejected')
    )
  );

  return renderPlan({
    projectName: state.projectName,
    seed,
    state,
    verdicts,
    milestones: planned.milestones,
    reviewProblem: analysis.problem,
    milestonesProblem: planned.problem,
  });
}

/** The summary's Analysis section: what was decided on each finding, and whether the review finished. */
function analysisSummary(verdicts: FindingVerdict[], problem: string | undefined): string[] {
  if (verdicts.length === 0 && !problem) return [];
  return ['', '## Analysis', ...(problem ? [`The gap review did not finish: ${problem}.`] : []), ...verdicts.flatMap(formatVerdict)];
}

/**
 * Runs one model-backed stage until it finishes, or the person chooses to go on without it (M9i).
 *
 * **A stage that did not finish used to look like one that found nothing.** Now the reason is
 * said and the call is theirs: try again — a local model that ran out of time once often does
 * not the second time — or go on, with the draft saying what is missing. With no model
 * configured there is nothing to try again with, so it is said once and planning goes on.
 */
async function untilFinished<T extends { problem?: string }>(
  session: PlanningSession,
  stage: string,
  attempt: () => Promise<T>
): Promise<T> {
  for (;;) {
    const result = await attempt();
    if (!result.problem) return result;

    if (!(await session.models.isReady('chat'))) {
      await session.io.say(`The ${stage} did not run: ${result.problem}. The draft says so.`);
      return result;
    }
    if ((await askToRetry(session.io, stage, result.problem)) === GO_ON) return result;
  }
}

/** Try Again, or Go On Without It. Anything else asks again; Escape pauses. */
async function askToRetry(io: PlanningIO, stage: string, problem: string): Promise<string> {
  for (;;) {
    const choice = await io.confirm(
      await phrase('ask', `The ${stage} did not finish.`, [stage]),
      `It stopped because ${problem}. Try it again, or go on without it — the draft will say what is missing.`,
      [TRY_AGAIN, GO_ON]
    );
    if (!choice) throw new PlanningPaused();
    if (choice === TRY_AGAIN || choice === GO_ON) return choice;
  }
}

/**
 * Shows the draft and takes it back, edits and all, until it is approved (M9d, reworked by M9i).
 *
 * **One revision, and it is the one on screen.** The draft is read back before every decision,
 * so a hand edit is part of what gets approved, and Approve returns exactly what was read.
 * Typed feedback — Keep Refining, or anything said at the gate that is not one of its buttons —
 * is applied to that same text, never appended as a note beside it.
 *
 * Saved with the interview every round and again on a stop, so a paused sitting comes back to
 * this draft rather than to a fresh review.
 */
async function approveDraft(session: PlanningSession, gathered: GatheredInterview, initial: string): Promise<string> {
  const { io, memory } = session;
  const { state, seed } = gathered;
  // A sitting carried on in the same window may still have the draft open, edited while it was paused.
  let revision = gathered.draft === undefined ? initial : ((await io.readDocument()) ?? initial);

  try {
    await showFirstDraft(session, revision);
    for (;;) {
      await memory?.save(state, seed, revision);
      const choice = await io.confirm(
        await phrase('ask', 'There it is. Read it before you agree to it.', []),
        await phrase(
          'ask',
          'Approve writes plan.md exactly as the draft reads, your own edits included. Keep refining, or just say what should change.',
          ['plan.md', 'Approve']
        ),
        [APPROVE, KEEP_REFINING]
      );
      revision = (await io.readDocument()) ?? revision;
      if (choice === APPROVE) return revision;

      revision = await refine(session, revision, choice);
      await io.showDocument(revision);
    }
  } catch (error) {
    if (error instanceof PlanningPaused) await memory?.save(state, seed, (await io.readDocument()) ?? revision);
    throw error;
  }
}

/** The draft, and the one line that goes with seeing it for the first time. */
async function showFirstDraft(session: PlanningSession, draft: string): Promise<void> {
  await session.io.showDocument(draft);
  const line = await session.lines.acknowledge('look over a plan draft');
  if (line) await session.io.say(line);
}

/**
 * What was said at the gate, applied to the draft.
 *
 * Keep Refining asks what should change. Anything else said there *is* what should change
 * (M9i) — it used to end planning, unapproved, with the draft replaced by the summary.
 */
async function refine(session: PlanningSession, revision: string, choice: string | undefined): Promise<string> {
  if (!choice) throw new PlanningPaused();
  const feedback = choice === KEEP_REFINING ? await session.io.askText(await phrase('ask', 'What should change?', [])) : choice;
  if (feedback === undefined) throw new PlanningPaused();
  return feedback.trim() ? applyFeedback(session, feedback.trim(), revision) : revision;
}

/**
 * One piece of feedback, applied to the draft as it reads now (M9i).
 *
 * **A hand edit made while the model works wins.** The revision was written against the text
 * read before the call; splicing it into a draft that has changed since would quietly undo
 * whatever was typed in the meantime. So it is not applied, and that is said, with the words
 * to say again.
 */
async function applyFeedback(session: PlanningSession, feedback: string, fallback: string): Promise<string> {
  const { io, log, models } = session;
  const base = (await io.readDocument()) ?? fallback;
  const revision = await revisePlan(models, base, feedback, log);

  const now = (await io.readDocument()) ?? base;
  if (now !== base) {
    log('planning: the draft was edited while it was being revised — kept the edit, revision not applied');
    await io.say(conflictLine(feedback));
    return now;
  }

  if ('unchanged' in revision) {
    await io.say(revision.unchanged);
    return base;
  }
  await io.say(changedLine(revision));
  return revision.text;
}

/**
 * Offers to build milestone one of the plan just written, read from that plan (M9i).
 *
 * **From the written plan.md, not from the interview.** The task and its steps used to be
 * assembled from the interview's answers and the milestones as generated, so feedback applied
 * to the plan, and steps deleted from it by hand, never reached the agent. `nextMilestoneTask`
 * is how every later milestone is handed over, and now the first is too.
 *
 * **Only a milestone that can be built and checked is offered** — see `buildBlocker`.
 */
async function offerPlannedBuild(session: PlanningSession, plan: string): Promise<void> {
  if (!session.startBuild) return;

  const milestones = readMilestones(plan);
  const first = milestones[0];
  const checklist = first ? milestoneChecklist(plan, first.number) : [];
  const blocked = buildBlocker(checklist);

  if (!first || blocked) {
    session.log(`planning: no build offered — ${blocked}`);
    await session.io.say(`plan.md is written. ${blocked}`);
    return;
  }

  await offerToStart(
    session,
    'plan',
    nextMilestoneTask(first, planTitle(plan), milestones),
    checklist.map((entry) => entry.step),
    uncheckedNote(checklist)
  );
}

/** The steps that carry no check, named under the task so nobody finds out after the build. */
function uncheckedNote(checklist: ChecklistStep[]): string {
  const unchecked = checklist.filter((entry) => !entry.hasCheck);
  return unchecked.length === 0
    ? ''
    : `\n\nNo check yet, so nothing will show these work:\n${unchecked.map((entry) => `- ${entry.step}`).join('\n')}`;
}

/**
 * Offers to start building, with the task shown before it runs (M9e).
 *
 * §4.9: the handoff prompt is **shown to the user and editable before it runs** — not a
 * hidden prompt. Declining leaves the plan exactly where it is; nothing about planning
 * depends on the agent being asked to act on it.
 *
 * **Only Start Building starts it (M9i).** Any reply other than Not Yet used to start the
 * build — "what's in milestone one?" among them. Starting a build is the consequential step
 * here, so a reply that is not one of the three starts nothing, and the question comes back.
 */
async function offerToStart(
  session: PlanningSession,
  backing: PlanBacking,
  task: string,
  steps: string[],
  note = ''
): Promise<void> {
  const { io, log } = session;
  if (!session.startBuild) return;

  for (;;) {
    const choice = await io.confirm(
      await phrase('ask', BUILD_OFFER_QUESTION[backing], []),
      // **The situation, because the line is only a lead-in.** Given nothing but the colon,
      // one rewrite finished the sentence with an invented thought and another complained
      // there was nothing to rewrite (13 September 2026).
      `${await phrase(
        'report',
        'This is what I would be handing myself:',
        [],
        'this line introduces the build task, which is shown in full directly below it'
      )}\n\n${task}${note}`,
      [START, EDIT_TASK, NOT_YET]
    );
    if (!choice || choice === NOT_YET) {
      log('planning: handoff declined, nothing started');
      return;
    }
    if (choice === START || choice === EDIT_TASK) {
      await startOrEdit(session, choice, task, steps);
      return;
    }
    log(`planning: "${choice}" is not one of the build offer's answers — nothing started, asked again`);
    await io.say('Nothing started. Start Building begins it, Edit The Task First lets you change the task, and Not Yet leaves it.');
  }
}

/** Starts the build, or lets the task be edited first and then starts that. */
async function startOrEdit(session: PlanningSession, choice: string, task: string, steps: string[]): Promise<void> {
  const { io, log } = session;
  let finalTask = task;

  if (choice === EDIT_TASK) {
    const edited = await io.askText(await phrase('ask', 'The task, as it will be given to the agent:', []), task);
    if (!edited?.trim()) {
      log('planning: handoff edit cancelled, nothing started');
      return;
    }
    finalTask = edited.trim();
  }

  log(`planning: handing milestone 1 to the agent\n${finalTask}`);
  await session.startBuild?.(finalTask, steps);
}

/**
 * The summary, logged and shown, for a sitting that ends without a plan to open.
 *
 * Logged, not just shown. An untitled document exists only until the tab closes or VS Code
 * restarts — a two-minute interview producing an artifact neither the user nor a later
 * "check the log" request could recover was found the first time this ran live.
 */
async function showSummary(session: PlanningSession, summary: string[]): Promise<void> {
  session.log(`planning summary:\n${summary.join('\n')}`);
  await session.io.showDocument(summary.join('\n'));
}

/**
 * The aside, same rule as everywhere else it appears: separate from the summary, never
 * folded into it, so the document stays trustworthy and the joke stays a joke. Said, not
 * written into the document — it is a remark about the moment, not part of the plan.
 */
async function sayAside(session: PlanningSession, summary: string[]): Promise<void> {
  const aside = await session.lines.afterTask('plan this project', summary.join('\n'));
  if (aside) await session.io.say(aside);
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
