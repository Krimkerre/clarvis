import * as vscode from 'vscode';
import { workspaceFolderPath } from '../agent/gitExtension';
import { repositoryForFolder, RootedRepository } from '../agent/repositoryForFolder';
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
    // **This folder's repository, not the first found** — see `repositoryForFolder`: the
    // Git extension scans subfolders, and with nervis-tasks open this named a task's branch.
    const repository = repositoryForFolder<SummaryRepository>(api.repositories, workspaceFolderPath());
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

/**
 * The slice of a Git extension repository read here. `state` stays untyped, as it was
 * before the repository was chosen by folder: the extension's API has no published types,
 * and this reader already probes every field it touches.
 */
type SummaryRepository = RootedRepository & { state?: any };
