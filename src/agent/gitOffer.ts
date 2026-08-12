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

export async function offerGitFix(
  context: vscode.ExtensionContext,
  root: string | undefined,
  log: (message: string) => void
): Promise<void> {
  // Every early return here used to be silent — reading one session's log gave no way
  // to tell "already declined" apart from "something else stopped it", which cost a
  // grep across every session file this project has ever written to answer a question
  // one log line should have settled on its own.
  if (context.workspaceState.get<boolean>(DECLINED_KEY)) {
    log('git offer: already declined, not asking again');
    return;
  }

  const problem = await probeGitProblem();
  if (!problem) return; // a real repository — nothing to offer, nothing worth logging

  // No binary means no button that would work — `adviseOnGit` already omits `.action`
  // for it, and `protect()`'s plain-text explanation (now reaching the chat) is the
  // whole of what there is to say.
  const advice = adviseOnGit(problem);
  if (!advice.action) return;

  const choice = await vscode.window.showInformationMessage(
    advice.message,
    {
      modal: true,
      detail: 'Declining is fine — I will snapshot files instead, and the run can still be undone.',
    },
    advice.action
  );

  if (choice !== advice.action) {
    await context.workspaceState.update(DECLINED_KEY, true);
    log(`git offer: declined (${problem})`);
    return;
  }

  await act(problem, root, log);
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
