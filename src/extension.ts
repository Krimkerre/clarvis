import * as vscode from 'vscode';
import { secretStoreLabel } from './secretStoreLabel';
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
import { ChatService } from './chat/ChatService';
import type { RunState } from './chat/Busy';
import { Activity } from './bridge/activity';
import { startBridge, type BridgeHandle } from './bridge/wire';
import { BridgeSlot } from './bridge/slot';
import { toggleBridge } from './bridge/toggle';
import { whenTrusted } from './agent/afterTrust';
import { hostTrust } from './agent/hostTrust';
import { recordClip, peakDbfs, hasAudio, installHint, isRecorderMissing } from './voice/nativeRecorder';
import { offerVoiceSetup, enableVoiceAfterKey } from './voice/firstRun';
import { ModelService } from './model/ModelService';
import { probeTools } from './agent/tools/toolProbe';
import { buildStamp } from './buildStamp';
import { AgentTerminal } from './agent/tools/commandTools';
import { Checkpoint } from './agent/Checkpoint';
import { AgentRunner } from './agent/AgentRunner';
import { randomUUID } from 'crypto';
import { paletteRunDecision } from './chat/codingRunFactory';
import { currentEngineChoice, runSkillsLookup, takeRunLock } from './engine/engineHost';
import { gather, reviewRun } from './agent/reviewWizard';
import { describeRun, ReviewAction } from './agent/runReview';
import { LAST_RUN_KEY, renderRunSummary, RunRecord } from './agent/runLedger';
import { BranchFlowWatcher } from './agent/BranchFlowWatcher';
import { FAILURE_KEY, parseRecord } from './briefing/lastFailure';
import { forgetGitOfferAnswer } from './agent/gitOffer';
import { runPlanning } from './planning/PlanningFlow';
import { VsCodeIO } from './planning/VsCodeIO';
import { recordMilestone } from './planning/recordMilestone';
import { pendingBuild } from './planning/pendingBuild';
import { nextMilestoneTask } from './planning/nextMilestoneTask';
import { finishedLines, finishedProject } from './planning/projectFinished';
import { chooseProvider, chooseModel, configureModels, manageKeys, refreshModelCatalog } from './model/modelPickers';
import { Announcer } from './personality/Announcer';
import { Personality } from './personality/Personality';
import { LiveQuips } from './personality/LiveQuips';
import { Voice } from './personality/Voice';
import { opening, phrase, setVoice } from './personality/Voice';
import { undoLastRun } from './agent/undoCommand';
import { SystemVoiceProvider } from './voice/SystemVoiceProvider';
import { VoiceService } from './voice/VoiceService';
import { FishAudioProvider, FISH_KEY_SECRET } from './voice/FishAudioProvider';
import { defaultInputDevice } from './voice/defaultInput';
import { audioDestination, audioDestinationReason } from './voice/audioDestination';
import { chooseVoice, chooseEngine, warnIfEngineUnknown } from './voice/pickers';
import { characterWith, ONLY_WHAT_YOU_WERE_GIVEN } from './personality/character';
import { runVoiceCheck } from './personality/voiceCheck';
import { SlowModelWatch, slowModelLine } from './personality/slowModel';
import { dropLoads, ourLoadedIds, staleLoads, tuneLoads } from './model/lmStudioTune';
import { spokenPart } from './chat/replyDelivery';
import { registerLogTailing } from './logtailing/logTailing';
import { hostLogFor } from './logtailing/logSource';
import * as fs from 'fs';


// Held at module scope only because deactivate() has no way to receive anything
// from activate() — VS Code calls the two independently. Everything else lives
// inside activate()'s scope and is torn down via context.subscriptions.
let log: ClarvisLog | undefined;

/**
 * Here for the same reason as `log`, and with the same caveat: `deactivate` gets
 * one chance to tell NERVIS this window is going, and it is the only place that
 * knows the window is going at all. The socket itself is disposed through
 * `context.subscriptions`, which survives a reload that skips `deactivate`.
 */
let bridge: BridgeSlot<BridgeHandle> | undefined;

/**
 * Called once by VS Code when the extension activates (onStartupFinished).
 *
 * Composition root: builds the pieces, wires them together, registers them for
 * teardown. The actual behavior lives in the collaborators, not here.
 */
