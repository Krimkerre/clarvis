import * as vscode from 'vscode';
import { ButlerViewProvider } from '../panels/ButlerViewProvider';
import { AvatarController } from '../AvatarController';
import { BusyTracker } from '../watch/BusyTracker';
import type { Pattern } from '../memory/patterns';
import { VoiceService } from '../voice/VoiceService';
import { Transcript } from './Transcript';
import { factsBlock, localAnswer } from './localAnswer';
import { WorkspaceFactsReader } from './WorkspaceFactsReader';
import { chatAction, isStopRequest } from './chatCommands';
import { ChatActions } from './ChatActions';
import { ModelService, explain } from '../model/ModelService';
import { isDoItNow, needsClassification, routeFor } from './routing';
import { classifyIntent } from './intentModel';
import { canEdit, PLAN_ADDENDUM } from './modes';
import { AgentRunner } from '../agent/AgentRunner';
import { mergeRunBack, reviewRun } from '../agent/reviewWizard';
import { detectTestCommand } from '../agent/testCommand';
import { QuipPicker } from '../personality/QuipPicker';
import { Voice } from '../personality/Voice';
import { characterWith } from '../personality/character';
import { ReplyStateReader, STATE_TAG_INSTRUCTION } from './replyState';
import { runCommand } from '../agent/tools/commandTools';
import { AgentTerminal } from '../agent/tools/commandTools';

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


  /** The answer currently streaming, so `Clarvis: Stop` has something to abort. */
  private streaming?: AbortController;

  /** Writes the opening and closing lines for a run, when a model is configured. */
  private live:
    | {
        acknowledge(task: string): Promise<string | undefined>;
        afterTask(task: string, summary: string): Promise<string | undefined>;
      }
    | undefined;

  /** The bank, for the closing aside when no model is available. */
  private readonly closers = new QuipPicker();

  /** Puts a line in character. Every user-facing sentence here goes through it. */
  private voiceOf: Voice | undefined;

  setVoiceWriter(voice: Voice): void {
    this.voiceOf = voice;
  }

  /**
   * Earlier conversations, and clearing this one.
   *
   * Kept on ChatService because the panel and the command palette both call them, and
   * because the empty-archive line is phrased in character — which is a chat concern
   * rather than a storage one.
   */
  async showHistory(): Promise<void> {
    await this.transcript.showHistory(
      await this.phrase('report', 'There are no earlier conversations. This is all there has ever been.')
    );
  }

  async clear(): Promise<void> {
    await this.transcript.clear();
  }

  /** Shorthand: in character where possible, verbatim where not. */
  private async phrase(
    purpose: 'report' | 'warn' | 'ask' | 'aside',
    fallback: string,
    keep?: string[]
  ): Promise<string> {
    return (await this.voiceOf?.say({ purpose, fallback, keep })) ?? fallback;
  }

  /** Supplied by the composition root, so this class stays free of provider details. */
  setLiveLines(live: NonNullable<ChatService['live']>): void {
    this.live = live;
  }

  /**
   * The last message that was *answered* rather than acted on.
   *
   * Kept so "do it" can mean it. Cleared once used, and never set by an agent run —
   * "do it" after work has already happened would repeat the work.
   */
  private lastAnswered?: string;

  /** Everything he knows about the project, gathered on demand. */
  private readonly workspace: WorkspaceFactsReader;

  /** What was said, where it is kept, and what becomes of it. */
  private readonly transcript: Transcript;

  /** The things chat can *do*, as opposed to answer. */
  private readonly actions: ChatActions;

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
    this.workspace = new WorkspaceFactsReader(context, tracker, FAILURE_KEY, recentFiles, patterns);
    this.transcript = new Transcript(context, panel, log);
    this.actions = new ChatActions(
      panel,
      voice,
      models,
      (text, state) => this.say(text, state),
      (text) => this.note(text),
      log,
      context.extensionUri
    );

    this.panel.onDidAsk((question) => void this.ask(question));
    this.panel.onDidToggleMute(() => this.voice.setMuted(!this.voice.isMuted));
    this.panel.onDidRequestClear(() => void this.confirmAndClear());
    this.panel.onDidRequestHistory(() => void this.showHistory());
    // The same path a typed "stop" takes, so clicking it while nothing is running says
    // so rather than silently doing nothing — which, on an always-visible button, would
    // read as the button being broken.
    this.panel.onDidRequestStop(() => void this.stopFromChat());
    this.panel.onDidRequestModels(() => void vscode.commands.executeCommand('clarvis.configureModels'));
    this.panel.onDidRequestMode(() => void this.actions.chooseMode());

    // Keep the bowtie's tooltip honest when the settings change underneath it —
    // including from the picker it opens, so it never describes the previous choice.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('clarvis.chat') || event.affectsConfiguration('clarvis.agent')) {
          this.actions.postModelInfo();
          this.actions.postMode();
        }
      })
    );

    // Roll the previous session into the archive before anything is written to it.
    // Done at *startup* rather than shutdown, because shutdown is not guaranteed to
    // happen — this way a crashed window's conversation is filed on next launch.
    void this.transcript.rollOver();

    // A newly resolved webview knows nothing. Replaying keeps a panel move or a
    // reload from looking like the conversation was thrown away.
    this.panel.onDidBecomeReady(() => {
      this.transcript.replay();
      // A panel moved mid-run comes back blank, and a run with no Stop button is a run
      // you cannot call off.
      this.setBusy(Boolean(this.streaming) || this.agentBusy.running);
      this.panel.post({ type: 'mute', muted: this.voice.isMuted });
      this.actions.postModelInfo();
      this.actions.postMode();
    });

    this.voice.onMuteChange((muted) => this.panel.post({ type: 'mute', muted }));
  }

  /** Answers a question, records both halves of the exchange, and shows the reply. */
  async ask(question: string): Promise<void> {
    await this.transcript.add({ speaker: 'user', text: question, at: Date.now() });

    // Before anything that costs a request: someone typing "stop" wants the thing to
    // stop, and asking a model about it first is both slow and beside the point.
    if (isStopRequest(question)) {
      await this.stopFromChat();
      return;
    }

    // Requests to *open* something are handled before answering: "change the voice"
    // wants the picker, not a paragraph about where the setting lives.
    const action = chatAction(question);
    if (action) {
      await this.actions.run(action, question);
      return;
    }

    // The matcher missed. A model may recognise it anyway — but only as a suggestion,
    // and a declined suggestion falls through to a normal answer (M8f2).
    if (await this.actions.offerInferred(question)) return;

    const mode = this.actions.mode();

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
    const facts = await this.workspace.read();

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

    this.avatar.setState('thinking', 'chat');
    const turn = this.transcript.begin('clarvis');
    this.panel.post({ type: 'chat-stream-start' });
    this.setBusy(true);

    let text = '';
    // The face the model asked for, read off the front of its own reply (M8e3).
    const reader = new ReplyStateReader();

    try {
      for await (const fragment of this.models.stream({
        system: `${this.systemPrompt() + addendum}\n\n${STATE_TAG_INSTRUCTION}`,
        messages: this.transcript.forModel(),
        signal: controller.signal,
      })) {
        const visible = reader.push(fragment);
        if (!visible) continue; // still buffering the opening, deciding on a tag

        // The expression applies at the *start* of the stream, so the face matches the
        // tone while the reply is being read rather than arriving after it.
        if (text === '') this.avatar.setState(reader.state ?? 'talking', 'chat');
        text += visible;
        turn.text = text;
        this.panel.post({ type: 'chat-stream', text: visible });
      }

      const remainder = reader.flush();
      if (remainder) {
        if (text === '') this.avatar.setState(reader.state ?? 'talking', 'chat');
        text += remainder;
        turn.text = text;
        this.panel.post({ type: 'chat-stream', text: remainder });
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
      this.setBusy(false);
      this.avatar.setState('neutral', 'chat');
      await this.transcript.persist();
    }

    // Spoken only once complete — speaking fragment by fragment would produce a
    // stutter, and the queue exists to serialise utterances, not syllables.
    if (text) {
      this.transcript.note(text);
      this.voice.say(text, 'chatReply');
    }
  }

  /**
   * Hands a task to the agent, streaming its steps into the transcript.
   *
   * The route is **announced before anything starts**, because a misrouted question
   * would otherwise begin editing files with no warning — and the announcement is what
   * makes Stop a real option rather than a theoretical one.
   */
  private async runAgent(task: string, because: string): Promise<void> {
    // Written for this job rather than the same sentence every time. It is the first
    // thing said in every run, which makes it the most repeated line in the product.
    const opening = (await this.live?.acknowledge(task)) ?? because;

    // Written, not spoken. The user asked for one line of a run to be read aloud, and
    // that line is the result — "right, on it" is not news.
    await this.note(opening);
    this.avatar.setState('thinking', 'chat');

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

    this.agentBusy.running = true;
    this.setBusy(true);
    // Held for the whole run, so a build finishing three seconds in cannot wipe the
    // expression of work the user is watching happen (M8e2).
    const holdingFace = this.avatar.claim('agent');
    this.avatar.setState('thinking', 'agent');

    // A single line while it works. Without it the panel sits silent for a minute and
    // the only signal is the avatar — but it is one line, not a running commentary.
    await this.note(await this.phrase('report', 'Working on it…'));

    // **Nothing technical reaches the transcript.** Tool calls, commands and the
    // model's own working-out all go to the Clarvis terminal, where a build log
    // belongs. The chat gets what a person would say: the result, and an aside.
    this.terminal.announce(`clarvis: ${task}`);

    try {
      for await (const event of runner.run(task, controller.signal)) {
        if (!event.text) continue;

        // Everything, verbatim, in the place that is meant to be read line by line.
        this.terminal.write(
          event.kind === 'tool' ? `\r\n· ${event.detail ?? event.text}\r\n` : event.text
        );
      }
    } finally {
      this.agentBusy.running = false;
      this.setBusy(false);
      this.streaming = undefined;
      this.avatar.setState('neutral', 'agent');
      holdingFace();
    }

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
        await this.phrase(
          'report',
          `${files.length} file${files.length === 1 ? '' : 's'} changed, on a temp branch.`,
          [String(files.length)]
        ),
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
          ? await vscode.window.showInformationMessage(
              await this.phrase('report', 'The tests pass.'),
              'Keep it',
              'Show me first'
            )
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

    this.avatar.setState('thinking', 'chat');
    this.panel.post({ type: 'chat-stream-start' });
    this.setBusy(true);

    // What was actually said, for the voice — accumulated from the stream rather than
    // taken from the closing event, which no longer repeats it.
    let spoken = '';
    const reader = new ReplyStateReader();

    // **The transcript gets it too.** This path streamed straight to the webview and
    // never appended a turn, so an answer that used tools lived only in the live panel:
    // move the panel, collapse it, or open the archive, and it was gone. The other reply
    // path had always done this; this one was written later and did not.
    const turn = this.transcript.begin('clarvis');

    try {
      for await (const event of runner.answer(question, controller.signal, addendum)) {
        if (!event.text) continue;

        // Only prose carries the tag. Tool lines are ours, not the model's.
        if (event.kind !== 'text') {
          this.panel.post({ type: 'chat-stream', text: `\n${event.step}. ${event.text}\n` });
          if (event.kind === 'error') spoken += event.text;
          continue;
        }

        const visible = reader.push(event.text);
        if (!visible) continue;

        if (!spoken) this.avatar.setState(reader.state ?? 'talking', 'chat');
        spoken += visible;
        turn.text = spoken;
        this.panel.post({ type: 'chat-stream', text: visible });
      }

      const remainder = reader.flush();
      if (remainder) {
        if (!spoken) this.avatar.setState(reader.state ?? 'talking', 'chat');
        spoken += remainder;
        turn.text = spoken;
        this.panel.post({ type: 'chat-stream', text: remainder });
      }
    } finally {
      this.streaming = undefined;
      this.panel.post({ type: 'chat-stream-end' });
      this.setBusy(false);
      this.avatar.setState('neutral', 'chat');
      await this.transcript.persist();
    }

    if (spoken.trim()) {
      this.transcript.note(spoken);
      this.voice.say(spoken, 'chatReply');
    }
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
   * Tells the panel whether there is something to stop.
   *
   * **Not inferred from the text stream, which is how it broke.** Stop was shown on
   * `chat-stream-start` and hidden on `chat-stream-end` — frames only the two *answer*
   * paths post. An agent run posts neither, so the button was hidden for the whole of a
   * run: invisible in the one situation it exists for, and visible only while a reply
   * was already finishing.
   */
  private setBusy(busy: boolean): void {
    if (busy) this.stopAnnounced = false;
    this.panel.post({ type: 'busy', busy });
  }

  /** Whether "Stopped." has already been said about whatever is running. */
  private stopAnnounced = false;

  /**
   * "Stop", typed rather than clicked.
   *
   * Answered locally either way. When there is something to stop it is stopped and said
   * briefly; when there is not, saying so costs nothing and is more useful than a model
   * being asked what "stop" means.
   */
  private async stopFromChat(): Promise<void> {
    const busy = Boolean(this.streaming) || this.agentBusy.running;

    // **Once per thing stopped.** Four clicks during one run produced four separate
    // replies — and because each was a rewrite of the word "Stopped." with no facts
    // attached, the model filled the space with invented history: a test suite failing
    // on a branch that does not exist, for a number of days nothing measures.
    if (busy && this.stopAnnounced) {
      this.stop();
      return;
    }

    if (!busy) {
      this.log('chat: asked to stop, nothing running');
      await this.say(await this.phrase('report', 'Nothing to stop. I was already idle.'), 'neutral');
      return;
    }

    this.log('chat: stopped by typed request');
    this.stopAnnounced = true;
    const runWillSayIt = this.agentBusy.running;
    this.stop();

    // **One "Stopped." per stop.** A run reports its own ending, so saying it here too
    // produced two lines — and because each was independently rewritten, they did not
    // even agree with each other.
    if (runWillSayIt) return;

    // Verbatim, not phrased. It is two words of status at a moment the user is anxious,
    // there is nothing in it to be funny about, and every rewrite of it so far has
    // either invented a project or complained about not having been given one.
    await this.say('Stopped.', 'neutral');
  }

  /**
   * The personality block (§2.1), trimmed to what an answering turn needs.
   *
   * The full agent and planning addenda arrive with M8g; sending them now would be
   * instructing the model about tools it does not have.
   */
  private systemPrompt(): string {
    return characterWith(
      'You are looking at their project: you watch builds, tests and errors as they happen.',
      'Answer in a few sentences unless asked for more. Prefer specifics over hedging.'
    );
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
    await this.transcript.add({ speaker: 'clarvis', text, at: Date.now() });
  }

  /**
   * Asks first, then clears.
   *
   * The button sits next to Mute, which gets clicked constantly, and there is no undo
   * — so a misclick would silently destroy the history. Skipped entirely when the
   * thread is already empty, since confirming a no-op is just noise.
   */
  async confirmAndClear(): Promise<void> {
    if (this.transcript.isEmpty) return;

    const confirmed = await vscode.window.showWarningMessage(
      'Clear the conversation? This cannot be undone.',
      { modal: true },
      'Clear'
    );
    if (confirmed !== 'Clear') return;

    await this.clear();
  }

  /** Opens the manual, for the command-palette route as well as `/help`. */
  async openHelp(): Promise<void> {
    await this.actions.openManual();
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

  /** Posts a reply, sets the face to match it, and returns the face to rest after. */
  private async say(text: string, state: Parameters<AvatarController['setState']>[0]): Promise<void> {
    await this.transcript.add({ speaker: 'clarvis', text, at: Date.now() });
    this.avatar.setState(state, 'chat');

    // Spoken as well as written. The reply is on screen either way — voice is never
    // the only copy, so muting or a broken key costs delivery, never the answer.
    // VoiceService owns talking/neutral from actual playback, which is why the state
    // above is set first and not fought over here.
    this.voice.say(text, 'chatReply');
  }

}
