/**
 * The RAVIS credential the ecosystem's launcher hands to code-server, when it is safe to send.
 *
 * **Why Clarvis needs one.** RAVIS gives an unnamed caller sixty requests a minute and a
 * named one six hundred, and every unnamed caller on this machine shares the same sixty.
 * Measured on 11 September 2026: the NERVIS dashboard, open in a browser, reads RAVIS
 * directly about twenty-four times a minute, which left a Clarvis build roughly thirty-six
 * before RAVIS turned it away. NERVIS already presents a credential the launcher mints;
 * Clarvis now presents its own the same way, so a build never shares an allowance with a
 * screen somebody left open.
 *
 * **Never sent anywhere else.** The token belongs to this machine's RAVIS, so it is offered
 * only to a loopback address and only for a `ravis/` model. A custom endpoint on another
 * host, or a model that is not RAVIS's, gets nothing — a credential sent to the wrong host
 * is a credential given away.
 *
 * Pure, so every refusal below runs under `node --test`.
 */

/** Set by the ecosystem launcher (`tools/run.py`) in code-server's environment. */
export const LAUNCHER_CREDENTIAL_ENV = 'CLARVIS_RAVIS_CREDENTIAL';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** The launcher's token, for a RAVIS model on this machine; otherwise nothing. */
export function launcherCredential(
  env: Record<string, string | undefined>,
  baseUrl: string,
  model: string
): string | undefined {
  const token = env[LAUNCHER_CREDENTIAL_ENV]?.trim();
  if (!token || !model.startsWith('ravis/')) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  return LOOPBACK.has(host) ? token : undefined;
}