export function activate(context: vscode.ExtensionContext): ClarvisExports {
  // Local binding: `log` is module-scoped (deactivate() needs it) and therefore
  // mutable, which stops TypeScript narrowing it inside the closures below.
  const logger = new ClarvisLog(context.logUri);
  // Which build is *running*, as opposed to which is installed. See esbuild.js.
  logger.write(`Clarvis build ${buildStamp()}`);
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
  // The panel is handed over so Tier 1 can play through the webview when the
  // extension host is not the listener's machine — see `audioDestination`.
  // Clarvis's voice from NERVIS while the Bridge is registered (`clarvis.voice.source`, 0.17.24).
  const fish = new FishAudioProvider(context, (message) => logger.write(message), panel,
    async () => (await bridge?.current())?.bridge.nervisSpeaker());
  const voice = new VoiceService(
    avatar,
    fish,
    new SystemVoiceProvider(panel),
    (message) => logger.write(message)
  );
  registerVoiceCommands(context, voice, fish, panel, (message) => logger.write(message));
  // A retired engine shouldn't be discovered by every utterance failing.
  warnIfEngineUnknown((message) => logger.write(message));
  // Voice ships off (§4.4), so it needs one introduction or nobody finds it. Asked
  // once, ever — declining, or ignoring the notification, closes the subject.
  offerVoiceSetup(context, () => fish.hasKey(), (message) => logger.write(message));
  // Housekeeping at shutdown rather than mid-briefing, where it would add latency to
  // the thing it exists to speed up.
  context.subscriptions.push({ dispose: () => void fish.evictCache() });

  // Chat is built last (it reads what the watchers own), but the briefing needs to
  // write into it. A late-bound reference keeps the construction order honest rather
  // than shuffling the wiring to suit one call.
  // Assigned below, but the closures underneath capture it first — a const declared
  // later would leave them referencing it before it exists.
  // eslint-disable-next-line prefer-const
  let chat: ChatService | undefined;
  const toTranscript = (message: string) => void chat?.note(message);

  // For surfaces with no voice of their own — the review wizard, the branch-flow
  // questions. Everything else that reaches the transcript is already spoken by
  // whatever raised it, and routing those through here would say them twice.
  const toTranscriptSpoken = (message: string) => void chat?.remark(message);

  // The model layer (M8b). Local answers still need none of this — it is reached only
  // when a question falls outside what Clarvis watched happen.
  const models = new ModelService(context, (message) => logger.write(message));
  registerModelCommands(context, models, (message) => logger.write(message));

  // **Loads the local models properly, rather than letting them arrive by default.**
  // LM Studio just-in-time loads whatever a request names, reserving room for four
  // concurrent answers when Clarvis asks for one — and a cold load costs 5.3s against
  // a 5s deadline, which is F14 firing on the first thing said. Warming them at
  // startup is defensible precisely because choosing a local provider *is* the signal
  // that they will be used. Never blocks activation, never touches a model the user
  // loaded themselves, and does nothing at all on any other provider. See F28.
  void warmLocalModels(models, (message) => logger.write(message));

  // **The other half of warming: letting go.** Switching a role to a hosted provider, or
  // to a different local model, leaves whatever Clarvis loaded resident and idle — 4-8 GB
  // on a 24 GB machine until LM Studio's one-hour TTL notices. The same signal that
  // justifies loading justifies this in reverse, and it unloads *only* ids Clarvis loaded
  // itself, never a model the user loaded for their own use.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      const touched = ['chat.provider', 'chat.model', 'agent.provider', 'agent.model'].some((key) =>
        event.affectsConfiguration(`clarvis.${key}`)
      );
      if (touched) void releaseLocalModels(models, (message) => logger.write(message));
    })
  );

  // One place that knows what a run is doing: whether one is in progress, and what it
  // committed. Quips stay out of the way during one (§4.6 personality under load), the
  // watcher holds its completion toasts (M8e2), and neither celebrates its commits.
  // Declared before the watcher, which reads it.
  const agentBusy: RunState = { running: false, activity: new Activity() };

  // Every model request, told to the activity for the Bridge's `clarvis.model.*` events
  // (CLARVIS.md §6.4). Nothing listens unless the Bridge is on, and then it costs a call.
  const unwatchModels = models.watchCalls((call) => agentBusy.activity.note({ kind: 'model', ...call }));
  context.subscriptions.push({ dispose: unwatchModels });

  // **F14: said once, when the character has demonstrably gone quiet.** A missed
  // deadline falls back to the written bank and always has — correct, and until now
  // entirely silent, so choosing a slow local model turned the product's central
  // claim into a static bank with the only evidence in a log file. Counted here
  // rather than per-surface so two different surfaces missing once each still adds
  // up to the pattern that earns the telling.
  const slowModel = new SlowModelWatch();
  const noticeSlowModel = (): void => {
    if (!slowModel.missedDeadline()) return;
    const line = slowModelLine(models.spec('chat').label, models.model('chat'));
    logger.write(`voice: ${slowModel.count} missed deadlines — telling them once`);
    void vscode.window.showInformationMessage(`Clarvis: ${line}`);
  };

  const tracker = startTaskWatching(context, avatar, logger, announcer, () => agentBusy.running);
  const memory = startPatternMemory(context, tracker, logger, announcer);
  const briefing = startBriefing(context, avatar, tracker, logger, memory, voice, models, toTranscript, noticeSlowModel);

  const personality = startPersonality(context, tracker, logger, announcer, models, () => agentBusy.running);
  // **Wired, and deliberately never called.** ChatService has no call site for this: the
  // agent's commits are never registered as its own, so the "first commit in a while"
  // quip fires on them and Clarvis ends up remarking on his own work. That was a bug
  // when it was found and the user has since asked to keep it — it is funnier than the
  // rule it breaks (§5, amended). Left connected rather than deleted because the hook is
  // the only way back if that ever stops being true.
  agentBusy.noteCommit = (hash) => personality.noteOwnCommit(hash);

  // The same writer the quips use, for the line that opens a run.
  const liveLines = new LiveQuips(models, () => false, (message) => logger.write(message));

  // Chat (M8a). Answers from what M3–M5 already know; no key, no network. Wired last
  // because it reads the state those three own.
  startBranchFlow(context, logger, toTranscriptSpoken, toTranscript);

  const agentTerminal = registerAgentCommands(context, logger, models, toTranscriptSpoken, agentBusy);
  registerPlanningCommand(context, models, logger, liveLines);
  registerRecordMilestone(context, models, logger, () => chat);

  chat = startChat(context, panel, avatar, tracker, memory, briefing, voice, models, agentTerminal, agentBusy, logger);
  chat.setLiveLines(liveLines);
  // One writer, reachable from every surface — see §2.2. Set as early as the model
  // layer exists, so the first dialog of a session is already in character.
  const voiceWriter = new Voice(models, (message) => logger.write(message), noticeSlowModel);
  setVoice(voiceWriter);
  chat.setVoiceWriter(voiceWriter);

  // A project with no plan.md is exactly who §4.9's front door is for. Offered as one
  // line in the transcript, never started unasked — and after the briefing, so the two
  // don't arrive on top of each other.
  const planOffer = setTimeout(() => void chat?.offerPlanningIfUnplanned(), 6000);
  context.subscriptions.push({ dispose: () => clearTimeout(planOffer) });

  // M15 C2a: a Codex task outlives the window that started it, so opening the project picks it back up —
  // a moment after activation, so the briefing is said first.
  const codexReattach = setTimeout(() => void chat?.reattachCodexTasks(), 3000);
  context.subscriptions.push({ dispose: () => clearTimeout(codexReattach) });

  // M15 C3: carrying an unfinished task on with the other engine, from the chat panel's run.
  context.subscriptions.push(vscode.commands.registerCommand('clarvis.switchEngine', () => chat?.switchEngine()));

  // Every unsolicited remark (M3 notices, M5 pattern hits, M6 quips) also lands in
  // the transcript. Toasts disappear after a few seconds; the thing he said about
  // your build shouldn't be unrecoverable because you were looking elsewhere.
  announcer.onAnnounce(toTranscript);

  // ...and is spoken. Only remarks that already survived the interruption budget get
  // here, so the budget is what limits how much talking happens — not the scope.
  announcer.onAnnounce((message, occasion) => voice.say(message, occasion));

  // M13's log copy: its commands, its stop on shutdown, and its resume where approved.
  registerLogTailing(context, logger);

  // **Last, and only if asked.** `clarvis.bridge.enabled` is false by default, and
  // `startBridge` returns undefined without binding anything when it is — no
  // socket, no registration, no timer. Started after everything it observes
  // exists, so its first status read is of a Clarvis that is actually assembled.
  //
  // Not awaited: registration talks to another process, and an editor's activation
  // must not wait on whether a dashboard happens to be running.
  const write = (message: string) => logger.write(message);
  const slot = new BridgeSlot(() => startBridge(context, agentBusy.activity, write), write);
  bridge = slot;
  slot.launch();
  context.subscriptions.push(
    vscode.commands.registerCommand('clarvis.toggleBridge', () =>
      toggleBridge({
        enabled: () => vscode.workspace.getConfiguration('clarvis.bridge').get<boolean>('enabled', false),
        // The user value only: the scope that keeps a project from switching the Bridge on stays in force.
        write: (value) =>
          Promise.resolve(vscode.workspace.getConfiguration('clarvis.bridge').update('enabled', value, vscode.ConfigurationTarget.Global)),
        confirm: async (question, detail, action) =>
          (await vscode.window.showWarningMessage(question, { modal: true, detail }, action)) === action,
        offerReload: async (text) => (await vscode.window.showInformationMessage(text, 'Reload Window')) === 'Reload Window',
        reload: async () => void (await vscode.commands.executeCommand('workbench.action.reloadWindow')),
        tell: toTranscriptSpoken,
      })
    )
  );
  // A folder trusted after the window opened: the start above found it untrusted and bound nothing.
  if (!vscode.workspace.isTrusted) {
    context.subscriptions.push(
      whenTrusted(hostTrust, () => {
        write('bridge: the folder is trusted now, so the Bridge is started if it is enabled');
        slot.launch();
      })
    );
  }
  return { logCopySource: () => hostLogFor(context.logUri.fsPath, fs.existsSync) };
}

