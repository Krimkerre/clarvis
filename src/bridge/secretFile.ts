/**
 * Whether a file is safe to read as NERVIS's enrollment secret.
 *
 * Host-free on purpose, like the rest of `src/bridge/` outside `wire.ts`
 * (that file's own docstring explains why): this takes a `Stats`, not a path,
 * so the fast suite can construct one directly instead of needing a real
 * filesystem fixture for every case.
 *
 * **A symlink or a directory is refused, not followed or read.** The setting
 * names one file; something else deciding what actually gets opened is the
 * exact shape of the Stage 1 finding this exists to close (§16 item 1).
 */

import type { Stats } from 'fs';

export type SecretFileVerdict = 'ok' | 'symlink' | 'not-a-file' | 'loose-permissions';

/** One sentence per verdict, for the log line that names why a secret was refused. */
export const VERDICT_REASON: Record<Exclude<SecretFileVerdict, 'ok'>, string> = {
  symlink: 'is a symlink',
  'not-a-file': 'is not a regular file',
  'loose-permissions': 'is not mode 0600',
};

/**
 * `platform` is a parameter rather than a read of `process.platform` so the
 * Windows branch is reachable from a test running on any OS.
 *
 * Permission bits are not meaningful on Windows — there is no POSIX mode to
 * check, and `stats.mode` there does not reflect ACL-based protection. The
 * file-type check is the only guard that applies on that platform.
 */
export function verifySecretFile(
  stats: Pick<Stats, 'isSymbolicLink' | 'isFile' | 'mode'>,
  platform: NodeJS.Platform = process.platform
): SecretFileVerdict {
  if (stats.isSymbolicLink()) return 'symlink';
  if (!stats.isFile()) return 'not-a-file';
  if (platform !== 'win32' && (stats.mode & 0o777) !== 0o600) return 'loose-permissions';
  return 'ok';
}
