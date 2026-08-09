import * as vscode from 'vscode';
import { ButlerViewProvider } from '../panels/ButlerViewProvider';
import { AvatarController } from '../AvatarController';
import { BusyTracker, Outcome } from '../watch/BusyTracker';
import type { Pattern } from '../memory/patterns';
import { activeFailure, parseRecord, FailureRecord } from '../briefing/lastFailure';
import { readGitSummary } from '../briefing/gitSummary';
import { VoiceService } from '../voice/VoiceService';
import { appendTurn, Turn } from './thread';
import { archiveSession, describeSession, formatSession, parseHistory, Session } from './history';
import { localAnswer, WorkspaceFacts } from './localAnswer';
import { chatAction, ChatAction } from './chatCommands';
import { ModelService, explain } from '../model/ModelService';

/**
 * The live session, written as it happens.
 *
 * Persisted continuously rather than saved at shutdown: `deactivate` is not
 * guaranteed to run — a crash, a force quit, or a killed extension host all skip it —
 * and a transcript that survives only clean exits is one you cannot rely on.
 */
const CURRENT_KEY = 'clarvis.chat.current';

/** Past sessions, newest first. */
const HISTORY_KEY = 'clarvis.chat.history';

/** Where M4 stored the failure record, re-read here rather than duplicated. */
const FAILURE_KEY = 'clarvis.lastFailure';

/**
 * The chat, minus any model.
 *
 * M8a's whole claim is that a useful share of what you ask a coding assistant is
 * already known locally — what's failing, what branch, how long that took, have we
 * seen this before. Those are answered from M3–M5 state with no key, no network and
 * no token spend. Anything else returns null here and waits for M8b's model path.
 */
export class ChatService {
  /**
   * The conversation, for this window's lifetime.
   *
   * Always starts empty: yesterday's questions are about yesterday's failures, and a
   * panel that opens mid-conversation reads as clutter rather than continuity. It
   * survives a panel move or collapse — the webview is destroyed, this isn't.
   *
   * Nothing is lost by starting clean. The previous session is filed into the archive
   * at startup and stays one button away.
   */
  private thread: Turn[] = [];

  /** When this session began — the archive is ordered by it. */
  private readonly startedAt = Date.now();