/**
 * What activation hands back. Only the log copy's source today, so the host suite can check
 * against the real editor that M13 finds this window's extension-host log (a renamed file
 * would otherwise fail only when someone needed the log).
 */
export interface ClarvisExports {
  readonly logCopySource: () => string | undefined;
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
    { dispose: () => avatar.dispose() }, // the dwell timer, so a reload leaves nothing pending
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
  announcer: Announcer,
  agentRunning: () => boolean
): BusyTracker {
  const tracker = new BusyTracker();
  wireBusyTracker(tracker, context);

  const presenter = new WatchPresenter(avatar, (message) => log.write(message), announcer, agentRunning);
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
    // **`announceWith`, not `announce`.** The producer runs only if the budget will let
    // the line through, and it *writes* rather than rewrites: handed a finished sentence
    // and a list of literals to preserve, the model returned a variation on the same
    // opening every time. Given the situation instead, it writes for the moment — and
    // anything that drops the file or the line number is rejected back to the written
    // line, so variety never costs a fact.
    (line) =>
      announcer.announceWith(
        () => opening(line.situation, line.fallback, 'states', line.keep),
        line.fallback,
        'judging',
        'patternHit',
        'important'
      )
  );

  void memory.start(tracker, context);
  return memory;
}

/**
 * Pre-loads the local models Clarvis is configured to use, with its own parameters.
 *
 * Gated three ways, all of them deliberate: the provider must be LM Studio (this is
 * that server's CLI and nobody else's), the user must not have switched it off, and
 * the model must not already be loaded. Failure is silent by design — LM Studio
 * loads on demand regardless, which is exactly today's behaviour.
 */
/**
 * The rule the voice is actually using, for anything that needs to report on it.
 *
 * Read here and handed over as a function, so `voiceCheck.ts` needs no `vscode` import —
 * which keeps it loadable, and testable, outside the extension host — and so the check
 * cannot describe a trim the product is not applying.
 */
function spokenAloud(): (reply: string) => string {
  const trims = vscode.workspace.getConfiguration('clarvis').get<boolean>('voice.trimLongReplies', true);
  return trims ? spokenPart : (reply) => reply;
}

async function releaseLocalModels(models: ModelService, log: (message: string) => void): Promise<void> {
  if (!vscode.workspace.getConfiguration('clarvis').get<boolean>('model.tuneLocalLoads', true)) return;

  // What is wanted *now*, after the change. A role pointed somewhere else wants nothing
  // local, and a mixed setup — agent on LM Studio, chat on Anthropic — keeps its half.
  const wanted = (['chat', 'agent'] as const)
    .filter((role) => models.spec(role).id === 'lmstudio')
    .map((role) => models.model(role));

  await dropLoads(staleLoads(ourLoadedIds(), wanted), log);
}

