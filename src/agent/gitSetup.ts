import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { gitInstallHint } from './branchNames';

/**
 * Setting git up in a folder: `git init`, then a first, empty commit (plan.md M15, "Codex offers to set git up",
 * the owner's decision of 14 Sep 2026).
 *
 * **Shared by both offers.** Clarvis's own offer (`gitOffer.ts`, asked once and remembered) and Codex's
 * **Set up git here** (`chat/codexGitSetup.ts`) do the same two steps. They live here once, and vscode-free, so the
 * tests run real git in temporary folders instead of trusting a stand-in for it.
 *
 * **Never a half-set-up folder left silently.** A folder with a `.git` and no commit is the worst of both: the
 * editor's Source Control lists every file as new, Codex still can't start, and nothing says why. So when the first
 * commit fails in a folder this call ran `git init` in, the `.git` it made is taken back out (it holds nothing but
 * git's own empty scaffolding, made seconds earlier) and the line says what happened and what to do next. A folder
 * that already had a `.git` before this call is never removed from: it is left exactly as it was.
 *
 * **The first commit is empty, and only empty.** `--only` with no paths commits nothing that happens to be staged
 * already: what is in the folder is the person's, and a first commit that quietly swept up their files would decide
 * something for them. Checked with real git: a staged file stays staged, and the commit's tree is empty.
 *
 * **The branch name is git's own.** `git init` runs without `--initial-branch`, so the first branch is whatever
 * `init.defaultBranch` says on this machine (`main` or `master`), the same as the offer always did, and the case
 * `branchFlow.ts`'s note on `main` versus `master` is about. It is read back afterwards, never assumed.
 */

/** The first commit's message. Unchanged from the first offer, so both offers leave the same history. */
export const FIRST_COMMIT_MESSAGE = 'Start of the project';

/** Why git wasn't set up. The first two are decided by the editor glue before git is ever run. */
export type GitSetupFailure = 'no-folder' | 'untrusted' | 'no-binary' | 'init-failed' | 'commit-failed';

export type GitSetupResult =
  | {
      ok: true;
      /** The branch git put the first commit on, as git reports it. */
      branch: string | undefined;
      /** False when the folder already had a commit, and there was nothing to add. */
      madeFirstCommit: boolean;
      /**
       * Whether the editor's Git extension has seen the repository and its commit (set by `gitOffer.setUpGitHere`;
       * absent here, where there is no editor). A Codex branch is made through that extension.
       */
      editorCaughtUp?: boolean;
    }
  | { ok: false; reason: GitSetupFailure; line: string };

export interface GitSetupOptions {
  log: (line: string) => void;
  /** The git program to run. Tests point this at one that doesn't exist, to be a machine without git. */
  git?: string;
  /** The environment git runs in. Tests use it to be a machine where git has no name and email. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** `git init` and the first, empty commit in `root`; or why not, in plain words. Never throws. */
export async function setUpGit(root: string, options: GitSetupOptions): Promise<GitSetupResult> {
  // Checked first because a missing working folder makes spawning git fail with the same ENOENT as a missing git,
  // and "install git" would be the wrong advice for a folder that was deleted.
  if (!isFolder(root)) return failed('no-folder', "This folder isn't there any more, so there is nowhere to set git up.");

  const dotGit = path.join(root, '.git');
  const hadGit = fs.existsSync(dotGit);

  const init = await runGit(root, ['init', '--quiet'], options);
  if (init.missing) return failed('no-binary', noBinaryLine(options.platform));
  if (init.code !== 0) return initFailed(dotGit, hadGit, init.output, options);

  // Already has a commit: an ordinary repository the editor hadn't noticed yet, or a second click. `git init` on an
  // existing repository changes nothing in it, and there is no first commit left to make.
  if ((await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], options)).code === 0) {
    options.log('git setup: already a repository with a commit, so there was nothing to add');
    return { ok: true, branch: await branchOf(root, options), madeFirstCommit: false };
  }

  const commit = await runGit(root, ['commit', '--allow-empty', '--only', '--quiet', '-m', FIRST_COMMIT_MESSAGE], options);
  if (commit.code !== 0) return commitFailed(dotGit, hadGit, commit.output, options);

  const branch = await branchOf(root, options);
  options.log(`git setup: ran git init and made the first, empty commit, on ${branch ?? 'an unnamed branch'}`);
  return { ok: true, branch, madeFirstCommit: true };
}

