import * as vscode from 'vscode';
import { ButlerViewProvider } from '../panels/ButlerViewProvider';
import { AvatarController } from '../AvatarController';
import { BusyTracker } from '../watch/BusyTracker';
import type { Pattern } from '../memory/patterns';
import { VoiceService } from '../voice/VoiceService';
import { Transcript } from './Transcript';
import { Busy } from './Busy';
import { Replier } from './Replier';
import { RunSession } from './RunSession';
import { factsBlock, localAnswer } from './localAnswer';
import { WorkspaceFactsReader } from './WorkspaceFactsReader';
import { chatAction, isStopRequest } from './chatCommands';
import { ChatActions } from './ChatActions';
import { ModelService } from '../model/ModelService';
import { isDoItNow, needsClassification, routeFor } from './routing';
import { classifyIntent } from './intentModel';
import { canEdit, ChatMode, modeSpec, PLAN_ADDENDUM } from './modes';
import { Voice } from '../personality/Voice';
import { AgentTerminal } from '../agent/tools/commandTools';
import { PlanningChatIO } from './PlanningChatIO';
import { runPlanning } from '../planning/PlanningFlow';


/**
 * The chat panel's coordinator: what a message is, and who deals with it.
 *
 * Almost nothing happens here. A message is a stop, an action, a job, or a question, and
 * each of those has an owner — `ChatActions`, `RunSession`, `Replier` — with `Transcript`
 * holding what was said, `Busy` holding whether he is working, and
 * `WorkspaceFactsReader` holding what he knows. This file decides which, and wires them
 * together.
 *
 * **It was 1,071 lines and owned all of it.** The split came from a complexity report,
 * but the number was the symptom: routing, modes, runs, history, facts, voice and panel
 * wiring in one class meant every one of those had the same reason to change, and the
 * bugs lived in the seams between them — Stop wired to the wrong signal, a reply that
 * never reached the archive, two owners of "is he busy".
 *
 * **Local answers remain the floor.** A useful share of what you ask a coding assistant
 * is already known — what's failing, what branch, how long that took, have we seen this
 * before — and M3–M5 answer those with no key, no network and no token spend. The model
 * is what phrases them; it is not what knows them.
 */
export class ChatService {
  /** Whether he is doing something, and how to make him stop. */
  private readonly busy: Busy;

  /** Writes the opening and closing lines for a run, when a model is configured. */
  private live:
    | {
        acknowledge(task: string): Promise<string | undefined>;
        afterTask(task: string, summary: string): Promise<string | undefined>;
      }
    | undefined;

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
    this.runs.setLiveLines(live);
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

  /** The two paths a question takes once a model is involved. */
  private readonly replier: Replier;

  /** A task, from "on it" to "what would you like done with it". */
  private readonly runs: RunSession;

  /** The things chat can *do*, as opposed to answer. */
  private readonly actions: ChatActions;

  /** Present only while a planning interview is running in the panel. */
  private planningIO?: PlanningChatIO;

  /**
   * True between offering to plan and the user answering.
   *
   * The offer is a question, so the next message is an answer to it — not something
   * to route as a job or a question of its own. Cleared either way, so a "no" (or
   * anything else) never leaves chat quietly intercepting later messages.
   */
  private awaitingPlanAnswer = false;

  /**
   * Runs the whole planning milestone through the chat panel (M9, §4.9).
   *
   * The same flow the command palette drives — only the `PlanningIO` differs, so
   * questions land in the transcript and the next message typed is the answer.
   * Guarded against re-entry: a second interview started mid-interview would have
   * two sets of questions competing for the same replies.
   */
  private async startPlanning(): Promise<void> {
    if (this.planningIO) {
      await this.note("We're already in the middle of that one.");
      return;
    }

    const io = new PlanningChatIO(
      (text) => this.remark(text),
      (text) => this.note(text),
      (items) => this.panel.post(items.length ? { type: 'choices', items } : { type: 'choices-clear' }),
      this.log
    );
    this.planningIO = io;
    try {
      await runPlanning(
        this.models,
        io,
        {
          acknowledge: (task) => this.live?.acknowledge(task) ?? Promise.resolve(undefined),
          afterTask: (task, summary) => this.live?.afterTask(task, summary) ?? Promise.resolve(undefined),
        },
        this.log,
        // Plan mode hands straight to code mode — the same run path a typed job
        // takes, so nothing about the build is special-cased for having come from
        // planning. Cleared first: the run posts its own questions to chat, and
        // planning must not still be intercepting them.
        async (task) => {
          this.planningIO = undefined;
          await this.runs.run(task, 'Plan approved — starting on milestone one.');
        }
      );
    } finally {
      this.planningIO = undefined;
    }
  }

