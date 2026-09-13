/**
 * Reading the Clarvis credential for RAVIS from a file, for desktop VS Code (plan.md M15, C1).
 *
 * **Why a file.** Every code-server window gets the launcher's `client.clarvis` credential in its
 * environment. Desktop VS Code isn't started by the launcher, so it reads the same credential from the
 * file named in the machine-scoped setting `clarvis.ravis.credentialFile`, which the owner sets once
 * to the launcher's `.run/clarvis-ravis.token`. Nothing here reads a setting: the caller passes the
 * path it found.
 *
 * **What is refused.** The same things the Bridge refuses for its enrolment secret
 * (`src/bridge/secretFile.ts`): a symlink, anything that isn't a regular file, and a file other users
 * can read. A relative path is refused too, since it would resolve against wherever the extension
 * host happened to start. The credential itself is never logged or returned in a reason.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifySecretFile, type SecretFileVerdict } from '../../bridge/secretFile';

export type CredentialFileRead =
  | { ok: true; credential: string }
  | {
      ok: false;
      reason: 'not_set' | 'not_absolute' | 'missing' | 'unreadable' | 'empty' | Exclude<SecretFileVerdict, 'ok'>;
    };

/** Reads the credential from `setting`, the value of `clarvis.ravis.credentialFile`. */
export function readCredentialFile(
  setting: string | undefined,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir()
): CredentialFileRead {
  const file = expandHome(setting, home);
  if (file === '') return { ok: false, reason: 'not_set' };
  if (!path.isAbsolute(file)) return { ok: false, reason: 'not_absolute' };
  const stats = lstatOrReason(file);
  if (!('isFile' in stats)) return stats;
  const verdict = verifySecretFile(stats, platform);
  if (verdict !== 'ok') return { ok: false, reason: verdict };
  return credentialIn(file);
}

/** `~/…` is how people type a path into a setting; nothing else is expanded. */
function expandHome(setting: string | undefined, home: string): string {
  const value = (setting ?? '').trim();
  return value === '~' || value.startsWith('~/') ? path.join(home, value.slice(1)) : value;
}

function lstatOrReason(file: string): fs.Stats | { ok: false; reason: 'missing' | 'unreadable' } {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { ok: false, reason: missing ? 'missing' : 'unreadable' };
  }
}

function credentialIn(file: string): CredentialFileRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const credential = text.trim();
  if (credential === '') return { ok: false, reason: 'empty' };
  // One token, one line. Anything with whitespace inside is not a credential this file should hold.
  return /\s/.test(credential) ? { ok: false, reason: 'unreadable' } : { ok: true, credential };
}