/**
 * Pre-loads the local models Clarvis is configured to use, with its own parameters.
 */
async function warmLocalModels(models: ModelService, log: (message: string) => void): Promise<void> {
  if (!vscode.workspace.getConfiguration('clarvis').get<boolean>('model.tuneLocalLoads', true)) return;
  if (models.spec('chat').id !== 'lmstudio' && models.spec('agent').id !== 'lmstudio') return;

  // Only the roles actually pointed at LM Studio; a mixed setup is normal.
  const wanted = (['chat', 'agent'] as const)
    .filter((role) => models.spec(role).id === 'lmstudio')
    .map((role) => models.model(role));

  await tuneLoads(models.baseUrl('chat'), wanted, log);
}

function startBriefing(
  context: vscode.ExtensionContext,
  avatar: AvatarController,
  tracker: BusyTracker,
  log: ClarvisLog,
  memory: PatternMemory,
  voice: VoiceService,
  models: ModelService,
  toTranscript: (message: string) => void,
  onSlow: () => void
): BriefingService {
  const briefing = new BriefingService(context, (message) => log.write(message), onSlow);

  // M5 supplies the briefing's fourth line. M4 needed no changes for this — it was
  // built to omit the line until something could provide it.
  briefing.setPatternHint(() => memory.briefingLine());

  // The model phrases the briefing when one is configured; the written lines are the
  // fallback. Same division as chat: local state knows the facts, the model says them
  // in a way that doesn't sound like a form letter.
  briefing.setPhraser(async (prompt, signal) => {
    if (!(await models.isReady('chat'))) return undefined;

    let text = '';
    for await (const fragment of models.stream(
      {
        signal,
        // **Found live, in a folder with no git at all.** The briefing's system prompt
        // never carried this rule — only the rewrite and quip prompts did — and with
        // `facts.git` genuinely absent, the model invented one: "last commit was on
        // `main` three days ago", none of which exists anywhere. The briefing gets real
        // facts on an ordinary project, which is exactly why the gaps are more
        // convincing here than on the fully fact-free surfaces this rule first targeted.
        system: characterWith(
          'This is the first thing the user hears today. Do not greet them.',
          ONLY_WHAT_YOU_WERE_GIVEN
        ),
        messages: [{ role: 'user', content: prompt }],
      },
      'chat'
    )) {
      text += fragment;
    }
    return text;
  });

  briefing.start(tracker, (lines, onAgentBranch) => {
    // Speaking, briefly — then back to resting. Voice (M7) will read these aloud;
    // for now the notification is the delivery and the face just marks the moment.
    // **F10: the briefing already notices it's on an agent branch — give that fact
    // its action** rather than leaving the recourse (`Clarvis: Review Agent Run`)
    // undiscoverable, which for a reload before the run's own offer is the same as
    // not existing.
    if (onAgentBranch) {
      void vscode.window.showInformationMessage(lines.join(' '), 'Review that branch').then((choice) => {
        if (choice === 'Review that branch') void vscode.commands.executeCommand('clarvis.reviewRun');
      });
    } else {
      void vscode.window.showInformationMessage(lines.join(' '));
    }
    lines.forEach((line) => log.write(`briefing | ${line}`));
    toTranscript(lines.join(' '));

    // Spoken if voice is on; the avatar's talking/neutral cycle is driven by actual
    // playback rather than a timer, so it's the voice service's job, not ours.
    voice.say(lines.join(' '), 'briefing');
  });

  context.subscriptions.push({ dispose: () => briefing.dispose() });
  return briefing;
}

/**
 * Starts the chat panel (M8a) and the mute control that lives in it.
 *
 * Everything here answers from local state — the model path is M8b. The point of
 * shipping this half first is that it works with no key at all, which is also the
 * state most people will try the extension in.
 */
function startChat(
  context: vscode.ExtensionContext,
  panel: ButlerViewProvider,
  avatar: AvatarController,
  tracker: BusyTracker,
  memory: PatternMemory,
  briefing: BriefingService,
  voice: VoiceService,
  models: ModelService,
  terminal: AgentTerminal,
  agentBusy: RunState,
  log: ClarvisLog
): ChatService {
  // Mute has to silence the OS voice too, and that one lives inside the webview.
  voice.stopSystemVoice = () => panel.post({ type: 'stop-speech' });

  const chat = new ChatService(
    context,
    panel,
    avatar,
    tracker,
    () => briefing.recent,
    () => memory.known,
    (needle) => memory.forget(needle),
    voice,
    models,
    terminal,
    agentBusy,
    (message) => log.write(message)
  );

  context.subscriptions.push(
    // The palette route to the same thing chat does. A job that fails on purpose — a
    // probe, a deliberately red suite — never clears its own record, because that only
    // happens when the same job succeeds.
    vscode.commands.registerCommand('clarvis.forgetFailure', async () => {
      const stored = parseRecord(context.workspaceState.get(FAILURE_KEY));
      if (stored) await context.workspaceState.update(FAILURE_KEY, undefined);

      // Both stores, independently: the record may already be gone while the pattern —
      // the line the user actually sees every morning — is still there.
      const dropped = stored ? await memory.forget(stored.label) : 0;
      log.write(`chat: forget from the palette — record ${stored ? 'cleared' : 'was empty'}, ${dropped} pattern(s)`);

      void vscode.window.showInformationMessage(
        stored || dropped > 0
          ? await phrase('report', `Forgotten. ${stored?.label ?? 'That'} is your business now.`)
          : await phrase('report', 'There is nothing on my mind to forget.')
      );
    }),

    // Through the confirming path, not the raw one. M8f2 rule: a destructive action
    // asks for itself whatever route reached it — a typed "/clear", a chat phrasing, or
    // a model's guess that the user already said yes to. Two prompts is correct here;
    // agreeing that a guess was right is not the same as agreeing to lose the thread.
    vscode.commands.registerCommand('clarvis.clearConversation', () => void chat.confirmAndClear()),
    vscode.commands.registerCommand('clarvis.showHistory', () => void chat.showHistory()),
    vscode.commands.registerCommand('clarvis.openManual', () => void chat.openHelp())
  );

  return chat;
}

