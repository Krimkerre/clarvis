import * as vscode from 'vscode';

/**
 * Reads branch and dirty-file count from the built-in Git extension.
 *
 * Everything here is probe-don't-assume (§4.0): the extension can be disabled, the
 * folder might not be a repository, and the API shape isn't in `@types/vscode` at all —
 * it comes from another extension's exports. Any of that failing means "no git facts",
 * which the briefing simply omits rather than treating as an error.
 */
/**
 * Untracked files are not "uncommitted changes".
 *
 * The Git extension reports them inside `workingTreeChanges`, so a stray `.DS_Store` or
 * a scratch note made Clarvis open with "one file uncommitted" about a file the user had
 * never edited — sounding wrong about their own repository, which is worse than saying
 * nothing. Newer API versions expose `untrackedChanges` separately; older ones only tag
 * each change with a status, where `7` is UNTRACKED. Probed rather than assumed (§4.0),
 * because this shape comes from another extension's exports and is not in `@types/vscode`.
 */
const UNTRACKED = 7;

function splitChanges(state: {
  workingTreeChanges?: { status?: number }[];
  untrackedChanges?: unknown[];
}): { tracked: number; untracked: number } {
  const working = state.workingTreeChanges ?? [];

  if (Array.isArray(state.untrackedChanges)) {
    return { tracked: working.length, untracked: state.untrackedChanges.length };
  }

  const untracked = working.filter((change) => change.status === UNTRACKED).length;
  return { tracked: working.length - untracked, untracked };
}

export async function readGitSummary(): Promise<
  { branch: string; dirtyCount: number; untrackedCount: number } | undefined
> {
  try {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) return undefined;

    const exports = extension.isActive ? extension.exports : await extension.activate();
    const api = exports?.getAPI?.(1);
    if (!api) return undefined;

    // Repositories are discovered asynchronously — M1 saw `repoCount: 0` at activation
    // in a folder that was definitely a repo, simply because the scan hadn't finished.
    const repository = api.repositories?.[0];
    if (!repository) return undefined;

    const branch: unknown = repository.state?.HEAD?.name;
    if (typeof branch !== 'string') return undefined; // detached HEAD, or mid-scan

    const { tracked, untracked } = splitChanges(repository.state ?? {});
    return { branch, dirtyCount: tracked, untrackedCount: untracked };
  } catch {
    // A briefing is a nicety. It never breaks activation.
    return undefined;
  }
}
