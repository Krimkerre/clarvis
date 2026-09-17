/**
 * **Clarvis: Turn the Bridge On or Off**: a way to switch the Bridge where the settings screen
 * does not show it.
 *
 * `clarvis.bridge.enabled` is machine-scoped so a project cannot switch it on, and code-server's
 * settings screen leaves machine-scoped settings out; the owner could only change it by editing
 * the settings file (attended session, 17 September 2026). This command writes the same user
 * setting, and only that one — never a workspace or folder value — so the reason for the scope
 * stands: a command runs because a person chose it, a project's settings file does not.
 *
 * The change takes effect when the window reloads, which is how the setting has always been
 * read; the command offers the reload.
 *
 * vscode-free: the host hands in the setting and the dialogs.
 */

export interface TogglePorts {
  /** The value in force now. */
  enabled(): boolean;
  /** Writes the user (machine) value. */
  write(value: boolean): Promise<void>;
  /** A modal question with one action; true when it was chosen. */
  confirm(question: string, detail: string, action: string): Promise<boolean>;
  /** Says the new state and offers to reload the window; true when the reload was chosen. */
  offerReload(text: string): Promise<boolean>;
  reload(): Promise<void>;
  /** A line in the Clarvis chat. */
  tell(text: string): void;
}

export const TOGGLE_LINES = {
  onQuestion: 'Turn the Bridge on?',
  onDetail:
    'NERVIS gets to see what this window is doing — its state, its problem counts, its model calls — and nothing more: ' +
    'the Bridge cannot approve a step, run a command or change a setting. It stays on for every window on this machine until you turn it off.',
  offQuestion: 'Turn the Bridge off?',
  offDetail: 'NERVIS stops seeing this window. Clarvis itself keeps working as before.',
  on: 'The Bridge is on from the next window reload.',
  off: 'The Bridge is off from the next window reload.',
  notTaken: "The setting was written, but a different value is still in force — check `clarvis.bridge.enabled` in your settings file.",
} as const;

export async function toggleBridge(ports: TogglePorts): Promise<void> {
  const turningOn = !ports.enabled();
  const asked = turningOn
    ? await ports.confirm(TOGGLE_LINES.onQuestion, TOGGLE_LINES.onDetail, 'Turn On')
    : await ports.confirm(TOGGLE_LINES.offQuestion, TOGGLE_LINES.offDetail, 'Turn Off');
  if (!asked) return;

  await ports.write(turningOn);
  if (ports.enabled() !== turningOn) {
    ports.tell(TOGGLE_LINES.notTaken);
    return;
  }
  const line = turningOn ? TOGGLE_LINES.on : TOGGLE_LINES.off;
  ports.tell(line);
  if (await ports.offerReload(line)) await ports.reload();
}