/** The part of git's output worth quoting: its `fatal:` or `error:` line, else its first line. */
export function gitSaid(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const chosen = lines.find((line) => /^(fatal|error):/i.test(line)) ?? lines[0] ?? 'nothing';
  return chosen.replace(/^(fatal|error):\s*/i, '').slice(0, 160);
}

/** Git refusing to commit because it has no name or email to put on the commit: the commonest first-commit failure. */
export function isIdentityProblem(output: string): boolean {
  return /tell me who you are|author identity unknown|unable to auto-detect email|no email was given|no name was given|empty ident/i.test(
    output
  );
}

// ── Failures ────────────────────────────────────────────────────────────────

/** Said when a `.git` this call made couldn't be removed again: the one case the folder is not as it was. */
const TAKE_OUT_BY_HAND =
  "I couldn't take the half-made git setup back out, so this folder now has an empty `.git` folder in it: delete that folder, or try again.";

const IDENTITY_WHY = "Git doesn't know your name and email yet, so it couldn't make the first commit.";
const IDENTITY_FIX =
  ' To fix that, run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"` in Terminal, then try again.';

function initFailed(dotGit: string, hadGit: boolean, output: string, options: GitSetupOptions): GitSetupResult {
  options.log(`git setup: git init failed (${gitSaid(output)})`);
  // A failed `git init` can still leave a partly written `.git` behind; one that was there before is not ours to touch.
  const after = hadGit || takeBackOut(dotGit, options) ? 'Nothing in the folder was changed.' : TAKE_OUT_BY_HAND;
  return failed('init-failed', `Git couldn't be set up in this folder (git said: "${gitSaid(output)}"). ${after}`);
}

function commitFailed(dotGit: string, hadGit: boolean, output: string, options: GitSetupOptions): GitSetupResult {
  options.log(`git setup: the first commit failed (${gitSaid(output)})`);
  const identity = isIdentityProblem(output);
  const why = identity ? IDENTITY_WHY : `Git couldn't make the first commit (git said: "${gitSaid(output)}").`;
  const after = hadGit
    ? 'The folder was already a git repository, so I left it as it was.'
    : takeBackOut(dotGit, options)
      ? 'I took the half-made git setup back out, so the folder is as it was.'
      : TAKE_OUT_BY_HAND;
  return failed('commit-failed', `${why} ${after}${identity ? IDENTITY_FIX : ''}`);
}

/** Removes the `.git` this call made. True once it is gone. */
function takeBackOut(dotGit: string, options: GitSetupOptions): boolean {
  try {
    fs.rmSync(dotGit, { recursive: true, force: true });
    options.log('git setup: took the .git it had just made back out');
    return true;
  } catch (error) {
    options.log(`git setup: could not remove the .git it had just made (${String(error)})`);
    return false;
  }
}

function noBinaryLine(platform: NodeJS.Platform = process.platform): string {
  return `Git isn't installed on this machine, so there is nothing to set git up with. ${gitInstallHint(platform)} Once it's installed, try again.`;
}

function failed(reason: GitSetupFailure, line: string): GitSetupResult {
  return { ok: false, reason, line };
}

// ── Running git ─────────────────────────────────────────────────────────────

interface GitRun {
  code: number;
  output: string;
  /** The git program itself couldn't be found. */
  missing: boolean;
}

/**
 * Git with arguments, never through a shell: nothing here is a command a model wrote, and there is no reason to
 * give a folder name the chance to be read as shell syntax. English output (`LC_ALL=C`), so a failure is recognised
 * whatever language the machine speaks.
 */
function runGit(root: string, args: string[], options: GitSetupOptions): Promise<GitRun> {
  return new Promise((resolve) => {
    const env = { ...(options.env ?? process.env), LC_ALL: 'C' };
    execFile(options.git ?? 'git', args, { cwd: root, env, timeout: 30_000 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`;
      if (!error) return resolve({ code: 0, output, missing: false });
      resolve({ code: typeof error.code === 'number' ? error.code : 1, output: output || error.message, missing: error.code === 'ENOENT' });
    });
  });
}

async function branchOf(root: string, options: GitSetupOptions): Promise<string | undefined> {
  const read = await runGit(root, ['symbolic-ref', '--short', 'HEAD'], options);
  return read.code === 0 ? read.output.trim() || undefined : undefined;
}

function isFolder(root: string): boolean {
  try {
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}
