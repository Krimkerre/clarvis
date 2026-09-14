import * as vscode from 'vscode';
import { adviseOnGit, GitProblem } from './branchNames';
import { probeGitProblem } from './AgentBranch';
import { forgetGitOfferDeclined, gitOfferDeclined, rememberGitOfferDeclined } from './gitOfferMemory';
import { setUpGit, type GitSetupResult } from './gitSetup';
import { repositoryForFolder, type RootedRepository } from './repositoryForFolder';

/**
 * The actual `git init` offer — asked once, acted on, remembered.
 *
 * **This never existed.** `AgentBranch.begin()` explained *why* it could not isolate,
 * but nothing ever turned `adviseOnGit()`'s `action` label into a button, and nothing
 * asked before a run had already failed to isolate. Opening a folder with no `.git` and
 * asking for a change produced silence — not even the explanation, because that message
 * was also only reaching the terminal (see `AgentEvent.toChat`) — never mind an offer.
 *
 * Run *before* the task starts, not after `begin()` has already given up: asking "shall
 * I run `git init`?" only after failing once is a worse experience, and by then the run
 * has already committed to the checkpoint-only path for that attempt.
 *
 * **For Clarvis's own engine.** Codex can't work without git at all, so it has an offer of its
 * own that an earlier "no" here never hides (`chat/codexGitSetup.ts`). Both set git up the same
 * way, through `setUpGitHere` below. The remembered answer lives in `gitOfferMemory.ts`.
 */

/**
 * What there is to offer here, if anything — without asking.
 *
 * Split out because the offer now has two moments and two surfaces. A run asks in a
 * modal, because a run starts from a typed instruction and there is no conversation to
 * put a question into. Planning asks **in the chat**, through the same buttons every
 * other interview question uses, because there plainly is one.
 */
export async function gitOffer(
  context: vscode.ExtensionContext,
  log: (message: string) => void
): Promise<{ problem: GitProblem; message: string; action: string } | undefined> {
  if (gitOfferDeclined(context.workspaceState)) {
    log('git offer: already declined, not asking again');
    return undefined;
  }

  const problem = await probeGitProblem();
  if (!problem) return undefined; // a real repository — nothing to offer

  const advice = adviseOnGit(problem);
  if (!advice.action) return undefined;

  return { problem, message: advice.message, action: advice.action };
}

/** Records the decline, so neither surface asks again in this workspace. */
export async function declineGitOffer(
  context: vscode.ExtensionContext,
  problem: GitProblem,
  log: (message: string) => void
): Promise<void> {
  await rememberGitOfferDeclined(context.workspaceState);
  log(`git offer: declined (${problem})`);
}

/** Does the thing that was offered. */
export async function acceptGitOffer(
  problem: GitProblem,
  root: string | undefined,
  log: (message: string) => void
): Promise<void> {
  await act(problem, root, log);
}

export async function offerGitFix(
  context: vscode.ExtensionContext,
  root: string | undefined,
  log: (message: string) => void
): Promise<void> {
  // Every early return here used to be silent — reading one session's log gave no way
  // to tell "already declined" apart from "something else stopped it", which cost a
  // grep across every session file this project has ever written to answer a question
  // one log line should have settled on its own.
  const offer = await gitOffer(context, log);
  if (!offer) return;

  const choice = await vscode.window.showInformationMessage(
    offer.message,
    {
      modal: true,
      detail: 'Declining is fine — I will snapshot files instead, and the run can still be undone.',
    },
    offer.action
  );

  if (choice !== offer.action) {
    await declineGitOffer(context, offer.problem, log);
    return;
  }

  await act(offer.problem, root, log);
}