  /** The answer currently streaming, so `Clarvis: Stop` has something to abort. */
  private streaming?: AbortController;
  private lastOutcome?: { label: string; exitCode: number | undefined; durationMs: number };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: ButlerViewProvider,
    private readonly avatar: AvatarController,
    private readonly tracker: BusyTracker,
    // Suppliers rather than the owning services: chat reads two facts, and taking
    // BriefingService and PatternMemory wholesale would couple it to everything
    // else those two happen to do.
    private readonly recentFiles: () => string[],
    private readonly patterns: () => Pattern[],
    private readonly voice: VoiceService,
    private readonly models: ModelService,
    private readonly log: (message: string) => void
  ) {
    // Duration isn't stored anywhere persistent — M4 keeps the failure, not the
    // timing — so "how long did that take" is answered from the live session only.
    this.tracker.onOutcome((outcome: Outcome) => {
      this.lastOutcome = {
        label: outcome.label,
        exitCode: outcome.exitCode,
        durationMs: outcome.durationMs,
      };
    });

    this.panel.onDidAsk((question) => void this.ask(question));
    this.panel.onDidToggleMute(() => this.voice.setMuted(!this.voice.isMuted));
    this.panel.onDidRequestClear(() => void this.confirmAndClear());
    this.panel.onDidRequestHistory(() => void this.showHistory());
    this.panel.onDidRequestStop(() => this.stop());
    this.panel.onDidRequestModels(() => void vscode.commands.executeCommand('clarvis.configureModels'));

    // Keep the bowtie's tooltip honest when the settings change underneath it —
    // including from the picker it opens, so it never describes the previous choice.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('clarvis.chat') || event.affectsConfiguration('clarvis.agent')) {
          this.postModelInfo();
        }
      })
    );

    // Roll the previous session into the archive before anything is written to it.
    // Done at *startup* rather than shutdown, because shutdown is not guaranteed to
    // happen — this way a crashed window's conversation is filed on next launch.
    void this.rollOver();

    // A newly resolved webview knows nothing. Replaying keeps a panel move or a
    // reload from looking like the conversation was thrown away.
    this.panel.onDidBecomeReady(() => {
      this.panel.post({ type: 'chat-thread', turns: this.thread });
      this.panel.post({ type: 'mute', muted: this.voice.isMuted });
      this.postModelInfo();
    });

    this.voice.onMuteChange((muted) => this.panel.post({ type: 'mute', muted }));
  }

  /** Answers a question, records both halves of the exchange, and shows the reply. */
  async ask(question: string): Promise<void> {
    await this.record({ speaker: 'user', text: question, at: Date.now() });

    // Requests to *open* something are handled before answering: "change the voice"
    // wants the picker, not a paragraph about where the setting lives.
    const action = chatAction(question);
    if (action) {
      await this.runAction(action);
      return;
    }

    const reply = localAnswer(question, await this.facts());

    if (!reply) {
      // Beyond what was watched happen — this is what the model layer is for.
      await this.answerWithModel(question);
      return;
    }

    await this.say(reply.text, reply.state);
  }

  /**
   * Answers with the configured model, streaming as it arrives.
   *
   * Streamed rather than awaited whole: a ten-second silence reads as a hang, and the
   * avatar's `thinking` → `talking` transition is meant to track the real stream
   * instead of a timer (§4.6).
   */
  private async answerWithModel(question: string): Promise<void> {
    if (!(await this.models.isReady())) {
      const spec = this.models.spec('chat');
      this.log(`chat: no local answer, and ${spec.id} is not configured`);
      await this.say(
        spec.needsKey
          ? `That one's beyond what I've watched happen here — I'd need a model for it, and ${spec.label} has no key yet. \`/key\` sorts it, or \`/model\` picks a different provider.`
          : `That's beyond what I've watched here, and ${spec.label} isn't answering on ${'`'}${spec.baseUrl}${'`'}. Is it running?`,
        'neutral'
      );
      return;
    }

    // A fresh controller per question: Stop must abort this turn, not every future one.
    this.streaming?.abort();
    const controller = new AbortController();
    this.streaming = controller;

    this.avatar.setState('thinking');
    const turn: Turn = { speaker: 'clarvis', text: '', at: Date.now() };
    this.thread = appendTurn(this.thread, turn);
    this.panel.post({ type: 'chat-stream-start' });

    let text = '';

    try {
      for await (const fragment of this.models.stream({
        system: this.systemPrompt(),
        messages: this.modelMessages(),
        signal: controller.signal,
      })) {
        if (text === '') this.avatar.setState('talking');
        text += fragment;
        turn.text = text;
        this.panel.post({ type: 'chat-stream', text: fragment });
      }
    } catch (error) {
      // Stopping is not failing: the user asked for silence and gets it.
      if (controller.signal.aborted) {
        this.log('chat: stream aborted by the user');
      } else {
        const { text: friendly, detail } = explain(error);
        this.log(`chat: model failed — ${detail}`);
        text = text ? `${text}\n\n${friendly}` : friendly;
        turn.text = text;
        this.panel.post({ type: 'chat-stream', text: `\n\n${friendly}` });
      }
    } finally {
      this.streaming = undefined;
      this.panel.post({ type: 'chat-stream-end' });
      this.avatar.setState('neutral');
      await this.persist();
    }

    // Spoken only once complete — speaking fragment by fragment would produce a
    // stutter, and the queue exists to serialise utterances, not syllables.
    if (text) this.voice.say(text, 'chatReply');
  }

  /**
   * Tells the panel what is configured, for the bowtie's tooltip.
   *
   * Which model is answering is the thing people forget and then misjudge cost by, so
   * it lives one hover from the prompt rather than three menus deep.
   */
  private postModelInfo(): void {
    const chat = `${this.models.spec('chat').label} · ${this.models.model('chat')}`;
    const coding = this.models.agentIsSeparate()
      ? `${this.models.spec('agent').label} · ${this.models.model('agent')}`
      : 'same as chat';

    this.panel.post({ type: 'model-info', text: `Chat: ${chat}\nCoding: ${coding}\n\nClick to change` });
  }

  /** Cancels the answer in flight, if there is one. */
  stop(): void {
    this.streaming?.abort();
  }

  /**
   * The conversation as the model sees it.
   *
   * Empty turns are dropped — a stream that failed on its first fragment would
   * otherwise be sent back as a blank assistant message, which some providers reject
   * outright and others treat as the model having nothing to say.
   */
  private modelMessages(): { role: 'user' | 'assistant'; content: string }[] {
    return this.thread
      .filter((entry) => entry.text.trim().length > 0)
      .map((entry) => ({
        role: entry.speaker === 'user' ? ('user' as const) : ('assistant' as const),
        content: entry.text,
      }));
  }

  /**
   * The personality block (§2.1), trimmed to what an answering turn needs.
   *
   * The full agent and planning addenda arrive with M8g; sending them now would be
   * instructing the model about tools it does not have.
   */
  private systemPrompt(): string {
    return [
      'You are Clarvis, a butler-like coding assistant living in the user\'s editor.',
      'You are dry, concise and faintly exasperated, but never cruel and never at the user\'s expense.',
      'You are looking at their project: you watch builds, tests and errors as they happen.',
      'Answer in a few sentences unless asked for more. Prefer specifics over hedging.',
      'Never invent what you have observed — if you did not see it, say so.',
    ].join(' ');
  }

  /**
   * Records something Clarvis said on his own initiative — a briefing, a completion
   * notice, a pattern hit, a quip.
   *
   * Notifications vanish after a few seconds and are gone for good; anything worth
   * saying is worth being able to scroll back to. This is a *copy*, not a
   * replacement: the toast still fires, and the budget that governs whether it
   * fires at all is unchanged (§6).
   */
  async note(text: string): Promise<void> {
    // No setState here on purpose: the caller already chose a face and owns the hold
    // timer that returns it to rest. Setting it again from here would fight them.
    await this.record({ speaker: 'clarvis', text, at: Date.now() });
  }

  /**
   * Asks first, then clears.
   *
   * The button sits next to Mute, which gets clicked constantly, and there is no undo
   * — so a misclick would silently destroy the history. Skipped entirely when the
   * thread is already empty, since confirming a no-op is just noise.
   */
  private async confirmAndClear(): Promise<void> {
    if (this.thread.length === 0) return;

    const confirmed = await vscode.window.showWarningMessage(
      'Clear the conversation? This cannot be undone.',
      { modal: true },
      'Clear'
    );
    if (confirmed !== 'Clear') return;

    await this.clear();
  }

  /**
   * Opens whatever was asked for, and says so in the transcript.
   *
   * The line in the transcript matters: a dialog appearing with no explanation looks
   * like a glitch, and if the user dismisses it there is otherwise no trace of what
   * they asked for.
   */
  private async runAction(action: ChatAction): Promise<void> {
    // Actions that are not simply "run a command" — each needs a word first.
    if (action === 'help') {
      await this.say('The manual, then. Try not to look surprised.', 'neutral');
      await this.openManual();
      return;
    }

    if (action === 'chooseModel') {
      await this.say(
        'Models. Chat and coding can be different ones — cheap for talking, capable for code.',
        'neutral'
      );
      await vscode.commands.executeCommand('clarvis.configureModels');
      return;
    }

    if (action === 'toggleMute') {
      const muted = !this.voice.isMuted;
      this.voice.setMuted(muted);
      await this.record({
        speaker: 'clarvis',
        text: muted ? 'Silenced. I remain, in spirit.' : 'Speaking again.',
        at: Date.now(),
      });
      return;
    }

    const commands: Record<string, { id: string; line: string }> = {
      chooseVoice: { id: 'clarvis.chooseVoice', line: 'Voices. Highlight one to hear it.' },
      chooseEngine: { id: 'clarvis.chooseEngine', line: 'Engines — quality against speed and cost.' },
      setKey: { id: 'clarvis.manageModelKeys', line: 'Keys, one per provider, all kept. Yours go in the keychain, never a settings file.' },
      clearKey: { id: 'clarvis.clearFishKey', line: 'Forgetting the key.' },
      testVoice: { id: 'clarvis.testVoice', line: 'Listen.' },
      openCache: { id: 'clarvis.openVoiceCache', line: 'The saved audio. Delete anything in there freely.' },
      clearConversation: { id: 'clarvis.clearConversation', line: 'Clearing this conversation.' },
      showHistory: { id: 'clarvis.showHistory', line: 'Earlier conversations.' },
      openSettings: { id: 'workbench.action.openSettings', line: 'Every setting I have.' },
    };

    const command = commands[action];
    if (!command) return;

    await this.say(command.line, 'neutral');
    await vscode.commands.executeCommand(
      command.id,
      command.id === 'workbench.action.openSettings' ? 'clarvis' : undefined
    );
  }

  /**
   * Shows the manual as a rendered Markdown preview.
   *
   * A preview tab rather than a custom webview: it scrolls, searches, prints and
   * closes like every other document in the editor, follows the user's theme, and
   * costs no UI to maintain. Falls back to the raw file if the preview command is
   * unavailable on this host.
   */
  private async openManual(): Promise<void> {
    const manual = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'MANUAL.md');

    try {
      await vscode.commands.executeCommand('markdown.showPreview', manual);
    } catch (error) {
      this.log(`chat: markdown preview unavailable (${String(error)}), opening the source`);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manual));
    }
  }

  /** Opens the manual, for the command-palette route as well as `/help`. */
  async openHelp(): Promise<void> {
    await this.openManual();
  }

  /** Clears the transcript and the stored copy behind it. */
  async clear(): Promise<void> {
    this.thread = [];
    // Clearing means *delete*, so this is not filed into the archive — otherwise the
    // button labelled "there is no undo" would quietly keep a copy.
    await this.context.workspaceState.update(CURRENT_KEY, undefined);
    this.panel.post({ type: 'chat-thread', turns: [] });
    this.log('chat: conversation cleared');
  }

  /** Posts a reply, sets the face to match it, and returns the face to rest after. */
  private async say(text: string, state: Parameters<AvatarController['setState']>[0]): Promise<void> {
    await this.record({ speaker: 'clarvis', text, at: Date.now() });
    this.avatar.setState(state);

    // Spoken as well as written. The reply is on screen either way — voice is never
    // the only copy, so muting or a broken key costs delivery, never the answer.
    // VoiceService owns talking/neutral from actual playback, which is why the state
    // above is set first and not fought over here.
    this.voice.say(text, 'chatReply');
  }

  /** Appends to the thread, persists it, and shows it. */
  private async record(turn: Turn): Promise<void> {
    this.thread = appendTurn(this.thread, turn);
    this.panel.post({ type: 'chat-turn', speaker: turn.speaker, text: turn.text });
    await this.persist();
  }

  /** Writes the live session to storage. Shared by recorded turns and streamed ones. */
  private async persist(): Promise<void> {
    const session: Session = { startedAt: this.startedAt, turns: this.thread };
    await this.context.workspaceState.update(CURRENT_KEY, session);
  }

  /** Files whatever the last window left behind, then starts this one clean. */
  private async rollOver(): Promise<void> {
    const leftover = parseHistory([this.context.workspaceState.get(CURRENT_KEY)])[0];
    if (!leftover || leftover.turns.length === 0) return;

    const history = parseHistory(this.context.workspaceState.get(HISTORY_KEY));
    await this.context.workspaceState.update(HISTORY_KEY, archiveSession(history, leftover));
    await this.context.workspaceState.update(CURRENT_KEY, undefined);
    this.log(`chat: filed previous session (${leftover.turns.length} turns)`);
  }

  /** Lets the user pick a past session and read it in a normal editor tab. */
  async showHistory(): Promise<void> {
    const history = parseHistory(this.context.workspaceState.get(HISTORY_KEY));

    if (history.length === 0) {
      void vscode.window.showInformationMessage('Clarvis: no earlier conversations to show.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      history.map((session) => ({ ...describeSession(session), session })),
      { placeHolder: 'Earlier conversations, newest first' }
    );
    if (!picked) return;

    // An editor tab rather than a second webview: it scrolls, searches, copies and
    // closes exactly the way every other document does, and costs no UI to maintain.
    const document = await vscode.workspace.openTextDocument({
      content: formatSession(picked.session),
      language: 'markdown',
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  /** Snapshots everything the answering logic is allowed to look at. */
  private async facts(): Promise<WorkspaceFacts> {
    const now = Date.now();
    const stored = parseRecord(this.context.workspaceState.get<FailureRecord>(FAILURE_KEY));

    return {
      now,
      running: this.tracker.running,
      lastOutcome: this.lastOutcome,
      lastFailure: activeFailure(stored, now),
      recentFiles: this.recentFiles(),
      git: await readGitSummary(),
      patterns: this.patterns(),
    };
  }
}
