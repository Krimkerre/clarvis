import * as vscode from 'vscode';
import { ButlerViewProvider, BUTLER_STATES, isButlerState } from './panels/ButlerViewProvider';
import { AvatarController } from './AvatarController';
import { StatusBarMirror } from './StatusBarMirror';
import { ClarvisLog } from './ClarvisLog';
import { BusyTracker } from './watch/BusyTracker';
import { wireBusyTracker } from './watch/wireBusyTracker';
import { WatchPresenter } from './watch/WatchPresenter';
import { BriefingService } from './briefing/BriefingService';
import { PatternStore } from './memory/PatternStore';
import { PatternMemory } from './memory/PatternMemory';
import { Announcer } from './personality/Announcer';
import { Personality } from './personality/Personality';
import { SystemVoiceProvider } from './voice/SystemVoiceProvider';
import { VoiceService } from './voice/VoiceService';
import { FishAudioProvider, FISH_KEY_SECRET } from './voice/FishAudioProvider';

// Held at module scope only because deactivate() has no way to receive anything
// from activate() — VS Code calls the two independently. Everything else lives
// inside activate()'s scope and is torn down via context.subscriptions.
let log: ClarvisLog | undefined;

/**
 * Called once by VS Code when the extension activates (onStartupFinished).
 *
 * Composition root: builds the pieces, wires them together, registers them for
 * teardown. The actual behavior lives in the collaborators, not here.
 */
export function activate(context: vscode.ExtensionContext): void {
  // Local binding: `log` is module-scoped (deactivate() needs it) and therefore
  // mutable, which stops TypeScript narrowing it inside the closures below.
  const logger = new ClarvisLog();
  log = logger;
  context.subscriptions.push(logger.disposable);
  logger.write('Clarvis activated.');

  const { avatar, panel } = createAvatar(context, logger);
  registerDebugStateCommand(context, avatar);

  // One budget for everything unsolicited (§6). M3's notices, M5's pattern hits and
  // M6's quips all announce through this, so the user experiences one allowance
  // rather than three independent ones.
  const announcer = new Announcer(avatar, (message) => logger.write(message));
  context.subscriptions.push({ dispose: () => announcer.dispose() });

  // Voice (M7). Tier 1 (Fish Audio) lands behind the same interface; until a key and
  // a curated voice exist, the system voice is the whole implementation.
  const fish = new FishAudioProvider(context, panel, (message) => logger.write(message));
  const voice = new VoiceService(
    avatar,
    fish,
    new SystemVoiceProvider(panel),
    (message) => logger.write(message)
  );
  registerVoiceCommands(context, voice, fish, panel);
  // Housekeeping at shutdown rather than mid-briefing, where it would add latency to
  // the thing it exists to speed up.
  context.subscriptions.push({ dispose: () => void fish.evictCache() });

  const tracker = startTaskWatching(context, avatar, logger, announcer);
  const memory = startPatternMemory(context, tracker, logger, announcer);
  startBriefing(context, avatar, tracker, logger, memory, voice);
  startPersonality(context, tracker, logger, announcer);
}

/**
 * Builds the avatar's two surfaces (webview panel + status-bar glyph) and the
 * controller that keeps them in sync, and registers all of it with VS Code.
 */
