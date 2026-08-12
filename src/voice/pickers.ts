import * as vscode from 'vscode';
import { ENGINES, isKnownEngine } from './enginePicker';
import { FishAudioProvider } from './FishAudioProvider';
import { VoiceService } from './VoiceService';
import { CURATED_VOICES } from './curatedVoices';
import { phrase } from '../personality/Voice';
import { readSavedVoices, withSavedVoice, SavedVoice } from './savedVoices';

/**
 * Spoken when auditioning a voice, per §4.5 — a fixed line, so voices are compared
 * like for like and the comparison is cached after the first hearing.
 */
const PREVIEW_LINE = "Your build finished. I've alerted no one.";

/**
 * How long a row must stay selected before it previews.
 *
 * Arrowing down a list of twenty voices shouldn't fire twenty renders. Anything
 * already heard is cached, so only genuinely new voices cost a request.
 */
const PREVIEW_DEBOUNCE_MS = 600;

/** Placeholder shape only — deliberately not a real id (§4.5). */
const ID_PLACEHOLDER = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

interface VoiceItem extends vscode.QuickPickItem {
  /** Setting value this row selects, or undefined for the paste-an-id action. */
  value?: string;
  action?: 'paste';
}

/**
 * Lets the user choose a voice by ear.
 *
 * Voice and engine are separate choices and are picked separately: the voice is *who
 * it sounds like*, the engine is *how well and how fast it says it*.
 */
export async function chooseVoice(
  fish: FishAudioProvider,
  voice: VoiceService,
  log: (message: string) => void
): Promise<void> {
  const items: VoiceItem[] = [
    {
      label: '$(person) System voice',
      description: 'free, offline',
      detail: 'Your OS reading the lines. Always available; it does not perform them.',
      value: 'system',
    },
    {
      label: '$(add) Paste a Fish Audio voice ID…',
      detail: 'Any voice you have found. Yours to choose — see the prompt for where to find one.',
      action: 'paste',
    },
  ];

  // Voices the user pasted in and named. Listed above the shipped one: someone who has
  // gone to the trouble of saving a voice is more likely to want it than the default.
  const saved = currentSavedVoices();
  if (saved.length > 0) {
    items.push({ label: 'Saved', kind: vscode.QuickPickItemKind.Separator } as VoiceItem);
    for (const voice of saved) {
      items.push({
        label: `$(unmute) ${voice.name}`,
        description: voice.id.slice(0, 8),
        value: `fish:${voice.id}`,
      });
    }
  }

  items.push({ label: 'Shipped', kind: vscode.QuickPickItemKind.Separator } as VoiceItem);
  for (const curated of CURATED_VOICES) {
    items.push({
      label: `$(unmute) ${curated.label}`,
      detail: curated.detail,
      value: `fish:${curated.id}`,
    });
  }

  // The user's own Fish Audio models, if a key exists. Absent is a normal state.
  const own = await fish.listOwnVoices();
  if (own.length > 0) {
    items.push({ label: 'Your Fish Audio voices', kind: vscode.QuickPickItemKind.Separator } as VoiceItem);
    for (const model of own) {
      items.push({
        label: `$(unmute) ${model.title}`,
        description: model.id.slice(0, 8),
        value: `fish:${model.id}`,
      });
    }
  }

  const picked = await showWithPreview(items, voice, log);
  if (!picked) return;

  const value = picked.action === 'paste' ? await promptForVoiceId(fish, log) : picked.value;
  if (!value) return;

  await writeSetting('voice.selectedVoice', value);
  void vscode.window.showInformationMessage(await phrase('report', `Voice set to ${value}.`, [value]));
}

/**
 * Writes a setting to the scope that will actually take effect.
 *
 * Writing Global unconditionally looks like it works and then does nothing whenever a
 * workspace value exists, because workspace settings win — the picker appears to
 * "snap back" to the previous voice. So: if the value is already defined for this
 * workspace, update it there; otherwise fall back to the user's global settings.
 */
async function writeSetting(key: string, value: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration('clarvis');
  const scope = config.inspect(key)?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

  await config.update(key, value, scope);
}

/** The user's named voices, as stored in settings. */
function currentSavedVoices(): SavedVoice[] {
  return readSavedVoices(
    vscode.workspace.getConfiguration('clarvis').get('voice.savedVoices')
  );
}

/**
 * Shows the list, auditioning whichever row is highlighted.
 *
 * Previewing on selection is what makes this a choice by ear rather than by name — a
 * voice id tells you nothing about how it sounds.
 */
