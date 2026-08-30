/**
 * Where rendered speech has to be played to reach the person listening.
 *
 * **The bug this exists for.** Tier 1 audio is played by spawning a system
 * player from the extension host. On desktop that is the user's own machine and
 * it is the right thing to do — no encoding, no round trip. Under code-server
 * the extension host is a *server*, so the audio comes out of the server's
 * speakers and the person in the browser hears nothing. Stage 9 graded that a
 * `FAIL` and noted Clarvis could not even detect the split.
 *
 * **Two axes, because they catch different deployments.** `uiKind` is `Web`
 * whenever the workbench is a browser — code-server, a tunnel, github.dev — and
 * says nothing about where the extension host runs. `remoteName` is set
 * whenever the extension host is not the local machine — Remote SSH, WSL, a
 * dev container — and says nothing about the UI. Either one alone leaves a real
 * deployment misrouted:
 *
 *   - code-server: `uiKind` is `Web`; what `remoteName` reports there varies by
 *     version, which is exactly why this does not depend on it.
 *   - Remote SSH from desktop VS Code: `uiKind` is `Desktop` and the host is
 *     still someone else's machine.
 *
 * So the rule is the disjunction, and the only case that keeps local playback is
 * the one where both say local.
 */
export type AudioDestination = 'host' | 'webview';

/** `1` in the VS Code API, but this module must not import `vscode`. */
export const UI_KIND_WEB = 2;

export function audioDestination(
  uiKind: number | undefined,
  remoteName: string | undefined
): AudioDestination {
  if (uiKind === UI_KIND_WEB) return 'webview';
  if (remoteName) return 'webview';
  return 'host';
}

/** Why the destination is what it is, for the log line that records the choice. */
export function audioDestinationReason(
  uiKind: number | undefined,
  remoteName: string | undefined
): string {
  if (uiKind === UI_KIND_WEB) return 'the workbench is a browser';
  if (remoteName) return `the extension host is remote (${remoteName})`;
  return 'the extension host is this machine';
}