/**
 * Key handling and a way to hear the current voice without waiting for a build.
 *
 * The key is captured through a password input straight into `SecretStorage` (the OS
 * keychain) — it is never placed in settings, never written to the log, and never
 * echoed back.
 */
/**
 * Tells the user what's missing for voice input, and lets them decide.
 *
 * Copy, not run: installing software on someone's machine is their call. The command
 * goes to the clipboard so they can read it before pasting it anywhere.
 */
async function offerRecorderInstall(log: (message: string) => void): Promise<void> {
  const hint = installHint();
  log(`mic: no recorder found; suggested "${hint.command}"`);

  const choice = await vscode.window.showInformationMessage(
    `Clarvis: I'd need ${hint.missing} to hear you, and it isn't installed. Entirely your call — everything else works without it.`,
    { detail: hint.note, modal: false },
    'Copy install command',
    'Not now'
  );

  if (choice === 'Copy install command') {
    await vscode.env.clipboard.writeText(hint.command);
    void vscode.window.showInformationMessage(
      `Clarvis: copied \`${hint.command}\` — run it yourself when you feel like it, then reload.`
    );
  }
}

/** Provider, model and key management (M8b). */
function registerModelCommands(
  context: vscode.ExtensionContext,
  models: ModelService,
  log: (message: string) => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'clarvis.configureModels',
      () => void configureModels(context, models, log)
    ),
    vscode.commands.registerCommand('clarvis.chooseProvider', () => void chooseProvider(context, models, log)),
    vscode.commands.registerCommand('clarvis.chooseModel', () => void chooseModel(context, models, log)),
    vscode.commands.registerCommand('clarvis.manageModelKeys', () => void manageKeys(models, log)),
    vscode.commands.registerCommand(
      'clarvis.refreshModels',
      () => void refreshModelCatalog(context, models, log)
    )
  );
}

