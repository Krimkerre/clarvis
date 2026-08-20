import * as vscode from 'vscode';
import { ModelService } from '../model/ModelService';
import { Finding, parseAnalysisResult } from '../planning/analysisPrompt';
import { milestoneSteps, nextMilestone, readMilestones } from '../planning/planUpdate';
import { gitDiff } from './tools/commandTools';
import { NOTHING_TO_REPORT, reviewPrompt, reviewSystemPrompt } from './milestoneReview';
import { withDeadline } from '../model/deadline';
import { collect } from '../model/collect';

/**
 * The glue for reading a milestone back: gather what it needs, ask, parse.
 *
 * Everything decidable lives in `milestoneReview.ts`; this is the part that touches
 * git, the plan and a model, and is therefore the part not worth testing.
 *
 * Named for the act rather than for the noun, because `runReview.ts` next door is a
 * different thing entirely — that one asks what to do with a finished run's *branch*.
 */

/** Enough of a diff to review, and not so much that it costs more than it finds. */
const MAX_DIFF_CHARS = 24_000;

/** A bounded wait, for the same reason every other model call has one. */
const TIMEOUT_MS = 90_000;

export async function reviewMilestone(
  models: ModelService,
  finishedTitle: string,
  log: (message: string) => void
): Promise<Finding[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];

  const planText = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'plan.md')).then(
    (bytes) => Buffer.from(bytes).toString('utf8'),
    () => ''
  );

  // The milestone just finished is the last one with everything ticked; `nextMilestone`
  // points past it, so the one before that is the subject.
  const milestones = readMilestones(planText);
  const next = nextMilestone(planText);
  const finished = milestones.filter((entry) => entry.done === entry.total).pop();
  if (!finished) return [];

  const diff = (await gitDiff().catch(() => '')).slice(0, MAX_DIFF_CHARS);
  if (!diff.trim()) {
    log('review: nothing in the diff to read back');
    return [];
  }

  const steps = milestoneSteps(planText, finished.number).map((step) => ({ step }));
  const prompt = reviewPrompt({
    milestone: finishedTitle || finished.title,
    steps,
    diff,
    language: /^\*\*The (?:tool|project|service|system) is written in ([^.,]+)/im.exec(planText)?.[1]?.trim(),
  });

  try {
    const text = await withDeadline(TIMEOUT_MS, (signal) => collect(models, { system: reviewSystemPrompt(), messages: [{ role: 'user', content: prompt }], signal }), () => '');

    if (!text.trim() || text.includes(NOTHING_TO_REPORT)) {
      log('review: read the diff back and found nothing');
      return [];
    }

    const { findings } = parseAnalysisResult(text);
    for (const finding of findings) log(`review: [${finding.class}] ${finding.what}`);

    // Logged even when it is the next milestone's problem, so the record shows what was
    // known at the time rather than only what was acted on.
    if (next) log(`review: ${findings.length} finding(s) before milestone ${next.number}`);
    return findings;
  } catch (error) {
    // A review that fails is not a build that fails: the milestone is already done.
    log(`review: could not read the diff back (${String(error)})`);
    return [];
  }
}

