import * as vscode from 'vscode';
import { ModelService } from '../model/ModelService';
import { analysisSystemPrompt } from './analysisPrompt';
import { addSteps, appendMilestone } from './planUpdate';
import { pendingBuild } from './pendingBuild';
import { parseScopeChange, ScopeVerdict, scopeChangePrompt } from './scopeChange';

/**
 * Kicking a scope change back to Plan Mode, mid-build (§0).
 *
 * Every generated `plan.md` promises this in writing — "scope changes discovered
 * mid-build kick back to Plan Mode, new gap analysis, new sign-off, rather than
 * growing silently inside Code Mode" — and nothing implemented it. Anything said
 * during a run was folded in as a correction, so a plan approved on Monday described
 * a different project by Thursday and nobody had agreed to the difference.
 */

const TIMEOUT_MS = 12000;
const MAX_RESPONSE_CHARS = 3000;

/**
 * Whether what the user just said adds scope, and what it would add.
 *
 * **Silence is a correction.** No plan, no model, a garbled reply, a timeout: all
 * come back `correction`, and the message is folded into the run as before. Folding
 * a scope change in loses a sign-off; stopping a build over a failed judgement call
 * loses the run — and the second is the worse trade, made every time it fires.
 */
export async function judgeScope(
  models: ModelService,
  said: string,
  log: (message: string) => void
): Promise<ScopeVerdict> {
  const pending = await pendingBuild();
  if (!pending) return { kind: 'correction' };
  if (!(await models.isReady('chat'))) return { kind: 'correction' };

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return { kind: 'correction' };

  const planText = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'plan.md')).then(
    (bytes) => Buffer.from(bytes).toString('utf8'),
    () => undefined
  );
  if (!planText) return { kind: 'correction' };

  try {
    let text = '';
    const collect = (async () => {
      for await (const fragment of models.stream(
        {
          system: analysisSystemPrompt(),
          messages: [{ role: 'user', content: scopeChangePrompt(planText, pending.milestone.title, said) }],
        },
        'chat'
      )) {
        text += fragment;
        if (text.length > MAX_RESPONSE_CHARS) break;
      }
    })();
    await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS))]);

    const verdict = parseScopeChange(text);
    log(
      verdict.kind === 'correction'
        ? 'planning: mid-run message read as a correction'
        : `planning: scope change — ${verdict.summary} (${verdict.placement}, ${verdict.steps.length} step(s))`
    );
    return verdict;
  } catch (error) {
    log(`planning: scope judgement failed (${String(error)}), treated as a correction`);
    return { kind: 'correction' };
  }
}

/**
 * Writes agreed scope into `plan.md`, and says where it went.
 *
 * Returns `undefined` if it could not be written — the caller then has a decision
 * the user made and nowhere to record it, which is worth saying out loud rather than
 * proceeding as though the plan now covers it.
 */
export async function recordScopeChange(
  verdict: Extract<ScopeVerdict, { kind: 'scope' }>,
  log: (message: string) => void
): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const pending = await pendingBuild();
  if (!folder || !pending) return undefined;

  const planUri = vscode.Uri.joinPath(folder.uri, 'plan.md');
  const planText = await vscode.workspace.fs.readFile(planUri).then(
    (bytes) => Buffer.from(bytes).toString('utf8'),
    () => undefined
  );
  if (!planText) return undefined;

  // "Now" joins the milestone in progress; "later" becomes one of its own at the end
  // — which is the difference between work the current milestone is wrong without
  // and work that can wait for the one after it.
  const updated =
    verdict.placement === 'now'
      ? addSteps(planText, pending.milestone.number, verdict.steps)
      : appendMilestone(planText, verdict.summary, verdict.steps);

  if (updated === planText) {
    log('planning: scope change could not be written into plan.md');
    return undefined;
  }

  await vscode.workspace.fs.writeFile(planUri, Buffer.from(updated, 'utf8'));
  log(`planning: scope change written into plan.md (${verdict.placement})`);

  return verdict.placement === 'now'
    ? `Added to milestone ${pending.milestone.number}: ${verdict.steps.length} step(s).`
    : `Written down as a milestone of its own, after the current one.`;
}
