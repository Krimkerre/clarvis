/**
 * Where M13's copy reads from and how far it had got — the decisions, without `vscode`, so
 * the fast suite can check them (19 September 2026).
 *
 * **The source is this window's extension-host log**, found beside this extension's own log
 * folder (`context.logUri`), which the editor places inside the current window's
 * extension-host log directory on every host. The file there is `exthost.log` in desktop VS
 * Code and `remoteexthost.log` in code-server and remote windows. Until 0.17.21 the feature
 * `find`-ed a desktop-only `1-main.log` by newest time: nothing on desktop (the file is called
 * `main.log` and is the main process's), the wrong editor on code-server, and possibly another
 * window's log.
 */

import * as path from 'path';

/** The extension-host log's name, per host: desktop first, then code-server and remote. */
export const HOST_LOG_NAMES = ['exthost.log', 'remoteexthost.log'] as const;

/** Past this size the copy is set aside as `vscode.log.1` when copying starts, keeping one. */
export const ROTATE_BYTES = 20 * 1024 * 1024;

/** The extension-host log of the window whose extension log folder is `extensionLogDir`. */
export function hostLogFor(
  extensionLogDir: string,
  exists: (file: string) => boolean
): string | undefined {
  const folder = path.dirname(extensionLogDir);
  return HOST_LOG_NAMES.map((name) => path.join(folder, name)).find(exists);
}

/** How far the copy got last time, per workspace, so a restart neither repeats nor skips. */
export interface Progress {
  readonly source: string;
  readonly offset: number;
}

/**
 * The byte to start copying from. The same source, not shrunk since: where it stopped. A new
 * source — a new window or editor session — or one that shrank: from its beginning, since
 * everything in it is new to the copy.
 */
export function startOffset(saved: Progress | undefined, source: string, size: number): number {
  if (!saved || saved.source !== source || saved.offset > size || saved.offset < 0) return 0;
  return saved.offset;
}

/** `tail`'s arguments to follow `source` from byte `offset` (its `+N` counts from 1). */
export function tailArguments(source: string, offset: number): string[] {
  return ['-c', `+${offset + 1}`, '-f', source];
}
