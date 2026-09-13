/**
 * What git says about a checkout, read with the git binary (plan.md M15, C3; design §5.1 `continueOn`, §6.2).
 *
 * **Why the binary here.** A switch needs a few facts the Git extension doesn't offer directly — whether one
 * commit is an ancestor of another, a branch's tip by name, lines added and removed per file — and a switch
 * must be testable against a real repository, not only inside an editor. `git` answers each in one call, in
 * the C locale so nothing depends on the owner's language.
 *
 * **Reading, and committing on the task's branch.** Every method but `commitOnBranch` only reads.
 * `commitOnBranch` commits named paths, and only while HEAD is the branch it was told: a switch saves the
 * stopped engine's work on the task's own branch or not at all (design §5.6).
 *
 * **Not knowing is not "no".** A git call that fails reads as `undefined` or an empty list, and the callers
 * treat that as "can't continue", never as "nothing there".
 *
 * vscode-free; the runner is injectable.
 */

import { execFile } from 'child_process';
import type { DiffStat } from './taskCheckpoint';

export type GitRunner = (args: string[], cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const COMMIT = /^[0-9a-f]{7,64}$/;

export class GitFacts {
  constructor(
    readonly root: string,
    private readonly run: GitRunner = runGit
  ) {}

  /** The branch HEAD is on (undefined when detached) and its commit (undefined before the first commit). */
  async head(): Promise<{ branch?: string; commit?: string }> {
    const [branch, commit] = await Promise.all([this.line(['symbolic-ref', '--quiet', '--short', 'HEAD']), this.line(['rev-parse', '--verify', '--quiet', 'HEAD'])]);
    return { branch, commit };
  }

  /** A local branch's tip, or undefined when there is no such branch. */
  tip(branch: string): Promise<string | undefined> {
    return this.line(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  }

  async branches(): Promise<string[]> {
    const listed = await this.run(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], this.root);
    return listed.code === 0 ? listed.stdout.split('\n').filter(Boolean) : [];
  }

  /** Whether `ancestor` is `descendant` or one of its ancestors. */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    if (!COMMIT.test(ancestor) || !COMMIT.test(descendant)) return false;
    return (await this.run(['merge-base', '--is-ancestor', ancestor, descendant], this.root)).code === 0;
  }

  /** Lines added and removed per file between two commits; a binary file counts as 0 and 0. */
  async diffStat(from: string, to: string): Promise<DiffStat[]> {
    if (!COMMIT.test(from) || !COMMIT.test(to)) return [];
    const diff = await this.run(['diff', '--numstat', '--no-renames', from, to], this.root);
    return diff.code === 0 ? parseNumstat(diff.stdout) : [];
  }

  /** Modified, staged and untracked paths, relative to the root. */
  async dirty(): Promise<string[]> {
    const status = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], this.root);
    return status.code === 0 ? parsePorcelain(status.stdout) : [];
  }

  /** Commits `paths` on `branch`, and only while HEAD is that branch. The new commit, or why not. */
  async commitOnBranch(branch: string, paths: string[], message: string): Promise<{ ok: true; commit: string } | { ok: false; detail: string }> {
    const head = await this.head();
    if (head.branch !== branch) return { ok: false, detail: `HEAD is on ${head.branch ?? 'no branch'}, not ${branch}` };
    const added = await this.run(['add', '--', ...paths], this.root);
    if (added.code !== 0) return { ok: false, detail: added.stderr.trim() || 'git add failed' };
    const committed = await this.run(['commit', '--quiet', '-m', message, '--', ...paths], this.root);
    if (committed.code !== 0) return { ok: false, detail: committed.stderr.trim() || 'git commit failed' };
    const commit = (await this.head()).commit;
    return commit ? { ok: true, commit } : { ok: false, detail: 'no commit after committing' };
  }

  private async line(args: string[]): Promise<string | undefined> {
    const answer = await this.run(args, this.root);
    const text = answer.stdout.trim();
    return answer.code === 0 && text !== '' ? text : undefined;
  }
}

export function parseNumstat(text: string): DiffStat[] {
  return text
    .split('\n')
    .map((line) => /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(([, added, removed, file]) => ({ path: file, added: Number(added) || 0, removed: Number(removed) || 0 }));
}

/** `git status --porcelain=v1 -z`: `XY path`, NUL-separated; a rename or copy is followed by its old path. */
export function parsePorcelain(text: string): string[] {
  const entries = text.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) index++;
  }
  return paths;
}

function runGit(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}
