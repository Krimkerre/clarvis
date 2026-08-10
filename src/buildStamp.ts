/**
 * When the running bundle was built.
 *
 * Replaced by esbuild at build time (`define`). The fallback matters for `npm test`,
 * which compiles with tsc and never sees the define — so this must not throw there.
 *
 * Exists because "installed" and "running" are different facts: a .vsix install
 * replaces the file on disk while the extension host keeps the previous bundle in
 * memory until the window reloads. A gate that was added five minutes ago will not
 * fire in a host that started ten minutes ago, and nothing about that is visible
 * without a stamp.
 */
declare const __CLARVIS_BUILD__: string | undefined;

export function buildStamp(): string {
  return typeof __CLARVIS_BUILD__ === 'string' ? __CLARVIS_BUILD__ : 'dev (unstamped)';
}
