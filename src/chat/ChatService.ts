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
import { factsBlock, localAnswer, WorkspaceFacts } from './localAnswer';
import { branchFromRequest, chatAction, ChatAction } from './chatCommands';
import { switchBranch } from '../agent/switchBranch';
import { describeGitPlainly } from '../agent/gitStatusPlain';
import { ModelService, explain } from '../model/ModelService';
import { isDoItNow, needsClassification, routeFor } from './routing';
import { classifyIntent } from './intentModel';
import { MODES, ChatMode, canEdit, modeSpec, PLAN_ADDENDUM } from './modes';
import { AgentRunner } from '../agent/AgentRunner';
import { mergeRunBack, reviewRun } from '../agent/reviewWizard';
import { detectTestCommand } from '../agent/testCommand';
import { runCommand } from '../agent/tools/commandTools';
import { AgentTerminal } from '../agent/tools/commandTools';

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

  /**
   * The last message that was *answered* rather than acted on.
   *
   * Kept so "do it" can mean it. Cleared once used, and never set by an agent run —
   * "do it" after work has already happened would repeat the work.
   */
  private lastAnswered?: string;
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
    private readonly terminal: AgentTerminal,
    /**
     * Shared run state: whether a run is happening, and what it committed. Quips keep
     * out of the way during one, and never celebrate its commits afterwards.
     */
    private readonly agentBusy: { running: boolean; noteCommit?: (hash: string) => void },
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
    this.panel.onDidRequestMode(() => void this.chooseMode());

    // Keep the bowtie's tooltip honest when the settings change underneath it —
    // including from the picker it opens, so it never describes the previous choice.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('clarvis.chat') || event.affectsConfiguration('clarvis.agent')) {
          this.postModelInfo();
          this.postMode();
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
      this.postMode();
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
      await this.runAction(action, question);
      return;
    }

    const mode = this.mode();

    // "Do it" means the thing just described. A verb list will always be missing the
    // word someone used — this is the four-character recovery rather than a rephrase.
    if (this.lastAnswered && isDoItNow(question) && canEdit(mode)) {
      const task = this.lastAnswered;
      this.lastAnswered = undefined;
      this.log(`chat: escalating the previous message to the agent — "${task.slice(0, 60)}"`);
      await this.runAgent(task, 'Right — doing it properly this time.');
      return;
    }

    const decision = routeFor(question);

    // The keyword router fell through rather than deciding, so ask the model what the
    // message actually is. Only in that case: a question with a question mark needs no
    // second opinion, and paying for one on every message would be absurd.
    if (
      decision.route === 'answer' &&
      canEdit(mode) &&
      mode !== 'plan' &&
      needsClassification(question)
    ) {
      const classified = await classifyIntent(this.models, question, this.log);
      if (classified === 'agent') {
        this.log('chat: routed to agent by the model, after the verb list missed it');
        await this.runAgent(question, 'That reads as a job, so I picked up the tools.');
        return;
      }
    }

    // **Routing comes before the local answer.** It used to come after, and the local
    // matcher swallowed jobs: "make a new branch called testing3" contains the word
    // "branch", so it was answered with the current branch name and never reached the
    // agent. A keyword match for a question is not evidence that a request is one.
    if (decision.route === 'agent' && canEdit(mode)) {
      this.log(`chat: routed to agent — ${decision.because}`);
      await this.runAgent(question, mode === 'agent' ? 'Agent mode — treating that as a job.' : decision.because);
      return;
    }

    // **The model phrases it; local state supplies the facts.** Canned answers are
    // instant and free, and they always sound canned — five fixed shapes, however the
    // question was asked. Handing the same facts to the model costs one cheap request
    // and gets an answer in Clarvis's voice that can also reason about them.
    this.log(`chat: routed to answer — ${decision.because}`);
    this.lastAnswered = question;
    const facts = await this.facts();

    if (await this.models.isReady('chat')) {
      const addendum = `${mode === 'plan' ? PLAN_ADDENDUM : ''}${factsBlock(facts)}`;
      await this.answerWithModel(question, addendum);
      return;
    }

    // No model configured, or unreachable. The canned answers are the fallback rather
    // than the default: worse prose, but they need no key and no network, which is
    // exactly the situation they are for.
    const reply = localAnswer(question, facts);
    if (reply) {
      this.log('chat: answered from local state (no model available)');
      await this.say(reply.text, reply.state);
      return;
    }

    await this.say(
      "That's beyond what I've watched happen here, and there's no model wired up to think about it. The bowtie by the prompt sorts that out.",
      'neutral'
    );
  }

  /**
   * Answers with the configured model, streaming as it arrives.
   *
   * Streamed rather than awaited whole: a ten-second silence reads as a hang, and the
   * avatar's `thinking` → `talking` transition is meant to track the real stream
   * instead of a timer (§4.6).
   */
  /** The mode in force, defaulting to auto when the setting says something unknown. */
  private mode(): ChatMode {
    return modeSpec(
      vscode.workspace.getConfiguration('clarvis').get<string>('chat.mode', 'auto')
    ).id;
  }

  /** Lets the user pick how much Clarvis may do, and says what each choice means. */
  private async chooseMode(): Promise<void> {
    const current = this.mode();

    const picked = await vscode.window.showQuickPick(
      MODES.map((mode) => ({
        label: `${mode.id === current ? '$(check) ' : ''}${mode.label}`,
        description: mode.canEdit ? 'can change files' : 'read-only',
        detail: mode.detail,
        id: mode.id,
      })),
      { placeHolder: 'What should I be allowed to do?', matchOnDetail: true }
    );
    if (!picked) return;

    const config = vscode.workspace.getConfiguration('clarvis');
    const scope =
      config.inspect('chat.mode')?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;

    await config.update('chat.mode', picked.id, scope);
    this.log(`chat: mode set to ${picked.id}`);
    this.postMode();
  }

  private postMode(): void {
    const spec = modeSpec(this.mode());
    this.panel.post({
      type: 'mode',
      short: spec.short,
      safe: !spec.canEdit,
      detail: `${spec.label} — ${spec.detail}`,
    });
  }

  private async answerWithModel(question: string, addendum = ''): Promise<void> {
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

    // With a tool-capable chat model, questions get to *look* at the project rather
    // than guess — reading a file to answer a question needs no branch and no commit.
    if (await this.models.supportsTools('chat')) {
      await this.answerWithTools(question, addendum);
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
        system: this.systemPrompt() + addendum,
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

  /**
   * Hands a task to the agent, streaming its steps into the transcript.
   *
   * The route is **announced before anything starts**, because a misrouted question
   * would otherwise begin editing files with no warning — and the announcement is what
   * makes Stop a real option rather than a theoretical one.
   */
  private async runAgent(task: string, because: string): Promise<void> {
    await this.say(because, 'thinking');

    this.streaming?.abort();
    const controller = new AbortController();
    this.streaming = controller;

    const runner = new AgentRunner(
      this.context,
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      this.models,
      this.terminal,
      this.log
    );

    this.panel.post({ type: 'chat-stream-start' });
    this.agentBusy.running = true;
    let spoken = '';

    try {
      for await (const event of runner.run(task, controller.signal)) {
        if (!event.text) continue;

        // Tool calls are shown as they happen — watching work rather than a spinner.
        // No step numbers here: they are scaffolding for a log, and in a conversation
        // they make a person sound like a build system.
        const line = event.kind === 'tool' ? `\n${event.text}…\n` : event.text;
        if (event.kind === 'text' || event.kind === 'done' || event.kind === 'error') {
          spoken += event.text;
        }

        this.panel.post({ type: 'chat-stream', text: line });
      }
    } finally {
      this.agentBusy.running = false;
      this.streaming = undefined;
      this.panel.post({ type: 'chat-stream-end' });
      this.avatar.setState('neutral');
      await this.persist();
    }

    // Tool calls are never spoken — reading nine of them aloud would be a recital.
    // What the model actually said is, including where the run left you.
    if (spoken.trim()) this.voice.say(spoken, 'chatReply');

    // Commits the run made are not news about the user, so the personality is told
    // about them rather than left to congratulate Clarvis on his own work.
    for (const hash of runner.result.commits) this.agentBusy.noteCommit?.(hash);

    // A run can create branches — "make a branch called testing3" is a perfectly
    // ordinary request — and one the user just asked for should be placed in the flow
    // now, not a minute later when the connection to what they did has faded.
    await vscode.commands.executeCommand('clarvis.checkBranchFlow');

    // The close of a run is a decision, not an announcement: what changed, what the
    // options are, and the user chooses. Offered rather than forced — a modal after
    // every run would be its own nuisance.
    // Only when there is something to review. A run that changed nothing has nothing
    // to merge, keep or throw away, and offering anyway is a dialog about an absence.
    const { commits, files } = runner.result;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (files.length > 0) {
      // The likely answer first, and the *useful* one first of all: a change nobody
      // has run is a change nobody knows about. Offering to check it before offering
      // to keep it is the order a careful person would work in.
      const testCommand = await detectTestCommand(root);

      const answer = await vscode.window.showInformationMessage(
        `Clarvis: ${files.length} file${files.length === 1 ? '' : 's'} changed, on a temp branch.`,
        ...(testCommand ? ['Check it works'] : []),
        'Keep it',
        'Show me first'
      );

      const base = this.context.workspaceState.get<string>('clarvis.agent.baseBranch');

      if (answer === 'Check it works' && testCommand) {
        const passed = await this.checkItWorks(testCommand);

        // Pass or fail, the next offer follows from the result rather than repeating
        // the same menu — that is the whole point of having run it.
        const next = passed
          ? await vscode.window.showInformationMessage('Clarvis: tests pass.', 'Keep it', 'Show me first')
          : await vscode.window.showWarningMessage(
              "Clarvis: tests fail. That may be my doing, or it may have been failing already.",
              'Show me first',
              'Bin it'
            );

        if (next === 'Keep it') {
          await mergeRunBack(commits, files, this.log, base, (text) => void this.remark(text));
          return;
        }
        if (next === 'Bin it' || next === 'Show me first') {
          await reviewRun(commits, files, this.log, base, (text) => void this.remark(text));
        }
        return;
      }

      if (answer === 'Keep it') {
        await mergeRunBack(commits, files, this.log, base, (text) => void this.remark(text));
        return;
      }

      if (answer === 'Show me first') {
        await reviewRun(commits, files, this.log, base, (text) => void this.remark(text));
      }
    }
  }

  /** The read-only tool loop, for questions that need to see the code. */
  private async answerWithTools(question: string, addendum = ''): Promise<void> {
    this.streaming?.abort();
    const controller = new AbortController();
    this.streaming = controller;

    const runner = new AgentRunner(
      this.context,
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      this.models,
      this.terminal,
      this.log
    );

    this.avatar.setState('thinking');
    this.panel.post({ type: 'chat-stream-start' });

    // What was actually said, for the voice — accumulated from the stream rather than
    // taken from the closing event, which no longer repeats it.
    let spoken = '';

    try {
      for await (const event of runner.answer(question, controller.signal, addendum)) {
        if (!event.text) continue;
        if (event.kind === 'text' || event.kind === 'error') spoken += event.text;

        this.panel.post({
          type: 'chat-stream',
          text: event.kind === 'tool' ? `\n${event.step}. ${event.text}\n` : event.text,
        });
      }
    } finally {
      this.streaming = undefined;
      this.panel.post({ type: 'chat-stream-end' });
      this.avatar.setState('neutral');
      await this.persist();
    }

    if (spoken.trim()) this.voice.say(spoken, 'chatReply');
  }

  /**
   * Runs the project's own tests and says how it went.
   *
   * In the same terminal the agent uses, so it reads as one continuous session rather
   * than a second thing happening somewhere else. The result is reported in the
   * transcript either way — a check whose outcome you have to go looking for is not
   * much of a check.
   */
  private async checkItWorks(command: string): Promise<boolean> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    await this.remark(`Running ${command} to see if it still works.`);

    this.terminal.announce(command);
    const result = await runCommand(root, command, (chunk) => this.terminal.write(chunk));

    const passed = result.exitCode === 0;
    this.log(`check: "${command}" exited ${result.exitCode}`);

    await this.note(
      passed
        ? `\`${command}\` passed.`
        : `\`${command}\` failed — exit ${result.exitCode ?? 'killed'}. The output is in the Clarvis terminal.`
    );

    return passed;
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
  private async runAction(action: ChatAction, question = ''): Promise<void> {
    // Handled here rather than by the agent: a checkout is one deterministic command,
    // and routing it through a run would create an isolation branch, switch away from
    // it, and then try to tidy that branch up by switching back — undoing the thing
    // that was asked for.
    if (action === 'explainGit') {
      const lines = await describeGitPlainly();
      await this.say(lines.join(' '), 'neutral');
      return;
    }

    if (action === 'switchBranch') {
      const said = await switchBranch(branchFromRequest(question), this.log);
      if (said) await this.say(said, 'neutral');
      return;
    }

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

  /**
   * Says something out loud *and* writes it down.
   *
   * Distinct from `note()`, which only records. The difference is who already spoke:
   * briefings, quips and completion notices are voiced by whatever raised them, so
   * making `note()` speak would say all of them twice. The wizard has no voice of its
   * own, and its lines are the direct result of a button the user just pressed —
   * solicited, per §4.4, and therefore never a surprise.
   */
  async remark(text: string): Promise<void> {
    await this.note(text);
    this.voice.say(text, 'chatReply');
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
