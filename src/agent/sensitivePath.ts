/**
 * Deciding which files are likely secrets, by name alone.
 *
 * §4.6: reads are never gated — approving a read six times teaches you to click yes
 * without looking, which is worse than no gate at all. This is the one deliberate
 * exception. The workspace boundary is a location boundary, not a sensitivity one:
 * `.env` inside the workspace is exactly as readable as `README.md` unless something
 * says otherwise. This says otherwise.
 *
 * Pure and name-based, same shape as `Gate.ts`: no file contents are read to decide,
 * so classifying a file costs nothing and never itself leaks what it's protecting.
 */

export type Sensitivity = 'secret' | 'key';

export interface SensitivityVerdict {
  category: Sensitivity;
  /** What kind of thing this looks like, for the approval prompt. */
  what: string;
  /** The realistic cost of being wrong about approving it. */
  worstCase: string;
}

/** Filenames and patterns that are almost always secrets, never source. */
const SECRET_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /(^|\/)\.env(\..+)?$/i, what: 'an environment file — the standard place API keys and passwords live' },
  { pattern: /(^|\/)\.npmrc$/i, what: 'an npm config file, which can carry a registry auth token' },
  { pattern: /(^|\/)\.netrc$/i, what: 'a netrc file — saved credentials for remote hosts' },
  { pattern: /(^|\/)credentials(\.json)?$/i, what: 'a file named for holding credentials' },
  { pattern: /(^|\/)\.aws\/credentials$/i, what: 'AWS credentials' },
  { pattern: /(^|\/)service[-_]?account.*\.json$/i, what: 'a cloud service-account key' },
  { pattern: /(^|\/)\.pgpass$/i, what: 'saved database passwords' },
  { pattern: /(^|\/)secrets?\.ya?ml$/i, what: 'a file named for holding secrets' },
];

/** Known private-key material — the one category worth blocking outright, not just gating. */
const KEY_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/, what: 'an SSH private key' },
  { pattern: /\.pem$/i, what: 'a PEM-encoded key or certificate' },
  { pattern: /\.pfx$/i, what: 'a PKCS#12 key bundle' },
  { pattern: /\.p12$/i, what: 'a PKCS#12 key bundle' },
];

/**
 * Classifies a workspace-relative path, or says it's ordinary.
 *
 * Matched on the path as given, not resolved further — the caller already resolved and
 * confined it (`resolveInWorkspace`), and re-deriving that here would be a second,
 * divergent copy of a rule that must only exist once.
 */
export function classifyPath(relativePath: string): SensitivityVerdict | undefined {
  for (const { pattern, what } of KEY_PATTERNS) {
    if (pattern.test(relativePath)) {
      return { category: 'key', what, worstCase: 'the key itself reaches a model, and a leaked private key has to be revoked, not just rotated' };
    }
  }

  for (const { pattern, what } of SECRET_PATTERNS) {
    if (pattern.test(relativePath)) {
      return { category: 'secret', what, worstCase: 'a live credential reaches a model and, from there, whatever that model sends it to' };
    }
  }

  return undefined;
}
