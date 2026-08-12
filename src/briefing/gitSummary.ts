import * as vscode from 'vscode';
import { splitChanges } from './gitChanges';

/**
 * Reads branch and dirty-file count from the built-in Git extension.
 *
 * Everything here is probe-don't-assume (§4.0): the extension can be disabled, the
 * folder might not be a repository, and the API shape isn't in `@types/vscode` at all —
 * it comes from another extension's exports. Any of that failing means "no git facts",
 * which the briefing simply omits rather than treating as an error.
 */
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
