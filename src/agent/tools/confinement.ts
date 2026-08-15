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
 * What to add to a failed command's result, if anything.
 *
 * Written to the model rather than the user: it is the one deciding what to tell them
 * next, and the instruction it needs is "do not repeat this diagnosis".
 */
export function confinementNote(confined: boolean, exitCode: number | undefined, output: string): string | undefined {
  if (!confined || exitCode === 0) return undefined;
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
