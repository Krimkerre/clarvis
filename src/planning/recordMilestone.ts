import * as vscode from 'vscode';
import { ModelService } from '../model/ModelService';
import { analysisSystemPrompt } from './analysisPrompt';
import { markSteps, milestoneComplete } from './planUpdate';
import { MAX_RESPONSE_CHARS, parseStepResults, recordMilestonePrompt, TIMEOUT_MS } from './milestoneReport';

/**
 * Writing what a run actually did back into the project's `plan.md`.
 *
 * §0 promises that in Code Mode the plan becomes a live checklist, ticked as each
 * step lands. Until now nothing ticked anything: a plan approved on Monday still
 * read as entirely unbuilt on Friday, which makes the document worse than useless —
 * it is confidently wrong about the thing it exists to track.
 *
 * **The model reads the run's own report rather than the code.** What matters is
 * what the agent said it did and what its checks printed; inspecting the files
 * afterwards would be a second opinion about work already described, and one that
 * cannot tell a step that was finished from a step that happens to look finished.
 */

/**
 * Updates `plan.md` from a finished run, and reports what it changed.
 *
 * Returns the human-readable outcome, or `undefined` when there was nothing to do —
 * no workspace, no plan, or no model to read the report with. Never throws at the
 * caller: a plan that could not be updated is a worse outcome than one that was, and
 * a far better one than a failed run.
 */
export async function recordMilestone(
  models: ModelService,
  summary: string,
  log: (message: string) => void
): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;

  const planUri = vscode.Uri.joinPath(folder.uri, 'plan.md');
  const existing = await vscode.workspace.fs.readFile(planUri).then(
    (bytes) => Buffer.from(bytes).toString('utf8'),
    () => undefined
  );
  if (!existing) {
    log('planning: no plan.md to record against');
    return undefined;
  }

  if (!(await models.isReady('chat'))) {
    log('planning: no model, plan.md left untouched');
    return undefined;
  }

  try {
    let text = '';
    const collect = (async () => {
      for await (const fragment of models.stream(
        {
          system: analysisSystemPrompt(),
          messages: [{ role: 'user', content: recordMilestonePrompt(existing, summary) }],
        },
        'chat'
      )) {
        text += fragment;
        if (text.length > MAX_RESPONSE_CHARS) break;
      }
    })();
    await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS))]);

    const results = parseStepResults(text);
    if (results.length === 0) {
      log('planning: nothing parsed from the run report, plan.md left untouched');
      return undefined;
    }

    const updated = markSteps(existing, results);
    if (updated === existing) {
      log('planning: no step in plan.md matched the run report');
      return undefined;
    }

    await vscode.workspace.fs.writeFile(planUri, Buffer.from(updated, 'utf8'));

    const done = results.filter((result) => result.done).length;
    for (const result of results) {
      log(`planning: step "${result.step}" — ${result.done ? 'done' : 'not done'}${result.result ? ` — ${result.result}` : ''}`);
    }

    return milestoneComplete(updated)
      ? `plan.md updated — every step in this milestone is now ticked off.`
      : `plan.md updated — ${done} of ${results.length} step(s) ticked off.`;
  } catch (error) {
    log(`planning: recording the milestone failed (${String(error)})`);
    return undefined;
  }
}
