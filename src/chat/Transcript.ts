import * as vscode from 'vscode';
import { ButlerViewProvider } from '../panels/ButlerViewProvider';
import { appendTurn, turnsForModel, Turn } from './thread';
import { archiveSession, describeSession, formatSession, parseHistory, Session } from './history';

/**
 * The conversation: what was said, where it is kept, and what happens to it afterwards.
 *
 * Pulled out of `ChatService` because it is the one part with a lifetime of its own. The
 * thread outlives the webview (a panel move destroys the view, not the conversation),
 * outlives the session (the previous one is filed at startup), and is the thing a user
 * can lose — which makes "who owns it" a question worth being able to answer.
 *
 * **Persisted continuously rather than saved at shutdown.** `deactivate` is not
 * guaranteed to run — a crash, a force quit, or a killed extension host all skip it —
 * and a transcript that survives only clean exits is one you cannot rely on.
 */

/** The live session, written as it happens. */
const CURRENT_KEY = 'clarvis.chat.current';

/** Past sessions, newest first. */
const HISTORY_KEY = 'clarvis.chat.history';

export class Transcript {
  /**
   * The conversation, for this window's lifetime.
   *
   * Always starts empty: yesterday's questions are about yesterday's failures, and a
   * panel that opens mid-conversation reads as clutter rather than continuity. Nothing
   * is lost by starting clean — the previous session is filed into the archive at
   * startup and stays one button away.
   */
  private turns: Turn[] = [];

  /** When this session began — the archive is ordered by it. */
  private readonly startedAt = Date.now();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: ButlerViewProvider,
    private readonly log: (message: string) => void
  ) {}

  /** Whether anything has been said yet, for the surfaces that ask before acting. */
  get isEmpty(): boolean {
    return this.turns.length === 0;
  }

  /** The conversation so far, for replaying into a newly created webview. */
  get all(): Turn[] {
    return this.turns;
  }

  /**
   * Adds a turn, shows it, logs it, and saves.
   *
   * **Every line, not just the streamed ones.** Logging was added for model replies and
   * covered only those, so the lines written directly here left no record at all — and
   * when a user asked where a particular sentence had come from, the answer was
   * unfindable. Identifying what said something is the one question a log exists for.
   */
  async add(turn: Turn): Promise<void> {
    this.turns = appendTurn(this.turns, turn);
    this.panel.post({ type: 'chat-turn', speaker: turn.speaker, text: turn.text });
    this.note(turn.text, turn.speaker);
    await this.persist();
  }

  /**
   * Starts a turn that will be filled in as a reply streams.
   *
   * The returned object is live: the caller appends to `text` as fragments arrive, and
   * the transcript already holds it. Streaming paths need this — a turn appended only
   * once complete would vanish from the archive if the window closed mid-reply.
   */
  begin(speaker: Turn['speaker']): Turn {
    const turn: Turn = { speaker, text: '', at: Date.now() };
    this.turns = appendTurn(this.turns, turn);
    return turn;
  }

  /** Writes one line to the log, in the shape of a conversation. */
  note(text: string, speaker: Turn['speaker'] = 'clarvis'): void {
    if (!text.trim()) return;
    this.log(`${speaker === 'user' ? 'you' : 'chat'} | ${text.replace(/\s+/g, ' ').trim()}`);
  }

  /**
   * The conversation as the model sees it.
   *
   * Empty turns are dropped — a stream that failed on its first fragment would otherwise
   * be sent back as a blank assistant message, which some providers reject outright and
   * others treat as the model having nothing to say.
   */
  forModel(): { role: 'user' | 'assistant'; content: string }[] {
    return turnsForModel(this.turns);
  }

  async persist(): Promise<void> {
    const session: Session = { startedAt: this.startedAt, turns: this.turns };
    await this.context.workspaceState.update(CURRENT_KEY, session);
  }

  /**
   * Files the previous session into the archive.
   *
   * Done at *startup* rather than shutdown, because shutdown is not guaranteed to
   * happen — this way a crashed window's conversation is filed on next launch.
   */
  async rollOver(): Promise<void> {
    const leftover = parseHistory([this.context.workspaceState.get(CURRENT_KEY)])[0];
    if (!leftover || leftover.turns.length === 0) return;

    const history = parseHistory(this.context.workspaceState.get(HISTORY_KEY));
    await this.context.workspaceState.update(HISTORY_KEY, archiveSession(history, leftover));
    await this.context.workspaceState.update(CURRENT_KEY, undefined);
    this.log(`chat: filed previous session (${leftover.turns.length} turns)`);
  }

  async clear(): Promise<void> {
    this.turns = [];
    // Clearing means *delete*, so this is not filed into the archive — otherwise the
    // button labelled "there is no undo" would quietly keep a copy.
    await this.context.workspaceState.update(CURRENT_KEY, undefined);
    this.panel.post({ type: 'chat-thread', turns: [] });
    this.log('chat: conversation cleared');
  }

  /** Sends the whole conversation to a webview that has just been created. */
  replay(): void {
    this.panel.post({ type: 'chat-thread', turns: this.turns });
  }

  /**
   * Earlier conversations, opened as an editor tab.
   *
   * A document rather than a second webview: it scrolls, searches, copies and closes
   * exactly the way every other document does, and costs no UI to maintain.
   */
  async showHistory(emptyLine: string): Promise<void> {
    const history = parseHistory(this.context.workspaceState.get(HISTORY_KEY));

    if (history.length === 0) {
      void vscode.window.showInformationMessage(emptyLine);
      return;
    }

    const picked = await vscode.window.showQuickPick(
      history.map((session) => ({ ...describeSession(session), session })),
      { placeHolder: 'Earlier conversations, newest first' }
    );
    if (!picked) return;

    const document = await vscode.workspace.openTextDocument({
      content: formatSession(picked.session),
      language: 'markdown',
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }
}