function createAvatar(
  context: vscode.ExtensionContext,
  log: ClarvisLog
): { avatar: AvatarController; panel: ButlerViewProvider } {
  const provider = new ButlerViewProvider(context.extensionUri);
  const statusBar = new StatusBarMirror('neutral');
  const avatar = new AvatarController(provider, statusBar, log);

  // State changes originating inside the webview flow back through the controller,
  // so they update the status bar too instead of silently diverging.
  provider.onDidReportState((state) => avatar.setState(state));

  context.subscriptions.push(
    provider.disposable,
    statusBar.disposable,
    vscode.window.registerWebviewViewProvider(ButlerViewProvider.viewId, provider, {
      // Keep the webview alive while the panel is collapsed, so the avatar doesn't
      // reset to its default expression every time the user hides the panel.
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // One-off report of what the audio APIs look like in the webview. M1 checked speech
  // *input* and found it blocked; output was never tested, and Tier 0 rests on it.
  provider.onDidProbeAudio((probe) => log.write(`audio probe: ${JSON.stringify(probe)}`));

  return { avatar, panel: provider };
}

/**
 * Registers the debug command that sets any expression on demand, so every state
 * can be exercised without waiting for a real trigger (a slow build, a failing test).
 */
function registerDebugStateCommand(
  context: vscode.ExtensionContext,
  avatar: AvatarController
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('clarvis.debug.setState', async () => {
      const picked = await vscode.window.showQuickPick([...BUTLER_STATES], {
        placeHolder: 'Set Clarvis avatar state',
      });
      if (isButlerState(picked)) avatar.setState(picked);
    })
  );
}

/**
 * Starts watching tasks, terminal commands, and debug sessions (M3), and reacting
 * to them on screen.
 *
 * BusyTracker answers "is anything running?", wireBusyTracker feeds it from the
 * three VS Code event sources M1's spike validated, and WatchPresenter decides
 * what the user sees when something finishes.
 */
function startTaskWatching(
  context: vscode.ExtensionContext,
  avatar: AvatarController,
  log: ClarvisLog,
  announcer: Announcer
): BusyTracker {
  const tracker = new BusyTracker();
  wireBusyTracker(tracker, context);

  const presenter = new WatchPresenter(avatar, (message) => log.write(message), announcer);
  presenter.attachTo(tracker);
  context.subscriptions.push({ dispose: () => presenter.dispose() });

  return tracker;
}

/**
 * Starts the session briefing (M4): remembers the job that was failing when the window
 * closed, and reports where things stood shortly after the next launch.
 *
 * Shares M3's tracker rather than subscribing to VS Code events again — the failing
 * job is the same fact both features care about, just on different timescales.
 */
function startPatternMemory(
  context: vscode.ExtensionContext,
  tracker: BusyTracker,
  log: ClarvisLog,
  announcer: Announcer
): PatternMemory {
  const memory = new PatternMemory(
    new PatternStore(context),
    (message) => log.write(message),
    // A suggestion, never an action (rule 3), and subject to the shared budget.
    (message) => void announcer.announce(message, 'judging')
  );

  void memory.start(tracker, context);
  return memory;
}

function startBriefing(
  context: vscode.ExtensionContext,
  avatar: AvatarController,
  tracker: BusyTracker,
  log: ClarvisLog,
  memory: PatternMemory,
  voice: VoiceService
): void {
  const briefing = new BriefingService(context, (message) => log.write(message));

  // M5 supplies the briefing's fourth line. M4 needed no changes for this — it was
  // built to omit the line until something could provide it.
  briefing.setPatternHint(() => memory.briefingLine());

  briefing.start(tracker, (lines) => {
    // Speaking, briefly — then back to resting. Voice (M7) will read these aloud;
    // for now the notification is the delivery and the face just marks the moment.
    void vscode.window.showInformationMessage(lines.join(' '));
    lines.forEach((line) => log.write(`briefing | ${line}`));

    // Spoken if voice is on; the avatar's talking/neutral cycle is driven by actual
    // playback rather than a timer, so it's the voice service's job, not ours.
    voice.say(lines.join(' '), 'briefing');
  });

  context.subscriptions.push({ dispose: () => briefing.dispose() });
}

/**
 * Key handling and a way to hear the current voice without waiting for a build.
 *
 * The key is captured through a password input straight into `SecretStorage` (the OS
 * keychain) — it is never placed in settings, never written to the log, and never
 * echoed back.
 */
function registerVoiceCommands(
  context: vscode.ExtensionContext,
  voice: VoiceService,
  fish: FishAudioProvider,
  panel: ButlerViewProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('clarvis.setFishKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Fish Audio API key',
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) return;

      await context.secrets.store(FISH_KEY_SECRET, key.trim());
      void vscode.window.showInformationMessage('Clarvis: key stored in the system keychain.');
    }),

    vscode.commands.registerCommand('clarvis.clearFishKey', async () => {
      await context.secrets.delete(FISH_KEY_SECRET);
      void vscode.window.showInformationMessage('Clarvis: key removed.');
    }),

    vscode.commands.registerCommand('clarvis.testVoice', async () => {
      const available = await fish.isAvailable();
      const reason = !panel.audioUnlocked
        ? 'Clarvis: click once inside the Clarvis panel — the editor blocks audio until you do. Using the system voice meanwhile.'
        : 'Clarvis: no key or cap reached — using the system voice.';
      void vscode.window.showInformationMessage(
        available ? 'Clarvis: speaking via Fish Audio…' : reason
      );
      voice.say('Your build finished. I have alerted no one.', 'completion');
    })
  );
}

/**
 * Starts the dev-moment commentary (M6): slow builds, repeat failures, suites going
 * green, first commit after a silence, enormous diffs.
 */
function startPersonality(
  context: vscode.ExtensionContext,
  tracker: BusyTracker,
  log: ClarvisLog,
  announcer: Announcer
): void {
  new Personality(announcer, (message) => log.write(message)).start(tracker, context);
}

/**
 * Called by VS Code on window close, workspace switch, or extension reload.
 *
 * Nothing to flush yet — persistent state starts at M4. Note that this log line
 * frequently does NOT appear: the extension host often tears the process down
 * before the write is flushed. That's expected, and it's why real teardown state
 * (from M4 onward) is written synchronously via workspace.fs, never via the log.
 */
export function deactivate(): void {
  log?.write('Clarvis deactivated.');
}
