import { isAgentBranch } from './branchNames';
import { explainState } from './gitPlain';
import { firstGitRepository } from './gitExtension';

/**
 * "Where am I, and is anything at risk?" — answered without git's vocabulary.
 *
 * The state comes from the Git extension; the *words* come from `gitPlain.ts`, which
 * is pure and tested. This file only does the fetching, so the phrasing stays
 * verifiable and this stays trivial.
 */
export async function describeGitPlainly(): Promise<string[]> {
  const repository = await firstGitRepository<GitRepository>();
  if (!repository) {
    return [
      "There's no git repository here, so nothing is being tracked — every edit is just a file on your disk. " +
        'Say the word and I can set one up, which mostly means you get an undo history that survives closing the editor.',
    ];
  }

  const head = repository.state.HEAD;
  const branch = head?.name;

  return explainState({
    branch,
    // No branch name with a commit present is git's "detached" state, which is the one
    // most likely to lose a beginner's work without ever warning them.
    detached: Boolean(head?.commit) && !branch,
    dirty: repository.state.workingTreeChanges.length + repository.state.indexChanges.length,
    ahead: head?.ahead ?? 0,
    behind: head?.behind ?? 0,
    onAgentBranch: Boolean(branch && isAgentBranch(branch)),
    hasRemote: (repository.state.remotes?.length ?? 0) > 0,
  });
}

interface GitRepository {
  state: {
    HEAD?: { name?: string; commit?: string; ahead?: number; behind?: number };
    workingTreeChanges: unknown[];
    indexChanges: unknown[];
    remotes?: unknown[];
  };
}
