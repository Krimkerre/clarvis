import { execFile } from 'child_process';

/**
 * Whether `git` exists on this machine at all.
 *
 * Asked only when something has already gone wrong — the Git extension found no
 * repository — because that state has two very different causes that look identical from
 * the API: an ordinary folder, and a machine with no git. Offering to run `git init` on
 * the second is a button that can only fail.
 *
 * Cached after the first answer: git does not get uninstalled mid-session, and this sits
 * in front of a user waiting to find out why their run is not isolated.
 */
let known: boolean | undefined;

export function hasGitBinary(): Promise<boolean> {
  if (known !== undefined) return Promise.resolve(known);

  return new Promise((resolve) => {
    execFile('git', ['--version'], { timeout: 3000 }, (error) => {
      known = !error;
      resolve(known);
    });
  });
}
