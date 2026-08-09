import * as vscode from 'vscode';

/**
 * Whether the voice offer has already been made.
 *
 * **Global, not workspace-scoped.** Someone who said no once meant no — repeating the
 * question in every project they open is precisely the nagging this whole product is
 * written against (§6). Deliberately never reset, including on a version bump.
 */
const ASKED_KEY = 'clarvis.voice.firstRunOffered';

/** Long enough for the launch briefing to land first, so two things don't arrive at once. */
const OFFER_DELAY_MS = 4000;

/** Where a Fish Audio key comes from. Shown, not silently opened. */
const FISH_KEYS_URL = 'https://fish.audio/go-api/';

/**
 * Offers to set voice up, exactly once, ever.
 *
 * Voice ships off (§4.4) because a voice that surprises you once is a voice you disable
 * forever — but a feature nobody discovers is the same as a feature nobody has. So the
 * offer is made once, plainly, and then the subject is closed permanently: three
 * answers, and two of them are final.
 *
 * Returns immediately; everything happens on a timer so activation is never delayed.
 */
export function offerVoiceSetup(
  context: vscode.ExtensionContext,
  hasKey: () => Promise<boolean>,
  log: (message: string) => void
): void {
  if (context.globalState.get<boolean>(ASKED_KEY)) return;

  const timer = setTimeout(() => void ask(context, hasKey, log), OFFER_DELAY_MS);
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
}

async function ask(
  context: vscode.ExtensionContext,
  hasKey: () => Promise<boolean>,
  log: (message: string) => void
): Promise<void> {
  // A key already stored means this was set up on another machine and synced, or the
  // user got there first. Asking anyway would look like Clarvis wasn't paying attention.
  if (await hasKey()) {
    await context.globalState.update(ASKED_KEY, true);
    log('voice: first-run offer skipped, a key is already stored');
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Clarvis: I can say all this out loud, in a voice that suits me rather than your operating system's. It needs a Fish Audio key — free tier, yours, stored in your keychain.",
    'I have a key',
    'Where do I get one?',
    'No thanks'
  );

  // Every branch below records that the offer was made. Dismissing it with Escape
  // leaves `choice` undefined, and that is an answer too — a notification ignored is
  // not an invitation to ask again tomorrow.
  await context.globalState.update(ASKED_KEY, true);
  log(`voice: first-run offer answered "${choice ?? 'dismissed'}"`);

  if (choice === 'I have a key') {
    await vscode.commands.executeCommand('clarvis.setFishKey');
    return;
  }

  if (choice === 'Where do I get one?') {
    // Shown as a link the user chooses to follow, rather than a browser opening
    // uninvited. The setting stays off either way; they can enable it when ready.
    const next = await vscode.window.showInformationMessage(
      `Clarvis: sign in at ${FISH_KEYS_URL} and create an API key, then run "Clarvis: Set Fish Audio Key". I won't bring it up again.`,
      'Open the page',
      'Later'
    );

    if (next === 'Open the page') {
      await vscode.env.openExternal(vscode.Uri.parse(FISH_KEYS_URL));
    }
  }
}

/**
 * Turns voice on, once a key exists.
 *
 * Setting a key is an unambiguous request for the feature it enables, so leaving the
 * master switch off afterwards would mean the user does everything asked of them and
 * still hears nothing — the worst possible outcome of a setup flow.
 */
export async function enableVoiceAfterKey(log: (message: string) => void): Promise<void> {
  const config = vscode.workspace.getConfiguration('clarvis');
  if (config.get<boolean>('voice.enabled', false)) return;

  await config.update('voice.enabled', true, vscode.ConfigurationTarget.Global);
  log('voice: enabled, since a key was just set');
  void vscode.window.showInformationMessage('Clarvis: voice is on. Mute is beside the chat prompt.');
}
