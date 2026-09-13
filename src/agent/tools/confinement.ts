/**
 * Telling a confined command's failure apart from a broken machine.
 *
 * **This exists because Clarvis gave dangerous advice.** A run needed Go, tried
 * `brew install go`, and the sandbox refused the writes to `/opt/homebrew` — correctly,
 * that is the whole point of confining it. Homebrew has no idea it is sandboxed, so it
 * reported the only cause it knows for a write it cannot make: bad ownership, fix it
 * with `sudo chown -R`. Clarvis relayed that to the user as fact. The directory was
 * owned by them and perfectly writable; following the advice would have meant running
 * a recursive chown over a working Homebrew install to fix a problem that did not
 * exist.
 *
 * A tool cannot see its own sandbox. The one component that knows is the one that put
 * it there, so it says so — attached to the failure, where the misreading happens.
 */

/**
 * Failures that a write restriction plausibly caused.
 *
 * Matched rather than always appended: a note on *every* failed command teaches the
 * model to blame the sandbox for compile errors and failing tests, which is a worse
 * misdiagnosis than the one being fixed.
 */
const DENIED_WRITE =
  /operation not permitted|permission denied|read-?only file system|not writable|insufficient permissions|\bEACCES\b|\bEPERM\b|\bEROFS\b|sudo chown/i;

/**
 * Failures a denied network plausibly caused.
 *
 * The same false-diagnosis risk as `DENIED_WRITE`, one layer down: `curl: (6) Could
 * not resolve host` and `connect ETIMEDOUT` read exactly like a real outage, and a
 * model told to fix a flaky network has no way to discover the network was never
 * there to begin with.
 */
const DENIED_NETWORK =
  /could not resolve host|connection refused|network is unreachable|\bENOTFOUND\b|\bECONNREFUSED\b|\bEHOSTUNREACH\b|\bETIMEDOUT\b|curl: \(([67])\)/i;

/**
 * A server that could not open its port.
 *
 * **Checked first, because it reads exactly like a denied write.** Found live, 13 September
 * 2026: a check started a web server, Python's `socket.bind` raised `PermissionError: [Errno
 * 1] Operation not permitted`, and that phrase matches `DENIED_WRITE` — so the note attached
 * would have blamed write access to the workspace for a port that could never be opened.
 * Python puts `bind` and the error on different lines, hence the short window; Node says
 * `listen EPERM`, Go says `bind: operation not permitted`.
 */
const DENIED_BIND = /\bbind\b[\s\S]{0,200}?(?:operation not permitted|permission denied)|\blisten E(?:PERM|ACCES)\b/i;

/**
 * What to add to a failed command's result, if anything.
 *
 * Written to the model rather than the user: it is the one deciding what to tell them
 * next, and the instruction it needs is "do not repeat this diagnosis".
 */
export function confinementNote(
  confined: boolean,
  exitCode: number | undefined,
  output: string,
  networkAllowed = true
): string | undefined {
  if (!confined || exitCode === 0) return undefined;

  if (!networkAllowed && DENIED_BIND.test(output)) {
    return [
      'Note: this ran confined with no network — nothing it starts can listen on a port, localhost included.',
      'A bind or listen failure here is that, not a port already in use or a permissions problem on the machine.',
      'Do not retry on another port or start the server some other way.',
      'Check it in-process instead: call its handler with a test client or a fake request,',
      'and say that is how it was checked.',
    ].join(' ');
  }

  if (!networkAllowed && DENIED_NETWORK.test(output)) {
    return [
      'Note: this ran confined with no network — most commands get none by default.',
      'A DNS or connection failure here is that, not a real outage or a missing service.',
      "Do not repeat the tool's diagnosis or suggest checking the user's internet:",
      'it is about to describe a working network as down.',
      'If the command genuinely needs the network, say so and stop rather than retrying —',
      'that is a decision for the user, not something to route around.',
    ].join(' ');
  }

  if (!DENIED_WRITE.test(output)) return undefined;

  return [
    'Note: this ran confined — writes are limited to the workspace and the build caches.',
    'A permissions failure outside those is this sandbox, not the machine.',
    "Do not repeat the tool's diagnosis or suggest `sudo`, `chown` or changing ownership:",
    'it is about to describe a working system as broken.',
    'Anything installed system-wide has to be installed by the user, not by you —',
    'say what is missing and ask for it, or work with what is already here.',
  ].join(' ');
}
