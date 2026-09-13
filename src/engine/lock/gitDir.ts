/**
 * A checkout's git folder, found without running git (plan.md M15, C2a; design §3.5.1 review AM9, §6.3).
 *
 * **Why it matters.** The checkout lock file lives in the git folder (`<git_dir>/clarvis-engine.lock`),
 * and RAVIS is told `git_dir` when a Codex session or a project lock is taken. RAVIS runs no git; it
 * checks the folder's shape itself. Clarvis reports what is there:
 * - `<root>/.git` is a directory: its realpath;
 * - `<root>/.git` is a file saying `gitdir: <path>` (a worktree): that path, resolved against the root;
 * - neither: no git folder. Such a root keeps its lock file in `<root>/.clarvis/`, and RAVIS is told that
 *   folder instead (design §3.5.1: "A root without `.git` uses `<root>/.clarvis/`").
 *
 * Reading only.
 */

import * as fs from 'fs';
import * as path from 'path';

export function findGitDir(root: string): string | undefined {
  const dotGit = path.join(root, '.git');
  let stats: fs.Stats;
  try {
    stats = fs.statSync(dotGit);
  } catch {
    return undefined;
  }
  if (stats.isDirectory()) return realpath(dotGit);
  return stats.isFile() ? worktreeGitDir(root, dotGit) : undefined;
}

/** The `git_dir` RAVIS is told: the git folder, or `<root>/.clarvis` for a root without one. */
export function gitDirForRelay(root: string, gitDir: string | undefined): string {
  return gitDir ?? path.join(root, '.clarvis');
}

function worktreeGitDir(root: string, dotGit: string): string | undefined {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit));
  return match ? realpath(path.resolve(root, match[1])) : undefined;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function realpath(file: string): string | undefined {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return undefined;
  }
}