  /**
   * Whether planning consumed this message — either as an answer to a question it
   * asked, or as the reply to the offer to start.
   */
  private async planningTook(question: string): Promise<boolean> {
    if (this.awaitingPlanAnswer) return this.answeredPlanOffer(question);
    if (!this.planningIO?.isWaiting) return false;

    if (isStopRequest(question)) {
      this.log('chat: planning cancelled from chat');
      this.planningIO.cancel();
      return true;
    }
    this.planningIO.supply(question);
    return true;
  }

  /** Takes the reply to the planning offer. `true` once planning has started. */
  private async answeredPlanOffer(question: string): Promise<boolean> {
    this.awaitingPlanAnswer = false;
    this.panel.post({ type: 'choices-clear' });

    if (/^(y|yes|sure|go on|please|ok|okay)\b/i.test(question.trim())) {
      await this.startPlanning();
      return true;
    }

    this.log('chat: planning offer declined');
    return false;
  }

  /**
   * Offers to plan, once, when a project has no `plan.md` of its own.
   *
   * **An offer, not an ambush.** §4.9 wants planning to be the front door, and a
   * project with no plan is exactly who it is for — but launching a ten-minute
   * interview because someone opened a folder would be the nagging this product is
   * written against (§6). So: a single line in the transcript, and nothing happens
   * unless they answer it.
   */
  async offerPlanningIfUnplanned(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    const exists = await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, 'plan.md')).then(
      () => true,
      () => false
    );
    if (exists) return;

    this.log('chat: no plan.md here, offered to plan');

    // **A question with buttons, not an instruction to remember a command.** Spoken
    // as well as written: it is the one line that tells someone this feature exists,
    // and a notice nobody hears is a feature nobody finds.
    await this.remark(
      await this.phrase(
        'ask',
        "No plan.md here. Whatever this is, it is being held together by optimism. Shall we plan something?",
        ['plan.md']
      )
    );
    this.awaitingPlanAnswer = true;
    this.panel.post({ type: 'choices', items: [{ label: 'Yes' }, { label: 'No' }] });
  }

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
    /** Drops what M5 remembers about a job, for when the user asks him to let it go. */
    private readonly forgetPattern: (needle: string) => Promise<number>,
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
    this.workspace = new WorkspaceFactsReader(context, tracker, recentFiles, patterns);
    this.transcript = new Transcript(context, panel, log);
    this.busy = new Busy(panel, agentBusy);
    this.runs = new RunSession(
      context,
      avatar,
      models,
      terminal,
      this.busy,
      (text) => this.note(text),
      (text) => this.remark(text),
      (purpose, fallback, keep) => this.phrase(purpose, fallback, keep),
      log
    );
    this.replier = new Replier(
      panel,
      avatar,
      voice,
      models,
      terminal,
      this.transcript,
      this.busy,
      context,
      (text, state) => this.say(text, state),
      log
    );
    this.actions = new ChatActions(
      panel,
      voice,
      models,
      (text, state) => this.say(text, state),
      (text) => this.note(text),
      log,
      context,
      (needle) => this.forgetPattern(needle),
      patterns
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
      this.busy.show(this.busy.isBusy);
      this.panel.post({ type: 'mute', muted: this.voice.isMuted });
      this.actions.postModelInfo();
      this.actions.postMode();
    });

    this.voice.onMuteChange((muted) => this.panel.post({ type: 'mute', muted }));
  }

  /** Answers a question, records both halves of the exchange, and shows the reply. */
  /**
   * Whether this message is work, and what to call it if so.
   *
   * Three ways in, in the order they can be trusted. "Do it" refers to the thing just
   * described, and is the four-character recovery for a verb list that will always be
   * missing the word someone used. The keyword router decides when it can. The model is
   * asked only when the router fell through — a question with a question mark needs no
   * second opinion, and paying for one on every message would be absurd.
   *
   * **Routing comes before the local answer**, which it did not always: the local
   * matcher swallowed jobs, because "make a new branch called testing3" contains the
   * word "branch" and was answered with the current branch name. A keyword match for a
   * question is not evidence that a request is one.
   */
  private async jobIn(
    question: string,
    mode: ChatMode,
    decision: ReturnType<typeof routeFor>
  ): Promise<{ task: string; because: string } | undefined> {
    if (!canEdit(mode)) return undefined;

    if (this.lastAnswered && isDoItNow(question)) {
      const task = this.lastAnswered;
      this.lastAnswered = undefined;
      this.log(`chat: escalating the previous message to the agent — "${task.slice(0, 60)}"`);
      return { task, because: 'Right — doing it properly this time.' };
    }

    if (decision.route === 'agent') {
      this.log(`chat: routed to agent — ${decision.because}`);
      return {
        task: question,
        because: mode === 'agent' ? 'Agent mode — treating that as a job.' : decision.because,
      };
    }

    if (mode !== 'plan' && needsClassification(question)) {
      const classified = await classifyIntent(this.models, question, this.log);

      if (classified === 'agent') {
        this.log('chat: routed to agent by the model, after the verb list missed it');
        return { task: question, because: 'That reads as a job, so I picked up the tools.' };
      }
    }

    return undefined;
  }

  async ask(question: string): Promise<void> {
    await this.transcript.add({ speaker: 'user', text: question, at: Date.now() });

    // **While planning runs, every message is an answer to the question just asked.**
    // Routing it — stop, action, job, question — would be four chances to misread
    // "yes" or "3" as something else entirely, so `ask()` gets out of the way.
    // Planning owns the message when it is mid-question, or when the offer to plan
    // is still hanging. Both are questions Clarvis just asked, and routing an answer
    // to them as a job or a query would be several chances to misread "yes".
    if (await this.planningTook(question)) return;

    // Before anything that costs a request: someone typing "stop" wants the thing to
    // stop, and asking a model about it first is both slow and beside the point.
    if (isStopRequest(question)) {
      await this.stopFromChat();
      return;
    }

    // Requests to *open* something are handled before answering: "change the voice"
    // wants the picker, not a paragraph about where the setting lives.
    const action = chatAction(question);
    if (action === 'planProject') {
      await this.startPlanning();
      return;
    }
    if (action) {
      await this.actions.run(action, question);
      return;
    }

    // The matcher missed. A model may recognise it anyway — but only as a suggestion,
    // and a declined suggestion falls through to a normal answer (M8f2). Planning is
    // the one action ChatActions cannot run itself: it owns the whole conversation
    // for the next several minutes, which is ChatService's to hand over, not its.
    const inferred = await this.actions.offerInferred(question);
    if (inferred === 'planProject') {
      await this.startPlanning();
      return;
    }
    if (inferred) return;

    const mode = this.actions.mode();
    const decision = routeFor(question);

    const job = await this.jobIn(question, mode, decision);
    if (job) {
      await this.runs.run(job.task, job.because);
      return;
    }

    // **A job the mode will not let him do is worth saying so.** Without this the log
    // read "routed to answer — that reads as a job", the reply explained that it could
    // not edit anything, and the user was left to work out for themselves that a mode
    // was the reason. Said before the answer rather than instead of it: the answer is
    // still useful, and the note is what makes the refusal make sense.
    if (decision.route === 'agent' && !canEdit(mode)) {
      this.log(`chat: job blocked by ${mode} mode`);
      await this.note(
        `That's a job, and ${modeSpec(mode).label} won't let me change files. Switch to Agent or Auto and ask again.`
      );
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
      await this.replier.withModel(question, addendum);
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

  /** The read-only tool loop, for questions that need to see the code. */
  /** Cancels the answer in flight, if there is one. */
  stop(): void {
    this.busy.stop();
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

  /**
   * "Stop", typed rather than clicked.
   *
   * Answered locally either way. When there is something to stop it is stopped and said
   * briefly; when there is not, saying so costs nothing and is more useful than a model
   * being asked what "stop" means.
   */
  private async stopFromChat(): Promise<void> {
    const busy = this.busy.isBusy;

    // **Once per thing stopped.** Four clicks during one run produced four separate
    // replies — and because each was a rewrite of the word "Stopped." with no facts
    // attached, the model filled the space with invented history: a test suite failing
    // on a branch that does not exist, for a number of days nothing measures.
    if (busy && !this.busy.claimAnnouncement()) {
      this.stop();
      return;
    }

    if (!busy) {
      this.log('chat: asked to stop, nothing running');
      await this.say(await this.phrase('report', 'Nothing to stop. I was already idle.'), 'neutral');
      return;
    }

    this.log('chat: stopped by typed request');
    const runWillSayIt = this.busy.isRunning;
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
