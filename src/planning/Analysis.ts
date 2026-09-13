import { ModelService } from '../model/ModelService';
import { InterviewState } from './interviewTopics';
import { AnalysisResult, analysisPrompt, analysisSystemPrompt, readAnalysis } from './analysisPrompt';
import { milestonePrompt, milestonesFrom, PlannedMilestones } from './milestonePrompt';
import { readRevision, Revision, revisionPrompt, revisionSystemPrompt, withNote } from './planRevision';
import { FindingVerdict } from './verdictSummary';
import { withDeadline } from '../model/deadline';
import { collect } from '../model/collect';

/**
 * Runs one analysis pass over a finished interview (M9b — §4.9).
 *
 * **Findings only, no verdicts.** Accept/reject/modify per finding (M9c) is a
 * separate, later piece — this ends by handing back what it found, same discipline
 * as M9a ending at "enough to draft" rather than reaching for the next milestone.
 *
 * **No model, no analysis.** Unlike a question, there is no honest written fallback
 * for "find the safety problems in this idea" — a canned finding would be exactly the
 * invented-fact failure `ONLY_WHAT_YOU_WERE_GIVEN` exists to prevent. A missing model is
 * reported as a review that did not run (M9i), and the draft says so.
 */

/** Longer than a single question — four passes over the whole interview in one call. */
const ANALYSIS_TIMEOUT_MS = 15000;

/** Four short findings comfortably fit; this is headroom, not a target. */
const MAX_RESPONSE_CHARS = 6000;

/**
 * A section or two of a plan rewritten, on a local model as well as a frontier one. A starting
 * value (M9i), to be measured live before anyone tunes it.
 */
const REVISION_TIMEOUT_MS = 30000;

/** Room for the milestones section and an answer or two. A reply cut off here is refused, never applied. */
const MAX_REVISION_CHARS = 12000;

/** Why a model-backed stage did not run, when there was no model to run it on. */
const NO_MODEL = 'there is no model configured to do it';

/** Why it did not finish when the call itself failed. The error goes to the log, not the conversation. */
const CALL_FAILED = 'the model call failed — the log has the details';

export async function runAnalysis(
  models: ModelService,
  state: InterviewState,
  log: (message: string) => void
): Promise<AnalysisResult> {
  if (!(await models.isReady('chat'))) {
    log('planning: analysis skipped — no model configured');
    return { findings: [], problem: NO_MODEL };
  }

  let timedOut = false;
  try {
    const text = await withDeadline(
      ANALYSIS_TIMEOUT_MS,
      (signal) =>
        collect(models, { system: analysisSystemPrompt(), messages: [{ role: 'user', content: analysisPrompt(state) }], signal }, MAX_RESPONSE_CHARS),
      () => '',
      () => {
        timedOut = true;
      }
    );

    const result = readAnalysis(text, timedOut);
    if (result.problem) log(`planning: analysis did not finish — ${result.problem}`);
    if (result.noPlanNeeded) {
      log(`planning: analysis — no plan needed: ${result.noPlanNeeded}`);
    } else {
      log(`planning: analysis — ${result.findings.length} finding(s)`);
      for (const finding of result.findings) {
        log(`planning: analysis [${finding.class}] ${finding.what} — ${finding.whyItMatters} — fix: ${finding.fixes.join(' | ')}`);
      }
    }
    return result;
  } catch (error) {
    log(`planning: analysis failed (${String(error)})`);
    return { findings: [], problem: CALL_FAILED };
  }
}

/**
 * The build steps for milestone one.
 *
 * **No model, no steps — and that is reported rather than papered over.** An empty
 * milestone is a visible hole in the plan; a fabricated one sends the agent to build
 * something nobody described, which is worse and much harder to notice.
 */
export async function planMilestone(
  models: ModelService,
  state: InterviewState,
  log: (message: string) => void,
  /** Findings the user accepted or rewrote — the actionable ones become steps. */
  accepted: FindingVerdict[] = [],
  /** Findings the user turned down, and why. Not planned, but not hidden either — F5. */
  rejected: FindingVerdict[] = []
): Promise<PlannedMilestones> {
  if (!(await models.isReady('chat'))) {
    log('planning: milestone — no model configured, no steps written');
    return { milestones: [], problem: NO_MODEL };
  }

  let timedOut = false;
  try {
    const text = await withDeadline(
      ANALYSIS_TIMEOUT_MS,
      (signal) =>
        collect(models, { system: analysisSystemPrompt(), messages: [{ role: 'user', content: milestonePrompt(state, accepted, rejected) }], signal }, MAX_RESPONSE_CHARS),
      () => '',
      () => {
        timedOut = true;
      }
    );

    const planned = milestonesFrom(text, timedOut);
    log(`planning: ${planned.milestones.length} milestone(s) planned${planned.problem ? ` — ${planned.problem}` : ''}`);
    for (const [index, milestone] of planned.milestones.entries()) {
      log(`planning: milestone ${index + 1} — ${milestone.title} (${milestone.steps.length} step(s))`);
      for (const step of milestone.steps) {
        log(`planning:   step — ${step.step}${step.check ? ` (check: ${step.check})` : ' (no check given)'}`);
      }
    }
    return planned;
  } catch (error) {
    log(`planning: milestone failed (${String(error)})`);
    return { milestones: [], problem: CALL_FAILED };
  }
}

/**
 * Applies one piece of typed feedback to the draft (M9i) — see `planRevision.ts`.
 *
 * **No model, no rewrite, but the words are not lost.** They go under Notes, which is what
 * refining did before M9i, and the line said afterwards makes plain that the sections they
 * affect were not changed.
 */
export async function revisePlan(
  models: ModelService,
  planText: string,
  feedback: string,
  log: (message: string) => void
): Promise<Revision> {
  if (!(await models.isReady('chat'))) {
    log('planning: revision — no model configured, added under Notes');
    return { text: withNote(planText, feedback), changed: ['Notes'], asNote: true };
  }

  let timedOut = false;
  try {
    const reply = await withDeadline(
      REVISION_TIMEOUT_MS,
      (signal) =>
        collect(models, { system: revisionSystemPrompt(), messages: [{ role: 'user', content: revisionPrompt(planText, feedback) }], signal }, MAX_REVISION_CHARS),
      () => '',
      () => {
        timedOut = true;
      }
    );

    const revision = readRevision(planText, reply, timedOut);
    log(`planning: revision — ${'text' in revision ? `changed ${revision.changed.join(', ')}` : revision.unchanged}`);
    return revision;
  } catch (error) {
    log(`planning: revision failed (${String(error)})`);
    return { unchanged: 'The model call failed, so the draft is unchanged — the log has the details.' };
  }
}