function registerVoiceCommands(
  context: vscode.ExtensionContext,
  voice: VoiceService,
  fish: FishAudioProvider,
  panel: ButlerViewProvider,
  log: (message: string) => void
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
      void vscode.window.showInformationMessage(
        await phrase('report',
          `Key stored, in ${secretStoreLabel(vscode.env.remoteName)} where it belongs.`)
      );
      // Setting a key is an unambiguous request for the feature it unlocks.
      await enableVoiceAfterKey(log);
    }),

    vscode.commands.registerCommand('clarvis.clearFishKey', async () => {
      // Same rule, and this one had no confirmation at all: the key is not recoverable
      // from here, and getting another means going back to the provider for it.
      const confirmed = await vscode.window.showWarningMessage(
        'Remove the stored Fish Audio key? You will need to paste it in again to use the voice.',
        { modal: true },
        'Remove'
      );
      if (confirmed !== 'Remove') return;

      await context.secrets.delete(FISH_KEY_SECRET);
      void vscode.window.showInformationMessage(await phrase('report', 'Key removed.'));
    }),

    vscode.commands.registerCommand('clarvis.chooseVoice', () => chooseVoice(fish, voice, log)),

    vscode.commands.registerCommand('clarvis.chooseEngine', () => chooseEngine()),

    vscode.commands.registerCommand('clarvis.openVoiceCache', async () => {
      // Reveals the folder holding rendered speech. Anything already in here plays
      // without touching the API, which is most of why repeated lines are instant.
      await vscode.commands.executeCommand('revealFileInOS', fish.cacheLocation);
    }),

    // M10 spike (§4.7): can the *extension host* open the microphone, given M1 proved
    // the webview cannot? Attribution of the OS permission is the open question — the
    // host spawns the recorder, so it is not obvious which process macOS asks about.
    vscode.commands.registerCommand('clarvis.debug.micProbe', async () => {
      const file = vscode.Uri.joinPath(context.globalStorageUri, 'mic-probe.wav');
      await vscode.workspace.fs.createDirectory(context.globalStorageUri);

      // **On a browser or remote host, the host-side recorder captures the
      // server's microphone — the mirror of the playback defect fixed the same
      // day.** Recording it anyway would measure the wrong machine and report
      // the result as though it were the listener's. So the probe first asks
      // the only question that decides whether capture can be routed the way
      // playback now is: may this webview open a microphone at all?
      if (audioDestination(vscode.env.uiKind, vscode.env.remoteName) === 'webview') {
        const reason = audioDestinationReason(vscode.env.uiKind, vscode.env.remoteName);
        void vscode.window.showInformationMessage(
          await phrase('report', 'Recording for three seconds, through the panel. Say something.')
        );

        const result = await panel.recordThroughPanel(3);
        if (!result.ok) {
          log(`mic probe: ${reason}, recorded through the panel and it refused — ${result.error}`);
          void vscode.window.showInformationMessage(
            `Clarvis mic probe: the panel could not record — ${result.error}.`
          );
          return;
        }

        // Written to the same file and measured by the same code as the host
        // path. The point of routing capture through the panel is that the
        // *microphone* changes, not the analysis — and a silence check that only
        // ran on one of the two routes would be worth little on either.
        const audio = Buffer.from(String(result.wavBase64 ?? ''), 'base64');
        await vscode.workspace.fs.writeFile(file, audio);
        const peak = peakDbfs(audio);
        const device = result.device ? ` from ${result.device}` : '';
        const verdict = hasAudio(audio)
          ? `captured audio${device}, peak ${peak.toFixed(1)} dBFS`
          : `SILENT${device} (peak ${peak.toFixed(1)} dBFS) — denied or muted`;

        log(
          `mic probe: ${reason}, so the recording came from the panel rather than ` +
            `the extension host — ${audio.length} bytes at ${result.sampleRate} Hz, ${verdict}`
        );
        void vscode.window.showInformationMessage(
          `Clarvis mic probe: ${verdict}. See the Clarvis output channel.`
        );
        return;
      }

      void vscode.window.showInformationMessage(
        await phrase('report', 'Recording for three seconds. Say something.')
      );

      try {
        const used = await recordClip(file.fsPath, 3, process.platform, log);
        const audio = Buffer.from(await vscode.workspace.fs.readFile(file));
        const peak = peakDbfs(audio);

        // **Which device, because a silent recording has three explanations and
        // naming it removes one.** `:default` is the right thing to record and
        // says nothing about what it resolved to; on a machine with a virtual
        // device installed, "the wrong input" is a live possibility and looks
        // identical to a denied mic. Empty when it cannot be told, and then the
        // original three-way wording stands rather than a claim we cannot make.
        const device = await defaultInputDevice(process.platform);
        const from = device ? ` from ${device}` : '';

        // A denied mic can still produce a well-formed file full of silence, so the
        // exit code alone proves nothing. The level is the actual result.
        const verdict = hasAudio(audio)
          ? `captured audio${from}, peak ${peak.toFixed(1)} dBFS`
          : `SILENT${from} (peak ${peak.toFixed(1)} dBFS) — ` +
            (device ? 'denied or muted' : 'device denied, muted, or the wrong input');
        log(`mic probe: ${used} wrote ${audio.length} bytes, ${verdict}`);
        void vscode.window.showInformationMessage(`Clarvis mic probe: ${verdict}. See the Clarvis output channel.`);
      } catch (error) {
        log(`mic probe: failed (${String(error)})`);

        // Nothing installed to record with is a choice to offer, not a failure to
        // report — see installHint().
        if (isRecorderMissing(error)) {
          await offerRecorderInstall(log);
          return;
        }

        void vscode.window.showErrorMessage(`Clarvis mic probe failed: ${String(error)}`);
      }
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
  announcer: Announcer,
  models: ModelService,
  busy: () => boolean
): Personality {
  const personality = new Personality(announcer, (message) => log.write(message));

  // Written lines when a model is configured; the bank when it isn't, is slow, or
  // returns something unusable.
  personality.setBusySignal(busy);
  personality.setLiveQuips(new LiveQuips(models, busy, (message) => log.write(message)));
  personality.start(tracker, context);
  return personality;
}

/**
 * Called by VS Code on window close, workspace switch, or extension reload.
 *
 * Nothing to flush yet — persistent state starts at M4. Note that this log line
 * frequently does NOT appear: the extension host often tears the process down
 * before the write is flushed. That's expected, and it's why real teardown state
 * (from M4 onward) is written synchronously via workspace.fs, never via the log.
 */
export async function deactivate(): Promise<void> {
  // The log copy stops through its own disposable (`registerLogTailing`); this used to call a
  // stop that also popped "not currently tailing" on every window close.
  log?.write('Clarvis deactivated.');
  // **Returned, so VS Code waits for it.** Stopping tells NERVIS this window is gone;
  // started and not awaited, the host ended first and a closed window stayed listed as
  // live until NERVIS's 45-second lease ran out (attended session, 17 September 2026).
  // The lease remains the mechanism for a window that crashes.
  await bridge?.stop();
}

/**
 * The branch-flow watcher, and the two commands that only make sense beside it.
 *
 * Kept together because they share one object and nothing else does: `checkBranchFlow`
 * is called by the agent path the moment a run finishes, and `forgetBranchAnswers`
 * exists because "asked once" is right until somebody changes their mind or is testing.
 */
function startBranchFlow(
  context: vscode.ExtensionContext,
  logger: ClarvisLog,
  toTranscriptSpoken: (message: string) => void,
  toTranscript: (message: string) => void
): void {
  // Keeps plan.md's branch flow in step with the repository: a declared flow that has
  // gone stale is worse than none, since the wizard keeps offering branches it knows
  // while ignoring the one work now passes through.
  const branchFlow = new BranchFlowWatcher(
    context,
    (message) => logger.write(message),
    toTranscriptSpoken,
    toTranscript
  );
  context.subscriptions.push(branchFlow.start());

  // Called by the agent path the moment a run finishes: a branch the user just asked
  // for should be sorted out while they are still looking at it.
  context.subscriptions.push(
    vscode.commands.registerCommand('clarvis.checkBranchFlow', () => branchFlow.checkNow()),


    // "Asked once" is right until someone changes their mind, or is testing. Without
    // this the only way to be asked again about a branch is a new workspace.
    vscode.commands.registerCommand('clarvis.forgetBranchAnswers', async () => {
      await context.workspaceState.update('clarvis.branchFlow.seen', undefined);
      await context.workspaceState.update('clarvis.branchFlow.kept', undefined);
      logger.write('branch flow: forgot which branches had been asked about');
      void vscode.window.showInformationMessage(
        await phrase('report', 'I have forgotten which branches I asked about.')
      );
      await branchFlow.checkNow();
    }),

    // Same shape as forgetBranchAnswers, for the same reason: "asked once" is right
    // until someone changes their mind or is testing.
    vscode.commands.registerCommand('clarvis.forgetGitOfferAnswer', async () => {
      await forgetGitOfferAnswer(context);
      // The planning offer is remembered the same way and forgotten by the same
      // command: both are "you said no once, here, about this project", and having two
      // commands for one intention is how a setting becomes undiscoverable.
      await context.workspaceState.update('clarvis.planning.offerDeclined', undefined);
      logger.write('git offer: forgot the answer, will ask again next run');
      void vscode.window.showInformationMessage(await phrase('report', 'Asking again, next time it comes up.'));
    })
  );
}

/**
 * M9a — the project-planning interview, as its own command.
 *
 * Deliberately separate from the chat panel rather than routed through ChatService:
 * this is the first slice of a large milestone, and the eventual "questions arrive in
 * the chat panel" experience is a later piece of work, not something this needed to
 * wait for. Runs M9b (analysis) once the interview reaches "enough to draft", then
 * M9c (accept/reject/modify per finding) over whatever it found, then writes
 * `plan.md` itself (M9d) — unless one already exists in the workspace, which it
 * never overwrites. M9e (sign-off/handoff into an agent task) is not built yet.
 *
 * **Carries the same personality quips as chat and the agent** — the acknowledgement
 * on the way in, the aside after the summary on the way out. Chained input boxes are
 * not a chat transcript, so both surface via `showInformationMessage` instead of
 * `note()`; the lines themselves come from the same `LiveQuips` instance everything
 * else uses, not a second copy.
 */
/**
 * Writing a finished run back into `plan.md` (§0's live checklist).
 *
 * A command rather than a direct call because the run session raises it — it knows a
 * milestone just finished, and knows nothing about plans, models or files.
 */
function registerRecordMilestone(
  context: vscode.ExtensionContext,
  models: ModelService,
  logger: ClarvisLog,
  /** Late-bound: chat is built after this is registered, and owns the run session. */
  chatOf: () => ChatService | undefined
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('clarvis.recordMilestone', async (summary: string) => {
      const outcome = await recordMilestone(models, summary ?? '', (message: string) => logger.write(message));
      if (!outcome) return;

      // **Finishing one milestone has somewhere to go.** The plan holds all of them,
      // so the next is already written down — offered rather than started, because
      // "keep going" is a decision and a build that rolls straight into the next
      // milestone is one nobody agreed to.
      const next = await pendingBuild();
      if (!next) {
        // **The end of a project is news, and news goes in the conversation.** This
        // was a notification and nothing else — the one place a finished project was
        // guaranteed not to be mentioned by the butler who built it.
        const finished = await finishedProject(await planTextOf());
        if (finished) await chatOf()?.announceProjectFinished(finishedLines(finished));
        else void vscode.window.showInformationMessage(outcome);
        return;
      }

      const go = await vscode.window.showInformationMessage(
        outcome,
        { modal: true, detail: `Milestone ${next.milestone.number} — ${next.milestone.title}. Shall I carry on?` },
        'Build it',
        'Not now'
      );
      if (go !== 'Build it') {
        logger.write('planning: next milestone left for later');
        return;
      }

      await chatOf()?.startNextMilestone(
        nextMilestoneTask(next.milestone, next.projectName, next.milestones),
        next.steps
      );
    })
  );
}