function showWithPreview(
  items: VoiceItem[],
  voice: VoiceService,
  log: (message: string) => void
): Promise<VoiceItem | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<VoiceItem>();
    quickPick.items = items;
    quickPick.placeholder = 'Choose a voice — highlight one to hear it';
    quickPick.matchOnDetail = true;

    let timer: ReturnType<typeof setTimeout> | undefined;

    quickPick.onDidChangeActive(([active]) => {
      clearTimeout(timer);

      // Captured, because the narrowing above doesn't survive into the timer callback.
      const value = active?.value;
      if (!value || value === 'system') return;

      timer = setTimeout(() => {
        log(`voice: previewing ${value}`);
        voice.preview(PREVIEW_LINE, value);
      }, PREVIEW_DEBOUNCE_MS);
    });

    quickPick.onDidAccept(() => {
      clearTimeout(timer);
      const [selected] = quickPick.selectedItems;
      quickPick.hide();
      resolve(selected);
    });

    quickPick.onDidHide(() => {
      clearTimeout(timer);
      quickPick.dispose();
      resolve(undefined);
    });

    quickPick.show();
  });
}

/**
 * Asks for a voice id, and proves it works before saving it.
 *
 * Validating here means a bad id fails at the picker rather than silently mid-briefing
 * three days later. The field shows the *shape* of an id and where to find one — but
 * names no voice, which is the §4.4 distinction between usability and recommendation.
 */
async function promptForVoiceId(
  fish: FishAudioProvider,
  log: (message: string) => void
): Promise<string | undefined> {
  const id = await vscode.window.showInputBox({
    prompt: 'Open a voice on fish.audio and copy the identifier from its page URL.',
    placeHolder: ID_PLACEHOLDER,
    ignoreFocusOut: true,
  });
  if (!id) return undefined;

  const trimmed = id.trim();
  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Clarvis: checking that voice…' },
    () => fish.validateVoice(trimmed)
  );

  if (!ok) {
    void vscode.window.showErrorMessage(
      'Clarvis: that voice ID did not work. Nothing has been changed.'
    );
    log(`voice: rejected pasted id ${trimmed.slice(0, 8)}…`);
    return undefined;
  }

  await offerToSave(trimmed, log);
  return `fish:${trimmed}`;
}

/**
 * Offers to remember the voice under a name.
 *
 * Only after validation, so nothing broken gets saved. Skipping is a plain empty
 * answer — the voice is still selected either way, since naming it is a convenience
 * for *next* time, not a condition of using it now.
 */
async function offerToSave(id: string, log: (message: string) => void): Promise<void> {
  const existing = currentSavedVoices();
  if (existing.some((voice) => voice.id === id && voice.name)) return; // already named

  const name = await vscode.window.showInputBox({
    prompt: 'Name this voice to save it for later. Leave blank to use it just this once.',
    placeHolder: 'e.g. Gravel, Narrator, The polite one',
    ignoreFocusOut: true,
  });
  if (!name?.trim()) return;

  await writeSetting('voice.savedVoices', withSavedVoice(existing, name, id));
  log(`voice: saved ${id.slice(0, 8)}… as "${name.trim()}"`);
}

/** Picks the TTS engine, presented by tradeoff rather than by version string. */
export async function chooseEngine(): Promise<void> {
  const config = vscode.workspace.getConfiguration('clarvis');
  const current = config.get<string>('voice.fishAudio.engine', 's2.1-pro-free');

  const picked = await vscode.window.showQuickPick(
    ENGINES.map((engine) => ({
      label: engine.id === current ? `$(check) ${engine.label}` : engine.label,
      detail: engine.detail,
      id: engine.id,
    })),
    { placeHolder: 'Choose a TTS engine — quality against speed and cost', matchOnDetail: true }
  );
  if (!picked) return;

  await writeSetting('voice.fishAudio.engine', picked.id);
  void vscode.window.showInformationMessage(
    await phrase(
      'report',
      `Engine set to ${picked.id}. Anything already cached keeps the old one until it is said again.`,
      [picked.id]
    )
  );
}

/** Whether the configured engine is still one Fish Audio offers. */
export function warnIfEngineUnknown(log: (message: string) => void): void {
  const engine = vscode.workspace
    .getConfiguration('clarvis')
    .get<string>('voice.fishAudio.engine', 's2.1-pro-free');

  if (isKnownEngine(engine)) return;

  log(`voice: unknown engine "${engine}", falling back to the default`);
  void vscode.window.showWarningMessage(
    `Clarvis: "${engine}" isn't an engine I recognise — using the default instead.`
  );
}
