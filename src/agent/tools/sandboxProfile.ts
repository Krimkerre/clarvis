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
 * Reads are still allowed — see below — so this stops destruction and persistence, and
 * does not by itself stop a command reading a secret. Saying so is part of the fix;
 * the previous version of this problem was a README claiming containment the code did
 * not have.
 *
 * **Network is denied by default, allowed per command (15 Aug, review item #3).** Most
 * commands — test runs, builds, linters — need no network at all, and a broad read plus
 * an open network is the one combination that lets a read become exfiltration. The
 * caller decides `allowNetwork` from the same gate classification that already stops a
 * dependency install or a `git push` for approval: those categories get network,
 * because they cannot function without it and are already a stop-and-ask. Everything
 * else runs with none, silently, which is the change — not a new prompt, a narrower
 * default.
 */

/** Where the profile is enforced from, or `undefined` when nothing here can. */
export type Sandbox = 'sandbox-exec' | 'bwrap';

/**
 * What one confined command may write to, and whether it may reach the network.
 *
 * **One value rather than three loose arguments, for two §0 reasons at once.**
 * `sandboxArgv` took six parameters — double the maximum — and four of them were the
 * same four `macProfile` took, assembled at the same call site three lines apart. And
 * `allowNetwork: boolean` was a flag argument on the two functions that decide what a
 * command can reach: `sandboxArgv(sandbox, path, ws, caches, cmd, false)` gave no hint
 * at the call site which `false` that was, on the one boundary in this codebase where
 * being wrong is a containment failure rather than a wrong sentence.
 *
 * `network` is a named state rather than a boolean for the same reason: `'denied'`
 * cannot be confused with `'allowed'` by a caller that got the polarity backwards, and
 * a wrong polarity here is exactly the class of mistake `isInside()` made about
 * filesystem case-sensitivity — silent, and wrong in the permissive direction.
 */
export interface Confinement {
  /** The project folder, resolved — a symlinked path matches no rule. See `macProfile`. */
  workspace: string;
  /** Build caches a toolchain genuinely needs to write to. */
  caches: readonly string[];
  network: 'denied' | 'allowed';
}

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
export function macProfile(confinement: Confinement): string {
  const { workspace, caches, network } = confinement;
  const writable = [workspace, ...caches].filter(Boolean);

  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    ...writable.map((path) => `(allow file-write* (subpath ${quote(path)}))`),
    `(allow file-write* ${DEVICES.map((device) => `(literal ${quote(device)})`).join(' ')})`,
    // Terminals and pipes, which are how output reaches the caller at all.
    '(allow file-write* (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    // Last-match-wins, same as the write rules above: deny after the blanket allow,
    // narrowed back open only for the commands the gate already trusts with it.
    ...(network === 'allowed' ? [] : ['(deny network*)']),
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
  sandbox: { kind: Sandbox; profilePath: string },
  confinement: Confinement,
  command: string
): { file: string; args: string[] } {
  if (sandbox.kind === 'sandbox-exec') {
    return { file: 'sandbox-exec', args: ['-f', sandbox.profilePath, '/bin/sh', '-c', command] };
  }

  const { workspace, caches, network } = confinement;

  // bubblewrap takes the opposite shape: everything is read-only unless bound
  // writable, which reaches the same guarantee from the other direction.
  const binds = [workspace, ...caches].filter(Boolean).flatMap((path) => ['--bind', path, path]);
  // `--unshare-net` gives the command its own network namespace with no interfaces —
  // not a firewall rule to get wrong, an absence of network to have an opinion about.
  const net = network === 'allowed' ? [] : ['--unshare-net'];

  return {
    file: 'bwrap',
    args: ['--ro-bind', '/', '/', '--dev', '/dev', '--tmpfs', '/tmp', ...net, ...binds, '/bin/sh', '-c', command],
  };
}