/** The plan as text, or an empty string when there is none to read. */
async function planTextOf(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return '';

  return vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'plan.md')).then(
    (bytes) => Buffer.from(bytes).toString('utf8'),
    () => ''
  );
}

function registerPlanningCommand(
  context: vscode.ExtensionContext,
  models: ModelService,
  logger: ClarvisLog,
  liveLines: LiveQuips
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('clarvis.planProject', () =>
      runPlanning(models, new VsCodeIO(), liveLines, (message) => logger.write(message))
    )
  );
}

/**
 * Everything driveable by hand: the log, a run, the review, undo, and the two probes.
 *
 * Returns the shared terminal, because the chat path needs the same one — a probe run
 * and an agent run in separate windows would read as two unrelated things happening.
 */
/** The body of `clarvis.showLastRun`, split out to keep its registering function short. */
async function showLastRun(context: vscode.ExtensionContext): Promise<void> {
  const record = context.workspaceState.get<RunRecord>(LAST_RUN_KEY);
  if (!record) {
    void vscode.window.showInformationMessage(await phrase('report', 'No run recorded yet this session.'));
    return;
  }

  const summary = await gather([], [], context.workspaceState.get('clarvis.agent.baseBranch'));
  const withBranch = summary ? { ...record, branchState: describeRun(summary) } : record;

  const document = await vscode.workspace.openTextDocument({
    content: renderRunSummary(withBranch),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(document, { preview: false });
}

/**
 * The palette route into the agent: ask for a task, run it, report it.
 *
 * Lifted out of `registerAgentCommands` when M14 gave it a `finally` and it grew
 * past the line limit — but it wanted its own function anyway. It is the second
 * of the two places that start an agent run, and having it inline in a
 * registration block is most of why it was the one nobody remembered to wire.
 */
async function runTaskFromPalette(
  context: vscode.ExtensionContext,
  logger: ClarvisLog,
  models: ModelService,
  agentTerminal: AgentTerminal,
  runState: RunState
): Promise<void> {
  // M15 C2a: the palette never runs Codex, whose questions need the panel — said before a task is typed.
  const decision = paletteRunDecision(currentEngineChoice(models));
  if (decision.run === 'refused') {
    void vscode.window.showInformationMessage(`Clarvis: ${decision.line}`);
    return;
  }

  const task = await vscode.window.showInputBox({
    prompt: 'What should I do?',
    placeHolder: 'e.g. fix the failing test in src/watch',
    ignoreFocusOut: true,
  });
  if (!task?.trim()) return;

  // The project lock, as the chat's runs take it (M15 C2a): one writer per project, whichever window.
  const lock = await takeRunLock(models, randomUUID(), (message) => logger.write(message), () => false);
  if (lock && !lock.held) {
    void vscode.window.showInformationMessage(`Clarvis: ${lock.line}`);
    return;
  }
  const fence = lock?.held ? lock.lock : undefined;

  const controller = new AbortController();
  runState.running = true;
  runState.activity.startRun();
  const runner = new AgentRunner(
    context,
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    models,
    agentTerminal,
    (message) => logger.write(message),
    // The palette route has never asked before a step — its whole shape is
    // fire-and-watch-the-notification — but its gates are the same gates.
    undefined,
    runState.activity,
    fence,
    {},
    // The owner's skills, as the chat's runs read them (plan.md §4.6, "Skills").
    () => runSkillsLookup(models)
  );

  // Set last, read in the `finally` — the loop leaves by three routes and from in
  // there they look the same. Same shape as `RunSession`, for the same reason.
  let ended: 'ok' | 'failed' = 'failed';
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Clarvis', cancellable: true },
      async (progress, token) => {
        // Cancel must reach the run itself, not merely close the notification.
        token.onCancellationRequested(() => {
          controller.abort();
          // So the cancelled run is not then reported as one that crashed.
          runState.activity.stopping();
        });

        for await (const event of runner.run(task.trim(), controller.signal)) {
          // No logging here: AgentRunner records every event itself, so both callers
          // produce the same trail rather than each rolling their own.
          if (event.kind === 'tool') progress.report({ message: `${event.step}. ${event.text}` });

          if (event.kind === 'done' || event.kind === 'error') {
            const files = event.files?.length ? ` (${event.files.length} file(s))` : '';
            // The closing event no longer repeats the narration, so it can be empty.
            const text = event.text.trim() || 'Finished.';
            void vscode.window.showInformationMessage(await phrase('report', `${text}${files}`));
          }
        }
      }
    );
    ended = 'ok';
  } finally {
    // **Cleared on every route out.** A run flag left true after a crash silences the
    // quips and the watcher for the rest of the session, with nothing to suggest why
    // — the failure mode that makes an un-cleared flag worse than never setting one.
    runState.running = false;
    if (ended === 'failed') runState.activity.fail();
    else runState.activity.finish();
    // Last: the run's loop is over, and its commands with it.
    await fence?.release();
  }
}

