import * as vscode from 'vscode';
import { adviseOnGit, GitProblem } from './branchNames';
import { probeGitProblem } from './AgentBranch';
import { runCommand } from './tools/commandTools';

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
 */

/** Remembered per workspace, so a decline does not ask again next session. */
const DECLINED_KEY = 'clarvis.agent.gitOfferDeclined';

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
  if (context.workspaceState.get<boolean>(DECLINED_KEY)) {
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
  await context.workspaceState.update(DECLINED_KEY, true);
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
    log('git offer: running git init');
    // Discarded rather than shown: `git init` prints one line ("Initialized empty Git
    // repository in …") that means nothing to someone who does not know what git is —
    // success here is the run proceeding normally afterwards, not this sentence.
    await runCommand(root, 'git init', () => {});
    return;
  }

  if (problem === 'no-extension') {
    // Documented command for opening the Extensions view pre-filtered to one id — the
    // most that can be done without a reload, which enabling an extension needs anyway.
    await vscode.commands.executeCommand('workbench.extensions.search', '@id:vscode.git');
    log('git offer: opened the extension search');
  }
}

/** For the command that lets a declined offer be asked again. */
export async function forgetGitOfferAnswer(context: vscode.ExtensionContext): Promise<void> {
  await context.workspaceState.update(DECLINED_KEY, undefined);
}
