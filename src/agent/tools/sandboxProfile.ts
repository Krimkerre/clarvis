/**
 * Confining what a command may change, at the kernel rather than by reading it.
 *
 * **The deny-list and the shell-privileges finding are one problem.** A security
 * review raised both: `runCommand` uses `shell: true`, so the workspace boundary that
 * governs the file tools does not apply to it; and the deny-list is string matching,
 * so `python -c "shutil.rmtree(...)"` walks past it. The second is a consequence of
 * the first. A command that runs with the user's full authority has to be *inspected*
 * to be made safe, inspection is pattern matching, and pattern matching against a
 * shell is a game you lose eventually.
 *
 * Reduce the authority and the inspection stops being load-bearing. The kernel does
 * not care which interpreter asked.
 *
 * **The guarantee, stated exactly:** a command cannot modify anything outside the
 * project folder and the build caches it needs. Not "sandboxed", which means nothing.
 * Reads are still allowed and the network is still open — see below — so this stops
 * destruction and persistence, and does not stop a command reading a secret and
 * sending it somewhere. Saying so is part of the fix; the previous version of this
 * problem was a README claiming containment the code did not have.
 */

/** Where the profile is enforced from, or `undefined` when nothing here can. */
export type Sandbox = 'sandbox-exec' | 'bwrap';

/**
 * Writable paths a build genuinely needs beyond the project itself.
 *
 * **Every one of these was earned by something breaking.** The first profile denied
 * `/dev/null`, which is in roughly every shell script ever written, and every
 * command that redirected output failed with "Operation not permitted" — a sandbox
 * that breaks `>/dev/null` gets switched off within a day and protects nobody.
 *
 * Kept deliberately short. Each entry is somewhere a toolchain writes and nobody
 * keeps anything they would miss; anywhere a *person* keeps things stays denied.
 */
const DEVICES = ['/dev/null', '/dev/dtracehelper', '/dev/zero', '/dev/random', '/dev/urandom'];

/**
 * The macOS profile, in SBPL.
 *
 * `allow default` then `deny file-write*` then narrower allows: the language is
 * last-match-wins, so the order is the meaning rather than a style.
 *
 * **Paths must be resolved before they get here.** `/tmp` is a symlink to
 * `/private/tmp` on macOS, and a rule written against the symlink matches nothing —
 * discovered by writing one, watching it deny a write it had explicitly allowed, and
 * being unable to tell the difference from the sandbox working.
 */
export function macProfile(workspace: string, caches: readonly string[]): string {
  const writable = [workspace, ...caches].filter(Boolean);

  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    ...writable.map((path) => `(allow file-write* (subpath ${quote(path)}))`),
    `(allow file-write* ${DEVICES.map((device) => `(literal ${quote(device)})`).join(' ')})`,
    // Terminals and pipes, which are how output reaches the caller at all.
    '(allow file-write* (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
  ].join('\n');
}

/**
 * Escapes a path for SBPL.
 *
 * A workspace path is user-controlled — it is wherever they keep their code — and a
 * quote or backslash in it would end the string early and change what the rest of the
 * profile means. A profile that can be broken by a folder name is not a boundary.
 */
function quote(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The argv that runs `command` confined, given a sandbox and the writable paths. */
export function sandboxArgv(
  sandbox: Sandbox,
  profilePath: string,
  workspace: string,
  caches: readonly string[],
  command: string
): { file: string; args: string[] } {
  if (sandbox === 'sandbox-exec') {
    return { file: 'sandbox-exec', args: ['-f', profilePath, '/bin/sh', '-c', command] };
  }

  // bubblewrap takes the opposite shape: everything is read-only unless bound
  // writable, which reaches the same guarantee from the other direction.
  const binds = [workspace, ...caches].filter(Boolean).flatMap((path) => ['--bind', path, path]);

  return {
    file: 'bwrap',
    args: ['--ro-bind', '/', '/', '--dev', '/dev', '--tmpfs', '/tmp', ...binds, '/bin/sh', '-c', command],
  };
}