function registerAgentCommands(
  context: vscode.ExtensionContext,
  logger: ClarvisLog,
  models: ModelService,
  toTranscriptSpoken: (message: string) => void,
  /**
   * **The palette run is a run too, and until M14 nothing was told.** It builds its
   * own `AgentRunner` and its own `AbortController` and never touches `Busy`, so
   * `running` stayed false for its whole duration: quips talked over it (§4.6 says
   * they should not), the watcher announced builds it had caused, and the Bridge
   * would have reported `idle` during a live agent run — a lie about precisely the
   * state it exists to report.
   *
   * Marked rather than rerouted. Sending this through `ChatService` is the right
   * end state and is a bigger change than saying the truth about it.
   */
  runState: RunState
): AgentTerminal {
  // M8c's tools, driveable by hand until M8e lets a model call them. The terminal is
  // shared so a probe run reads as one transcript rather than one window per command.
  const agentTerminal = new AgentTerminal();
  context.subscriptions.push({ dispose: () => agentTerminal.dispose() });
  context.subscriptions.push(
    vscode.commands.registerCommand('clarvis.openLog', async () => {
      if (!logger.filePath) {
        void vscode.window.showWarningMessage('Clarvis: no log file — writing to it failed at startup.');
        return;
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logger.filePath));
      await vscode.window.showTextDocument(document);
    }),
    // The agent (M8e). A command for now; M8f routes chat requests into it.
    vscode.commands.registerCommand('clarvis.runTask', () =>
      runTaskFromPalette(context, logger, models, agentTerminal, runState)
    ),

    // Available any time, not only after a run — the question "what is this branch and
    // what do I do with it" outlives the run that created it.
    vscode.commands.registerCommand('clarvis.reviewRun', (decided?: ReviewAction) =>
      reviewRun(
        [],
        [],
        (message) => logger.write(message),
        context.workspaceState.get('clarvis.agent.baseBranch'),
        toTranscriptSpoken,
        decided
      )
    ),

    // A durable, inspectable summary of the last run: intent, files changed, steps
    // and why, result, remaining concern, branch state. The chat answer to "why did
    // you do that" reads the same stored record; this is the whole thing, as a
    // document, for when a chat reply is not enough — a support artifact, per the
    // review that asked for it.
    vscode.commands.registerCommand('clarvis.showLastRun', () => showLastRun(context)),

    // Undo for a whole agent run (M8d). Registered now rather than with M8e's loop so
    // the escape hatch exists before the thing it rescues you from.
    vscode.commands.registerCommand('clarvis.undoLastRun', () =>
      undoLastRun({
        stored: () => Checkpoint.stored(context),
        confirm: async (question, detail) =>
          (await vscode.window.showWarningMessage(question, { modal: true, detail }, 'Undo it')) === 'Undo it',
        undo: () =>
          Checkpoint.undo(context, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, (message) => logger.write(message)),
        phrase: (purpose, fallback, keep) => phrase(purpose, fallback, keep),
        notify: (kind, text) =>
          void (kind === 'warning' ? vscode.window.showWarningMessage(text) : vscode.window.showInformationMessage(text)),
        tell: toTranscriptSpoken,
      })
    ),

    // Reads his lines back before they reach anyone. Opened as a document rather than
    // logged, because the whole point is that a person sits and reads them.
    vscode.commands.registerCommand('clarvis.debug.voiceCheck', async () => {
      const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Clarvis: saying a few things…' },
        () =>
          runVoiceCheck(models, (message) => logger.write(message), spokenAloud())
      );

      const document = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' });
      await vscode.window.showTextDocument(document, { preview: false });
    }),

    vscode.commands.registerCommand('clarvis.debug.tools', () =>
      probeTools(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        (message) => logger.write(message),
        agentTerminal
      )
    )
  );

  return agentTerminal;
}