async function act(problem: GitProblem, root: string | undefined, log: (message: string) => void): Promise<void> {
  if (problem === 'no-repository') {
    log('git offer: setting git up');
    const result = await setUpGitHere(root, log);
    // **Said, not only logged.** A first commit that failed used to leave a `.git` with nothing
    // in it, reported to the log alone, while the run carried on as if git were there.
    // `setUpGit` now takes a half-made setup back out, and this says why, and what to do.
    if (!result.ok) void vscode.window.showWarningMessage(result.line);
    return;
  }

  if (problem === 'no-extension') {
    // Documented command for opening the Extensions view pre-filtered to one id — the
    // most that can be done without a reload, which enabling an extension needs anyway.
    await vscode.commands.executeCommand('workbench.extensions.search', '@id:vscode.git');
    log('git offer: opened the extension search');
  }
}

/**
 * `git init` and the first, empty commit in this folder — for both offers, Clarvis's own and Codex's.
 *
 * The first commit is there so there is something to branch from and merge back into. Found
 * live, 11 September 2026: a repository with no commits has a branch name and nothing behind it —
 * every run branched from nothing, and "Merge" had nothing to merge into. Git's own output
 * ("Initialized empty Git repository in …") is never shown: it means nothing to someone who does
 * not know what git is. Success is the task proceeding; failure is a sentence (`gitSetup.ts`).
 *
 * **Workspace Trust first.** Restricted Mode means Clarvis runs nothing, and this runs git. Both
 * offers are already behind it in practice — Codex never reaches a git refusal in an untrusted
 * folder (`engineChoice.ts`) — and this says so in words rather than throwing if one ever isn't.
 *
 * **Then the editor has to see it.** A branch for a run, of either engine, is made through VS Code's
 * Git extension, which finds a new repository on its own scan, in its own time. Carrying a Codex task
 * on before it has would meet the very refusal just fixed, so it is asked to open the repository
 * now, and given a few seconds to see the first commit.
 */
export async function setUpGitHere(root: string | undefined, log: (message: string) => void): Promise<GitSetupResult> {
  if (!root) return { ok: false, reason: 'no-folder', line: 'There is no folder open, so there is nowhere to set git up.' };
  if (!vscode.workspace.isTrusted) {
    return {
      ok: false,
      reason: 'untrusted',
      line: 'This folder is open in Restricted Mode, so I can\'t set git up in it. If it is yours and you trust it, use "Workspaces: Manage Workspace Trust" and try again.',
    };
  }

  const result = await setUpGit(root, { log });
  return result.ok ? { ...result, editorCaughtUp: await editorSeesCommit(root, log) } : result;
}

/** How long the Git extension is given to see a repository just set up, checked every 100 ms. */
const EDITOR_CATCH_UP_ATTEMPTS = 50;

/** Whether the Git extension sees `root`'s repository with a commit, within a few seconds. */
async function editorSeesCommit(root: string, log: (message: string) => void): Promise<boolean> {
  const extension = vscode.extensions.getExtension<GitOpenExports>('vscode.git');
  const api = extension ? (extension.isActive ? extension.exports : await extension.activate())?.getAPI?.(1) : undefined;
  if (!api) {
    log('git offer: the Git extension is not available, so nothing can see the new repository');
    return false;
  }

  await api.openRepository?.(vscode.Uri.file(root));
  for (let attempt = 0; attempt < EDITOR_CATCH_UP_ATTEMPTS; attempt++) {
    const repository = repositoryForFolder(api.repositories, root);
    if (repository?.state.HEAD?.commit) return true;
    // Its state updates on its own schedule; asking for a status read brings that forward.
    await repository?.status?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  log('git offer: the Git extension had not seen the first commit after 5 seconds');
  return false;
}

/** The slice of the Git extension's API the catch-up uses. */
interface GitOpenExports {
  getAPI(version: 1): { repositories: SeenRepository[]; openRepository?(root: vscode.Uri): Promise<unknown> };
}

interface SeenRepository extends RootedRepository {
  state: { HEAD?: { commit?: string } };
  status?(): Promise<void>;
}

/** For the command that lets a declined offer be asked again. */
export async function forgetGitOfferAnswer(context: vscode.ExtensionContext): Promise<void> {
  await forgetGitOfferDeclined(context.workspaceState);
}
