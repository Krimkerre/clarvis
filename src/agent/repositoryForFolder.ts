/**
 * The repository a folder belongs to, out of every repository the editor has found.
 *
 * **Found live, 12 September 2026.** With `nervis-tasks` open — a folder holding one
 * task folder per handoff and no repository of its own — the editor's Git extension still
 * found `pomodoro-timer/.git` one level down, because it scans subfolders. Clarvis took
 * the first repository it was handed, so the greeting named the pomodoro project's branch
 * and untracked file as though they were this folder's. The same first-repository rule
 * decided where an agent run made its branch and its commits.
 *
 * A repository counts only when its root *contains* the open folder. Of those, the
 * deepest wins, so a project nested inside a bigger repository is the project's. None
 * means none: a repository found beside or below the folder is not this folder's.
 *
 * Pure, so the rule runs under `node --test`; reaching the editor's API is the caller's job.
 */
export interface RootedRepository {
  rootUri?: { fsPath: string };
}

/** The deepest repository whose root contains `folder`, or nothing. */
export function repositoryForFolder<R extends RootedRepository>(
  repositories: readonly R[] | undefined,
  folder: string | undefined
): R | undefined {
  if (!folder || !repositories) return undefined;
  let chosen: R | undefined;
  let depth = -1;
  for (const repository of repositories) {
    const root = repository.rootUri?.fsPath.replace(/[\\/]+$/, '');
    if (!root || !contains(root, folder) || root.length <= depth) continue;
    chosen = repository;
    depth = root.length;
  }
  return chosen;
}

/** Whether `folder` is `root` or below it — `/proj-old` is not inside `/proj`. */
function contains(root: string, folder: string): boolean {
  const inner = folder.replace(/[\\/]+$/, '');
  return inner === root || inner.startsWith(`${root}/`) || inner.startsWith(`${root}\\`);
}
