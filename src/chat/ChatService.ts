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

    // Roll the previous session into the archive before anything is written to it.
    // Done at *startup* rather than shutdown, because shutdown is not guaranteed to
    // happen — this way a crashed window's conversation is filed on next launch.
    void this.rollOver();

    // A newly resolved webview knows nothing. Replaying keeps a panel move or a
    // reload from looking like the conversation was thrown away.
    this.panel.onDidBecomeReady(() => {
      this.panel.post({ type: 'chat-thread', turns: this.thread });
      this.panel.post({ type: 'mute', muted: this.voice.isMuted });
    });

    this.voice.onMuteChange((muted) => this.panel.post({ type: 'mute', muted }));
  }

  /** Answers a question, records both halves of the exchange, and shows the reply. */
  async ask(question: string): Promise<void> {
    await this.record({ speaker: 'user', text: question, at: Date.now() });

    const reply = localAnswer(question, await this.facts());

    if (!reply) {
      // Said once, plainly. §4.6: no retry, no hang, no pretending — the model path
      // that would answer this arrives in M8b.
      this.log(`chat: no local answer for "${question.slice(0, 60)}"`);
      await this.say(
        "I can only answer from what I've watched happen here — builds, branches, errors I've seen before. That one needs a model, and I don't have one wired up yet.",
        'neutral'
      );
      return;
    }

    await this.say(reply.text, reply.state);
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
  private async showHistory(): Promise<void> {
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
