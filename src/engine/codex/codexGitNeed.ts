/**
 * What a Codex task is missing, as far as git goes, and what the chat says about it (plan.md M15, "Codex offers to
 * set git up"; the owner's decision of 14 Sep 2026).
 *
 * **Why this exists.** Codex saves its work as commits on a branch of its own, so a folder without git, or with a
 * repository that has no commit yet, refuses the task. The refusal used to end there, and it carried Clarvis's own
 * engine's advice with it ("I can still snapshot files and undo the run"), which is not true of Codex. Found live on
 * 14 Sep in a folder where the owner had declined Clarvis's `git init` offer earlier: typing "git init then" went to
 * Codex as a new task and met the same refusal, and there was no way forward from the chat.
 *
 * Now the two cases git setup fixes, no repository and no commit, say so plainly and offer **Set up git here**
 * (`chat/codexGitSetup.ts`). Git not installed says how to get it, with no button: a button that can only fail is
 * worse than an honest sentence (the rule `branchNames.adviseOnGit` already follows). Anything else keeps the
 * reason it had.
 *
 * Pure.
 */

import { gitInstallHint, type GitProblem } from '../../agent/branchNames';

export type CodexGitNeed = 'no-repository' | 'no-commit' | 'no-binary' | 'other';

/** The first sentence of every git refusal: what Codex needs, and why. */
export const CODEX_NEEDS_GIT =
  'Codex needs this folder to be a git repository with at least one commit: its work is saved as commits on a branch of its own.';

/** What stopped the branch: what the editor's Git extension found, and what `AgentBranch` diagnosed when it found nothing. */
export function codexGitNeed(facts: { repository: boolean; headCommit: string | undefined; problem: GitProblem | undefined }): CodexGitNeed {
  if (facts.repository) return facts.headCommit ? 'other' : 'no-commit';
  return facts.problem === 'no-repository' || facts.problem === 'no-binary' ? facts.problem : 'other';
}

/** Whether **Set up git here** fixes it: only when git is installed and the folder lacks a repository or its first commit. */
export function offersGitSetup(need: CodexGitNeed): boolean {
  return need === 'no-repository' || need === 'no-commit';
}

/** The refusal, in plain words. `advice` is `AgentBranch`'s own reason, kept for the cases git setup doesn't cover. */
export function codexNeedsGitLine(need: CodexGitNeed, advice: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (need === 'no-repository') return `${CODEX_NEEDS_GIT} This folder isn't a git repository yet.`;
  if (need === 'no-commit') return `${CODEX_NEEDS_GIT} This folder's git repository has no commits yet.`;
  if (need === 'no-binary') {
    return `${CODEX_NEEDS_GIT} Git isn't installed on this machine. ${gitInstallHint(platform)} Once it's installed, ask for the task again.`;
  }
  return advice ? `${CODEX_NEEDS_GIT} ${advice}` : CODEX_NEEDS_GIT;
}
