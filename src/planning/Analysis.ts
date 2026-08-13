import { ModelService } from '../model/ModelService';
import { InterviewState } from './interviewTopics';
import { AnalysisResult, analysisPrompt, analysisSystemPrompt, parseAnalysisResult } from './analysisPrompt';
import { MilestoneStep, milestonePrompt, parseMilestoneSteps } from './milestonePrompt';
import { FindingVerdict } from './verdictSummary';

/**
 * Runs one analysis pass over a finished interview (M9b — §4.9).
 *
 * **Findings only, no verdicts.** Accept/reject/modify per finding (M9c) is a
 * separate, later piece — this ends by handing back what it found, same discipline
 * as M9a ending at "enough to draft" rather than reaching for the next milestone.
 *
 * **No model, no analysis.** Unlike a question, there is no honest written fallback
 * for "find the safety problems in this idea" — a canned finding would be exactly the
 * invented-fact failure `ONLY_WHAT_YOU_WERE_GIVEN` exists to prevent. Missing a model
 * just means the interview's own summary is all the user gets, same as today.
 */

/** Longer than a single question — four passes over the whole interview in one call. */
const ANALYSIS_TIMEOUT_MS = 15000;

/** Four short findings comfortably fit; this is headroom, not a target. */
const MAX_RESPONSE_CHARS = 6000;

export async function runAnalysis(
  models: ModelService,
  state: InterviewState,
  log: (message: string) => void
): Promise<AnalysisResult> {
  if (!(await models.isReady('chat'))) {
    log('planning: analysis skipped — no model configured');
    return { findings: [] };
  }

  try {
    let text = '';
    const collect = (async () => {
      for await (const fragment of models.stream(
        { system: analysisSystemPrompt(), messages: [{ role: 'user', content: analysisPrompt(state) }] },
        'chat'
      )) {
        text += fragment;
        if (text.length > MAX_RESPONSE_CHARS) break;
      }
    })();

    await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, ANALYSIS_TIMEOUT_MS))]);

    const result = parseAnalysisResult(text);
    if (result.noPlanNeeded) {
      log(`planning: analysis — no plan needed: ${result.noPlanNeeded}`);
    } else {
      log(`planning: analysis — ${result.findings.length} finding(s)`);
      for (const finding of result.findings) {
        log(`planning: analysis [${finding.class}] ${finding.what} — ${finding.whyItMatters} — fix: ${finding.suggestedResolution}`);
      }
    }
    return result;
  } catch (error) {
    log(`planning: analysis failed (${String(error)})`);
    return { findings: [] };
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
  accepted: FindingVerdict[] = []
): Promise<MilestoneStep[]> {
  if (!(await models.isReady('chat'))) {
    log('planning: milestone — no model configured, no steps written');
    return [];
  }

  try {
    let text = '';
    const collect = (async () => {
      for await (const fragment of models.stream(
        { system: analysisSystemPrompt(), messages: [{ role: 'user', content: milestonePrompt(state, accepted) }] },
        'chat'
      )) {
        text += fragment;
        if (text.length > MAX_RESPONSE_CHARS) break;
      }
    })();

    await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, ANALYSIS_TIMEOUT_MS))]);

    const steps = parseMilestoneSteps(text);
    log(`planning: milestone — ${steps.length} step(s)`);
    for (const step of steps) log(`planning: milestone step — ${step.step}${step.check ? ` (check: ${step.check})` : ' (no check given)'}`);
    return steps;
  } catch (error) {
    log(`planning: milestone failed (${String(error)})`);
    return [];
  }
}
