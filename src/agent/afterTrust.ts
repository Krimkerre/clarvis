/**
 * Starting what Restricted Mode kept off, when the folder is trusted after the window opened.
 *
 * The Bridge and the branch flow decide once, at activation, and a folder trusted a minute later
 * used to leave both off until a window reload — seen in the attended session of 17 September
 * 2026, where the log kept saying the workspace was untrusted after the owner had trusted it.
 * Everything else that cares asks `isTrusted` each time it acts, so it needs nothing from here.
 *
 * vscode-free: the host hands in how to ask and how to listen.
 */

export interface TrustSource {
  trusted(): boolean;
  /** VS Code's `workspace.onDidGrantWorkspaceTrust`: trust is never taken back within a window. */
  onGrant(listener: () => void): { dispose(): void };
}

/**
 * Runs `start` now when the folder is trusted, or once when it becomes trusted.
 * The returned handle stops the waiting; disposing it after `start` ran does nothing.
 */
export function whenTrusted(source: TrustSource, start: () => void): { dispose(): void } {
  if (source.trusted()) {
    start();
    return { dispose: () => undefined };
  }
  let done = false;
  const waiting = source.onGrant(() => {
    if (done) return;
    done = true;
    waiting.dispose();
    start();
  });
  return waiting;
}
