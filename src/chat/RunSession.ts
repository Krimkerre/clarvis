import { activeBlocker, BLOCKER_KEY, MissingDependency } from '../agent/missingDependency';
import * as vscode from 'vscode';
import { AvatarController } from '../AvatarController';
import { ModelService } from '../model/ModelService';
import { AgentRunner } from '../agent/AgentRunner';
import type { InvokedSkill } from '../agent/tools/skillTools';
import { AgentTerminal, runCommand } from '../agent/tools/commandTools';
import { mergeRunBack, reviewRun } from '../agent/reviewWizard';
import { detectTestCommand } from '../agent/testCommand';
import { Busy } from './Busy';
import { offerGitFix, setUpGitHere } from '../agent/gitOffer';
import { CODEX_GIT_LINES, gitSetupChoice, gitSetupChoices, offerCodexGitSetup } from './codexGitSetup';
import { whereCodexWorks, type CodexWhere } from './codexLeftWork';
import { whereClarvisWorks, type ClarvisWhere } from './clarvisLeftWork';
import { BASE_BRANCH_KEY } from '../agent/AgentBranch';
import { isAgentBranch } from '../agent/branchNames';
import type { LeftWorkFound } from '../agent/leftBranches';
import { earlierRunPort, findLeftRuns, placedRunOptions, rememberLeftRun, type LeftRunTask } from '../agent/leftRuns';
import { findLeftWork } from '../engine/codex/leftTasks';
import { QuipPicker } from '../personality/QuipPicker';
import { matchStep, readStepMarkers } from '../agent/stepProgress';
import { plannedMilestoneOffer, stepCapOffer, unplannedRunOffer } from '../planning/planUpdate';
import { StepExplanation } from '../agent/stepExplanation';
import { PendingChoice } from './PendingChoice';
import { reviewMilestone } from '../agent/readBack';
import { reviewSummary } from '../agent/milestoneReview';
import { Finding } from '../planning/analysisPrompt';
import { buildRunRecord, LAST_RUN_KEY, LedgerEvent } from '../agent/runLedger';
import { randomUUID } from 'crypto';
import type { AgentEvent } from '../agent/AgentRunner';
import type { CodingRun, EngineKind, RunFence } from '../engine/CodingRun';
import { codexModeFor } from '../engine/engineChoice';
import {
  chatModeSetting,
  currentEngineChoice,
  maxStepsSetting,
  ravisAccess,
  runSkillsLookup,
  takeRunLock,
  windowIdentity,
  workspaceRoot,
  type RavisAccess,
  type RavisLookup,
} from '../engine/engineHost';
import type { LockClient } from '../engine/lock/lockClient';
import type { AgentEngineOptions } from '../agent/AgentRunner';
import { writeCheckpoint } from '../engine/checkpoint/checkpointFile';
import { GitFacts } from '../engine/checkpoint/gitFacts';
import { newCheckpoint, type TaskCheckpoint } from '../engine/checkpoint/taskCheckpoint';
import { findGitDir } from '../engine/lock/gitDir';
import type { ProjectLock, TakeoverOffer } from '../engine/lock/projectLock';
import { checkpointFromClarvis } from '../engine/transfer/fromSource';
import { ChatEngineSwitch, type CurrentRun, type SwitchHost } from './EngineSwitch';
import type { RequestPrompt } from '../engine/codex/approvals';
import { reattachStep, type ReattachStep } from '../engine/codex/reattach';
import { RemoteCodexRunner } from '../engine/codex/RemoteCodexRunner';
import { CODEX_LINES, ravisUnusableLine, tokenLine } from '../engine/codex/translate';
import type { RelayClient } from '../engine/relay/relayClient';
import type { SessionSummary } from '../engine/relay/relayTypes';
import { TokenStore } from '../engine/relay/tokenStore';
import { asksGitOfferBeforeRun, chatRunDecision, createCodingRun, undeliveredLine, type SiteDecision } from './codingRunFactory';
import { storedCodexChoice } from './codexMenuHost';

/** The lines a model writes for a run: one to open with, one to close on. */
interface LiveLines {
  acknowledge(task: string): Promise<string | undefined>;
  afterTask(task: string, summary: string): Promise<string | undefined>;
}

/** A run ready to go, and what to let go of once it has ended (M15 C2a). */
interface OpenedRun {
  runner: CodingRun;
  release(): Promise<void>;
  /** M15 C3: the project lock a run of Clarvis's own engine holds, its task, and the checkpoint it started from. */
  lock?: ProjectLock;
  taskId?: string;
  base?: TaskCheckpoint;
  /** The run carries on a task it inherited on its branch (a takeover, or a closed window's): nothing is asked about left work. */
  continuing?: boolean;
}

/** What a run needs before it is built: Clarvis's engine its fence, Codex its RAVIS. */
interface RunGuard {
  fence?: RunFence;
  relay?: RelayClient;
  locks?: LockClient;
  release(): Promise<void>;
  lock?: ProjectLock;
  taskId?: string;
  base?: TaskCheckpoint;
  /** A task inherited from a window taken over or gone: continued on its branch (review AL3). */
  engine?: AgentEngineOptions;
}

/** Why a run didn't start, and the Codex session to follow instead when that is the reason. */
interface RunRefusal {
  refusal: string;
  attachSessionId?: string;
}

/** Codex needs a folder, and a RAVIS this window can reach with its credential. */
function codexGuard(root: string | undefined, ravis: RavisLookup): RunGuard | RunRefusal {
  if (!root) return { refusal: CODEX_LINES.noFolder };
  if (ravis.kind === 'ready') return { relay: ravis.access.relay, locks: ravis.access.locks, release: async () => undefined };
  if (ravis.kind === 'no_credential') return { refusal: CODEX_LINES.noCredential };
  return { refusal: ravisUnusableLine(ravis.kind === 'unusable' ? ravis.reason : 'no RAVIS address') };
}

/**
 * A task, from "on it" to "what would you like done with it".
 *
 * **The transcript gets what a person would say; the terminal gets everything else.**
 * Tool calls, commands and the model's working-out go to the Clarvis terminal, where a
 * build log belongs — the chat gets the opening line, the result, and the decision. That
 * split was made after a run filled the conversation with ten lines of machine output.
 *
 * The closing offer is the reason this is a session rather than a function call: a run
 * does not end when the model stops, it ends when the user has decided what to do with
 * what it produced.
 */
export class RunSession {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly avatar: AvatarController,
    private readonly models: ModelService,
    private readonly terminal: AgentTerminal,
    private readonly busy: Busy,
    private readonly note: (text: string) => Promise<void>,
    private readonly remark: (text: string) => Promise<void>,
    private readonly phrase: (purpose: 'report' | 'warn' | 'ask' | 'aside', fallback: string, keep?: string[]) => Promise<string>,
    /** Shows where the run has got to: a step, or a passing status (M15 C2b+). A function rather than the panel
     * itself: this class needs one frame, not a view. */
    private readonly showProgress: (frame: { current: number; total: number; label: string } | { status: string }) => void,
    /** Puts the answers in the panel as buttons. Typing still works regardless. */
    private readonly offer: (items: { label: string; detail?: string }[]) => void,
    private readonly log: (message: string) => void
  ) {
    // The nudge speaks; it does not write. Someone who has not answered is not
    // reading the panel, so another line in the panel is the one thing guaranteed not
    // to reach them.
    this.pending = new PendingChoice(this.offer, (line) => void this.remark(line));
  }

  /**
   * The step-approval question, when one is on screen.
   *
   * **In the chat, not in a modal.** Approval used to be a `showInformationMessage`
   * with `modal: true`, which greys out the editor, cannot be scrolled back to, and
   * puts the one decision that matters somewhere other than the conversation it
   * belongs to. Found live during the first-run checklist.
   */
  private readonly pending: PendingChoice;

  /** Whether a step is waiting on an answer. Chat checks before routing a message. */
  get awaitingStep(): boolean {
    return this.pending.isWaiting;
  }

  /** Hands a typed message to the question waiting for it; `false` if it was not an answer. */
  answerStep(text: string): boolean {
    return this.pending.supply(text);
  }

  /**
   * Lets go of the question on screen, because Stop was pressed.
   *
   * **Reported 11 September 2026: Stop did not release it.** Stop aborted the run and
   * nothing else, so the run stayed parked on "Do it / Skip this step", the buttons
   * stayed in the panel, and the stop only took effect once someone answered.
   *
   * Cancelled rather than answered. No answer is "not approved" to `askStep`, which the
   * runner then sees was a stop (`stepAfterAsking`); to the landing question it is
   * "leave it there", so nothing moves. The opposite of `modeStoppedAsking`, which
   * answers "Do it" because the user wants the run to carry on without them.
   */
  stopWaiting(): void {
    if (!this.pending.isWaiting) return;

    this.log('agent: stopped — releasing the question that was waiting');
    this.pending.cancel();
  }

  /** The written bank, for the closing aside when no model is available. */
  private readonly closers = new QuipPicker();

  /**
   * The writer for the opening line, once a model exists.
   *
   * Set after construction because the model layer is wired later — and kept optional
   * rather than making the whole session optional, which pushed `?.` into every caller
   * and cost the routing method three branches for nothing.
   */
  private live: LiveLines | undefined;

  setLiveLines(live: LiveLines): void {
    this.live = live;
  }

  /**
   * Hands a task to the agent, streaming its steps into the transcript.
   *
   * The route is **announced before anything starts**, because a misrouted question
   * would otherwise begin editing files with no warning — and the announcement is what
   * makes Stop a real option rather than a theoretical one.
   */
  /**
   * Whether this run stops and asks before each step that acts.
   *
   * Set by the caller from the mode: Agent asks, Auto does not. Auto's whole
   * proposition is deciding for itself, and a mode that asked before every step
   * would be Agent wearing a different label.
   */
  private stepApproval = false;

  /**
   * Whether the mode *currently* asks, checked at each step rather than at the start.
   *
   * **Because a mode change mid-run did nothing.** Set once when the run began, the
   * flag went on asking after someone switched to Unattended precisely to stop being
   * asked — found live, part-way through the second checklist project. Switching is
   * something people do *because* the run is going well and they no longer want to
   * shepherd it; a setting that only applies to the next run is the setting they were
   * not reaching for.
   *
   * Read through a function so the answer comes from the mode as it is now. Note that
   * Auto still asks: `asksFirst` is true for it by design, and Unattended is the one
   * that does not (§4.6).
   */
  private asksNow?: () => boolean;

  /**
   * Lets go of a step question when the mode has just stopped asking.
   *
   * Switching to Unattended is done *because* answering has become the annoyance, and
   * most often while looking at the question that made it one. Leaving that one
   * pending means the switch appears not to have worked — found live on milestone 3,
   * where the mode changed and the button still had to be pressed.
   *
   * Only ever releases a *step* question. The deny-list gate is a different thing and
   * is not a mode setting: `rm -rf` stops and asks in every mode, including this one.
   */
  modeStoppedAsking(): void {
    // **Build on or start fresh** (plan.md M15), for either engine: a mode switch while that question shows drops it,
    // whichever mode it is, and never presses a button. The answer depended on the mode it was asked in (Unattended
    // doesn't ask at all).
    if (this.leftWorkAskedIn !== undefined && this.pending.isWaiting && chatModeSetting() !== this.leftWorkAskedIn) {
      this.log('left work: the mode changed while asking, so the question is dropped and nothing runs');
      this.pending.supply('Do it', false);
      return;
    }
    // M15 C2b: a Codex task's requests are its runner's. Unattended may answer the one on screen itself — the narrow
    // kinds only — and a "Do it" typed on its behalf would be words for Codex, not an answer.
    if (this.running instanceof RemoteCodexRunner) return this.running.modeChanged();
    if (this.asksNow?.() !== false || !this.pending.isWaiting) return;

    this.log('agent: mode no longer asks — releasing the step that was waiting');
    // Not typed: it presses "Do it" where there is one, and drops any other question as unanswered, never
    // reading "Do it" as a yes to it — so a mode switch can't set git up (`codexGitSetup.ts`).
    this.pending.supply('Do it', false);
  }

  /** The chat mode the build-on-or-start-fresh question was asked in, while it shows (plan.md M15). */
  private leftWorkAskedIn: string | undefined;

  setStepApproval(on: boolean, live?: () => boolean): void {
    this.stepApproval = on;
    this.asksNow = live;
  }

  /**
   * The last run that ended by asking something, and what it was doing.
   *
   * **Because answering a question should continue the work, not restart it.** A run
   * that stops to ask "preview, or applied straight away?" now puts that in the chat
   * — and the reply is four words that mean nothing on their own. Without this, they
   * arrive as a fresh task with no memory of the question they answer.
   *
   * Cleared once used: the second message after a run is a new request, not more
   * answer, and treating it as context would drag a finished task through the rest
   * of the conversation.
   */
  private unanswered?: { task: string; question: string };

  /**
   * Whether this run is building an approved plan, rather than a one-off job.
   *
   * Only a plan run has a checklist to tick, and only a plan run has earned the
   * pause: stopping to review after "rename this variable" would be ceremony.
   */
  private fromPlan = false;

  /** The steps this run is working through, for the progress display. */
  private steps: string[] = [];

  /** The run in progress, while there is one — Clarvis's own engine, or a Codex task (M15). */
  private running?: CodingRun;

  /**
   * Hands something said mid-run to the agent, rather than answering it separately.
   *
   * **Not a stop.** Stopping and restarting throws away everything read so far, so
   * "no, use the other library" would cost a whole run — and the alternative,
   * answering it in chat while the agent carries on regardless, is worse: the user
   * watches it keep doing the thing they just asked it not to.
   */
  /** Whether a run is under way and can be spoken to — a switch between engines counts (M15 C3). */
  get isRunning(): boolean {
    return this.running !== undefined || this.switcher.isSwitching;
  }

  redirect(text: string): boolean {
    // During a switch, with no run left to take it, the text goes into the checkpoint for the next engine (H8).
    if (!this.running) return this.switcher.noteFeedback(text);
    this.running.interject(text);
    return true;
  }

  /** The run going now, as a switch or a takeover needs it (M15 C3). */
  private current?: CurrentRun;

  /** The step question on screen, by its title, for a switch to record as never answered. */
  private stepTitle?: string;

  private switcherInstance?: ChatEngineSwitch;

  /** Switching engines and taking projects over, in this window (M15 C3). */
  private get switcher(): ChatEngineSwitch {
    this.switcherInstance ??= new ChatEngineSwitch(this.switchHost());
    return this.switcherInstance;
  }

  /** `Clarvis: Switch Coding Engine`: the task running here, or the one that stopped, carried on by the other engine. */
  switchEngine(): Promise<void> {
    const ravis = ravisAccess(this.models);
    return this.switcher.switchEngine(workspaceRoot(), ravis.kind === 'ready' ? ravis.access : undefined);
  }

  private switchHost(): SwitchHost {
    return {
      models: this.models,
      log: this.log,
      note: (text) => this.note(text),
      current: () => this.current,
      // The chat's own Stop for the run — its abort and the step question — without the planning cancel.
      stopRun: () => {
        this.busy.stop();
        this.stopWaiting();
      },
      stepOnScreen: () => this.stepTitle,
      clarvisRunner: (fence, engine, models) => this.clarvisRunner(workspaceRoot(), fence, engine, models),
      codexRunner: (access) => this.codexRunner(workspaceRoot() as string, access.relay, access.locks),
      follow: (start) => this.follow({ runner: start.runner, release: start.release, lock: start.lock, base: start.base, taskId: start.base?.taskId }, start.task, start.events, true),
      setFromPlan: (on, steps) => this.setFromPlan(on, steps),
    };
  }

  /** Told when a run ends on something missing that it never got past. */
  private blockedHandler?: (missing: MissingDependency, proposal: string) => Promise<void>;

  onBlocked(handler: (missing: MissingDependency, proposal: string) => Promise<void>): void {
    this.blockedHandler = handler;
  }

  /** Told when a run from an approved plan begins, and when it has ended (a NERVIS task's stage). */
  private planRunHandler?: (phase: 'building' | 'paused') => Promise<void>;

  onPlanRun(handler: (phase: 'building' | 'paused') => Promise<void>): void {
    this.planRunHandler = handler;
  }

  setFromPlan(on: boolean, steps: string[] = []): void {
    this.fromPlan = on;
    this.steps = steps;
  }

  /** The pending question, folded into a follow-up task. Consumed by reading it. */
  takeUnanswered(): { task: string; question: string } | undefined {
    const pending = this.unanswered;
    this.unanswered = undefined;
    return pending;
  }

  async run(
    task: string,
    because: string,
    /** A task carried on after git was set up for it (`offerGitSetup`): `because` is its opening line as it stands. */
    carriedOn = false,
    /** A skill the owner invoked with a slash command, already read (15 Sep 2026): loaded into a run of Clarvis's own engine. */
    invoked?: InvokedSkill
  ): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const decision = chatRunDecision(currentEngineChoice(this.models));

    // **Before anything else.** Asking "shall I run `git init`?" only after a run has
    // already failed to isolate is a worse offer than asking up front — and it is the
    // reason the offer never fired at all: nothing outside `begin()` ever checked, and
    // `begin()` only runs once a task is already under way.
    // **For Clarvis's own engine only** (plan.md M15, "Codex offers to set git up"). This offer
    // says declining is fine, which isn't true of Codex, and it comes before Workspace Trust and
    // RAVIS have had their say. Codex offers **Set up git here** in the chat once they have.
    if (asksGitOfferBeforeRun(decision)) await offerGitFix(this.context, root, this.log);

    // **Which engine, and what it needs first** (M15 C2a): the project lock for Clarvis's own
    // engine, RAVIS for Codex. Refused here, before the opening line promises work that won't start.
    const opened = await this.openRun(root, task, decision);
    if ('refusal' in opened) return this.refused(opened);

    // **Build on Codex's earlier work, or start fresh** (plan.md M15; the owner's decision of 15 Sep 2026): asked before
    // a Codex task when earlier Codex work was left on its branch, once Workspace Trust, the engine's refusals and
    // Codex's readiness have had their say. Unanswered, stopped or dropped: nothing runs, and nothing was promised yet.
    const where = await this.whereCodexWorks(opened.runner, root);
    if (where.kind === 'nothing') return opened.release();
    // **Build on Clarvis's own earlier work, or start fresh** (plan.md M15; the owner's decision of 15 Sep 2026): the same
    // question for Clarvis's own engine, once its own git offer has been made and its project lock is held. The run is
    // rebuilt on the answer. Unanswered, stopped, dropped or refused: nothing runs, and nothing was promised yet.
    const placed = await this.whereClarvisWorks(opened, root, task);
    if (!placed) return opened.release();
    // On the runner the run actually uses: Build on rebuilds it above.
    if (invoked) this.loadInvoked(placed.runner, invoked);

    // Written for this job rather than the same sentence every time. It is the first
    // thing said in every run, which makes it the most repeated line in the product.
    // A task carried on after git was set up was asked for a moment ago, and says so instead.
    const opening = carriedOn ? because : ((await this.live?.acknowledge(task)) ?? because);

    // Written, not spoken. The user asked for one line of a run to be read aloud, and
    // that line is the result — "right, on it" is not news.
    await this.note(opening);
    this.avatar.setState('thinking', 'chat');

    await this.withPlanStage(() => this.follow(placed, task, (signal) => this.startOrBuildOn(placed.runner, where, task, signal)));
  }

  /** A run, with a NERVIS task's stage told around it when the run builds an approved plan. */
  private async withPlanStage(work: () => Promise<void>): Promise<void> {
    // Read before the run: its ending turns `fromPlan` off.
    const planRun = this.fromPlan;
    if (planRun) await this.planRunHandler?.('building');
    try {
      await work();
    } finally {
      // A finished project has already ended the task, and `paused` then changes nothing.
      if (planRun) await this.planRunHandler?.('paused');
    }
  }

  /**
   * An invoked skill, handed to a run of Clarvis's own engine before it starts. A job for Codex was sent Codex's own mention
   * instead (`ChatService.startJob`), so a Codex runner here means the engine changed in between: logged, and not loaded.
   */
  private loadInvoked(runner: CodingRun, invoked: InvokedSkill): void {
    if (runner instanceof AgentRunner) runner.invokeSkill(invoked);
    else this.log(`skills: ${invoked.skill.id} not loaded — the run went to Codex`);
  }

  /**
   * Where a Codex task goes when Codex left earlier work on its branch: the question, its answer, and the checks around
   * it are `codexLeftWork.ts`'s, `leftWork.ts`'s and `leftTasks.ts`'s. Clarvis's own engine asks its own question
   * (`whereClarvisWorks`); a Codex task without RAVIS was already refused by `openRun`.
   */
  private async whereCodexWorks(runner: CodingRun, root: string | undefined): Promise<CodexWhere> {
    const ravis = ravisAccess(this.models);
    if (!(runner instanceof RemoteCodexRunner) || !root || ravis.kind !== 'ready') return { kind: 'fresh' };
    const relay = ravis.access.relay;
    const folder: string = root;
    const git = new GitFacts(folder);
    try {
      return await whereCodexWorks({
        find: () => findLeftWork({ relay, tokens: new TokenStore(), git, root: folder, rememberedBase: this.context.workspaceState.get<string>(BASE_BRANCH_KEY), log: this.log }),
        unattended: () => codexModeFor(chatModeSetting()) === 'unattended',
        ask: (choices, accepts) => this.askWhere(choices, accepts, 'where Codex should work'),
        note: (line) => this.note(line),
        tree: () => git.workingTree(),
        filesOn: (branch) => git.filesOn(branch),
        log: this.log,
      });
    } finally {
      this.leftWorkAskedIn = undefined;
    }
  }

  /**
   * The build-on-or-start-fresh question on screen, for either engine. Remembered with the chat's mode now, so a mode
   * switch drops it (`modeStoppedAsking`). Only its own buttons and words answer it; anything else typed is the message
   * it is (`ChatService.runTook`).
   */
  private askWhere(choices: { label: string; detail?: string }[], accepts: (typed: string) => string | undefined, about: string): Promise<string | undefined> {
    this.leftWorkAskedIn = chatModeSetting();
    return this.pending.ask(choices, about, true, accepts);
  }

  /**
   * Where a task of Clarvis's own engine goes when a run of that engine left work on its branch. The question and its rules
   * are `clarvisLeftWork.ts`'s and `leftWork.ts`'s; the finding and the save of the earlier run's files are `leftRuns.ts`'s.
   * Asked only for a new task holding the project lock in a git folder: a task carried on from a takeover or a closed
   * window already knows its branch, and Codex asks its own question.
   *
   * With nothing left, the run is today's, untouched. Otherwise it is rebuilt on the answer, and its starting checkpoint
   * is read again after any commit the question made:
   * - **Build on**: on that branch, with the earlier run in the model's instructions;
   * - **Start fresh**: never stacked on a `clarvis/*` branch.
   * Undefined: nothing runs.
   */
  private async whereClarvisWorks(opened: OpenedRun, root: string | undefined, task: string): Promise<OpenedRun | undefined> {
    const gitDir = root ? findGitDir(root) : undefined;
    const lock = opened.lock;
    if (!(opened.runner instanceof AgentRunner) || !root || !gitDir || !lock || opened.continuing) return opened;
    const git = new GitFacts(root);
    let found: LeftWorkFound<LeftRunTask> = { tasks: [] };
    try {
      const where = await whereClarvisWorks({
        find: async () =>
          (found = await findLeftRuns({ git, root, gitDir, rememberedBase: this.context.workspaceState.get<string>(BASE_BRANCH_KEY), stillHolds: () => lock.stillHolds('commit'), log: this.log })),
        unattended: () => chatModeSetting() === 'unattended',
        ask: (choices, accepts) => this.askWhere(choices, accepts, 'where I should work'),
        note: (line) => this.note(line),
        tree: () => git.workingTree(),
        filesOn: (branch) => git.filesOn(branch),
        earlier: earlierRunPort({ git, root, found: () => found.tasks, log: this.log }),
        log: this.log,
      });
      if (where.kind === 'nothing') return undefined;
      return found.tasks.length === 0 ? opened : await this.placedRun(opened, root, task, where, found.startsFrom);
    } finally {
      this.leftWorkAskedIn = undefined;
    }
  }

  /** The run of Clarvis's own engine as the answer places it: built on the left branch, or fresh (plan.md M15). */
  private async placedRun(opened: OpenedRun, root: string, task: string, where: Exclude<ClarvisWhere, { kind: 'nothing' }>, startsFrom: string | undefined): Promise<OpenedRun> {
    // After any commit the question made: what is still uncommitted is the owner's (`leftRuns.placedRunOptions`).
    const { engine, theirs } = await placedRunOptions(new GitFacts(root), where, startsFrom);
    const runner = this.clarvisRunner(root, opened.lock, engine);
    const base = await this.baseCheckpoint(root, opened.taskId ?? randomUUID(), task, theirs);
    return { ...opened, runner, base };
  }

  /** A new task; or, when the owner chose Build on, the request as a new turn on Codex's earlier task, on its branch. */
  private startOrBuildOn(runner: CodingRun, where: CodexWhere, task: string, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (where.kind === 'build_on' && runner instanceof RemoteCodexRunner) return runner.buildOn(where.task, task, signal);
    return runner.run(task, signal);
  }

  /**
   * A run, from its first step to the question of what to do with its work — whichever engine it is,
   * and whether it is a new task or a Codex task picked back up (`picksUp`), which says so itself.
   */
  private async follow(
    opened: OpenedRun,
    task: string,
    events: (signal: AbortSignal) => AsyncIterable<AgentEvent>,
    picksUp = false
  ): Promise<void> {
    // **`'run'`, not `'reply'` — this is the run.** Every one of `Busy.start`'s three
    // call sites passed `'reply'`, so `shared.running` was never set and `isRunning`
    // was dead code. Two suppressions that read it were therefore both off:
    // `WatchPresenter` announced a build outcome during a run that was already
    // reporting it, and a typed "stop" said "Stopped." on top of the run's own ending
    // — the exact double lines the comments at both sites say they exist to prevent.
    const controller = this.busy.start('run');
    const runner = opened.runner;
    // Held for the length of the run, so anything typed while it works has somewhere
    // to go. Cleared in the finally: a redirect handed to a finished run vanishes.
    this.running = runner;
    // M15 C3: what a switch needs of the run, and a promise that says when its loop has returned.
    let loopReturned: () => void = () => undefined;
    const returned = new Promise<void>((resolve) => (loopReturned = resolve));
    this.current = { runner, task, taskId: opened.taskId ?? '', lock: opened.lock, base: opened.base, returned };

    // Held for the whole run, so a build finishing three seconds in cannot wipe the
    // expression of work the user is watching happen (M8e2).
    const holdingFace = this.avatar.claim('agent');
    this.avatar.setState('thinking', 'agent');

    // A single line while it works. Without it the panel sits silent for a minute and
    // the only signal is the avatar — but it is one line, not a running commentary.
    if (!picksUp) await this.note(await this.phrase('report', 'Working on it…'));

    // **Nothing technical reaches the transcript.** Tool calls, commands and the
    // model's own working-out all go to the Clarvis terminal, where a build log
    // belongs. The chat gets what a person would say: the result, and an aside.
    this.terminal.announce(`clarvis: ${task}`);

    // What the run ended up saying, which is the only part the chat gets.
    let summary = '';
    // Where it left them — kept apart from the summary, because a note about branches
    // is not the run having said something.
    let closing = '';
    // **Every step, kept — the run summary and "why did you do that" both need it.**
    // Everything else here is ephemeral: the terminal scrolls, the panel resets. This
    // is the one copy that survives the run finishing, built from the same events as
    // the display rather than a second pass over anything.
    const ledgerEvents: LedgerEvent[] = [];
    const startedAt = Date.now();

    // **Set last, read in the `finally`.** The loop below leaves by three routes —
    // finishing, throwing, and being aborted — and from inside a `finally` they are
    // indistinguishable. This is the one bit of state that tells them apart, and it
    // exists so the reported activity state does not call every ended run a success.
    let ended: 'ok' | 'failed' = 'failed';
    try {
      for await (const event of events(controller.signal)) {
        // A passing state (M15 C2b+), such as "Reconnecting Codex…": shown under the chat until replaced or cleared,
        // and never written to the terminal, the transcript or the run's record.
        if (event.kind === 'status') {
          this.showProgress({ status: event.text });
          continue;
        }
        if (!event.text) continue;
        if (event.kind === 'done') {
          // **Same stripping the terminal stream already gets, applied to the summary
          // too.** Observed live on a weak local model: the closing narration quoted
          // its own `STEP:` instructions back verbatim instead of summarising, and
          // that text became a permanent chat turn — spoken aloud in full and resent
          // to the model as history on every later question, which is what made an
          // unrelated conversation keep reopening the finished task (F22).
          summary = readStepMarkers(event.text.trim()).text.trim();
          closing = event.closing ?? '';
        }

        // Step announcements are for the panel, not for reading: pulled out here so
        // they never reach the terminal as stray "STEP:" lines. An event that was
        // nothing but an announcement has nothing left to show.
        const text = this.takeStepMarkers(event);
        if (text === undefined) continue;

        ledgerEvents.push({ kind: event.kind, text, detail: event.detail, step: event.step });

        // Everything, verbatim, in the place that is meant to be read line by line.
        this.terminal.write(
          event.kind === 'tool' ? `\r\n· ${event.detail ?? event.text}\r\n` : text
        );

        // The one exception to "nothing technical reaches the chat": isolation could
        // not be set up, and the reason — a folder that is not a repository, git
        // missing, the extension disabled — is not machine noise, it is the thing the
        // user needs told. This was going to the terminal alone and nowhere else, so a
        // non-repo folder produced no message and no offer at all.
        if (event.toChat) await this.note(event.text);
      }
      ended = 'ok';
    } finally {
      this.busy.finish(ended);
      this.running = undefined;
      this.current = undefined;
      loopReturned();
      this.avatar.setState('neutral', 'agent');
      holdingFace();
      // A bar left at "step 3 of 5" after the run ends describes a run that is no
      // longer happening. Cleared here rather than on success, so a stopped or
      // failed run clears it too.
      this.showProgress({ current: 0, total: 0, label: '' });
      this.showProgress({ status: '' });
      // Only now, with the run's loop over and its commands with it (design §6.3: release after).
      await this.endRun(runner, opened, summary);
    }

    // **Persisted whether or not anything changed.** A run that did nothing is exactly
    // the run someone asks "why didn't you" about — the record that answers that has
    // to exist even when `files` is empty.
    const record = buildRunRecord(task, startedAt, ledgerEvents);
    await this.context.workspaceState.update(LAST_RUN_KEY, record);

    // A run stopped for a switch hands its work, and anything typed to it, to the switch: no offers here.
    if (this.switcher.isSwitching) return;

    await this.wrapUp(runner, task, summary, closing);
    await this.afterRun(runner, task);
  }

  /** Which engine runs this, and what it needs first; or why nothing runs (M15 C2a; design §5.1, §5.8). */
  private async openRun(root: string | undefined, task: string, decision: SiteDecision): Promise<OpenedRun | RunRefusal> {
    if (decision.run === 'refused') return { refusal: decision.line };
    const guard = await this.guardFor(decision.run, root, task);
    if ('refusal' in guard) return guard;
    const runner = createCodingRun(decision.run, {
      clarvis: () => this.clarvisRunner(root, guard.fence, guard.engine),
      codex: () => this.codexRunner(root as string, guard.relay as RelayClient, guard.locks),
    });
    return { runner, release: guard.release, lock: guard.lock, taskId: guard.taskId, base: guard.base, continuing: guard.engine?.continueOn !== undefined };
  }

  /**
   * What a run needs before it is built. **Clarvis's own engine takes the project lock** — a behaviour
   * change: two editors no longer build in one project at once — and hands the run its fence. Codex needs
   * RAVIS; its lock is RAVIS's, taken when the session is created.
   */
  private async guardFor(engine: EngineKind, root: string | undefined, task: string): Promise<RunGuard | RunRefusal> {
    if (engine === 'codex') return codexGuard(root, ravisAccess(this.models));
    const lock = await takeRunLock(this.models, randomUUID(), this.log, () => this.pending.isWaiting);
    // M15 C3: another window holds the project but isn't answering, or waits on its owner there — asked, then taken over.
    if (lock && !lock.held && lock.takeover && root) return this.takenOver(root, lock.takeover, task);
    if (lock && !lock.held) return { refusal: lock.line, attachSessionId: lock.attachSessionId };
    if (!lock?.held || !root) return { release: async () => undefined };
    // A gone window's file was replaced: its task is carried on, on its branch, rather than a new one beside it (AL3).
    const taskId = lock.replaced?.taskId ?? lock.lock.lockFile;
    const engineOptions = lock.replaced ? await this.inherited(root, lock.replaced.taskId, 'Work a closed Clarvis window left on its task') : undefined;
    return this.clarvisGuard(root, lock.lock, lock.replaced ? taskId : randomUUID(), task, engineOptions);
  }

  /** The takeover the owner confirmed, as the guard of a run that continues the taken-over task. */
  private async takenOver(root: string, offer: TakeoverOffer, task: string): Promise<RunGuard | RunRefusal> {
    const ravis = ravisAccess(this.models);
    const taken = await this.switcher.takeOver(root, offer, ravis.kind === 'ready' ? ravis.access : undefined);
    if ('refusal' in taken) return taken;
    return this.clarvisGuard(root, taken.lock, taken.taskId, task, taken.engine);
  }

  private async inherited(root: string, taskId: string, leftoversMessage: string): Promise<AgentEngineOptions | undefined> {
    const continueOn = await this.switcher.continuationOf(root, findGitDir(root), taskId, leftoversMessage);
    return continueOn ? { continueOn } : undefined;
  }

  private async clarvisGuard(root: string, lock: ProjectLock, taskId: string, task: string, engine: AgentEngineOptions | undefined): Promise<RunGuard> {
    const base = await this.baseCheckpoint(root, taskId, task, engine?.continueOn?.theirs);
    return { fence: lock, lock, taskId, base, engine, release: async () => void (await lock.release()) };
  }

  /** The task's checkpoint as a run of Clarvis's own engine starts it: its brief, plan, base commit and the owner's files in flight. */
  private async baseCheckpoint(root: string, taskId: string, task: string, theirs: string[] | undefined): Promise<TaskCheckpoint> {
    const facts = new GitFacts(root);
    const head = await facts.head();
    const dirty = theirs ?? (await facts.dirty());
    return newCheckpoint({
      taskId,
      workspaceRoot: root,
      host: windowIdentity().host,
      engine: 'clarvis',
      task,
      now: new Date(),
      plan: { fromPlan: this.fromPlan, steps: this.steps, uncheckedSteps: this.steps },
      git: { baseBranch: head.branch, baseCommit: head.commit, dirty },
      previousModel: this.models.model('agent'),
    });
  }

  /**
   * A run's loop is over: the task's checkpoint is written while the lock is still held, so the other engine can
   * carry it on (M15 C3), then the lock is let go. During a switch the checkpoint is the switch's to write, and the
   * lock too: `release` answers `held_for_transfer` (review N2).
   */
  private async endRun(runner: CodingRun, opened: OpenedRun, summary: string): Promise<void> {
    if (opened.lock && opened.base && !this.switcher.isSwitching) {
      await this.saveRunEnd(runner, opened.lock, opened.base);
      await this.recordLeftRun(runner, opened.lock, opened.base, summary);
    }
    await opened.release();
  }

  /**
   * A run of Clarvis's own engine ended on its own branch: written into the record of left work while its lock is still
   * held, so the next task can be asked whether to build on it (plan.md M15, "Build on Clarvis's own earlier work"). A run
   * stopped for a switch isn't, since its task moved to the other engine (`endRun`).
   */
  private async recordLeftRun(runner: CodingRun, lock: ProjectLock, base: TaskCheckpoint, summary: string): Promise<void> {
    const branch = runner.branches.working;
    const gitDir = findGitDir(base.workspaceRoot);
    if (!(runner instanceof AgentRunner) || !branch || !isAgentBranch(branch) || !gitDir) return;
    const written = await rememberLeftRun(
      { git: new GitFacts(base.workspaceRoot), root: base.workspaceRoot, gitDir, stillHolds: () => lock.stillHolds('commit') },
      { branch, taskId: base.taskId, task: base.task, summary, startedFrom: runner.branches.startedFrom, files: runner.result.files, inFlightAtStart: base.git.dirty, host: windowIdentity().host, now: new Date() }
    );
    if (written !== 'saved') this.log(`agent: the run left on ${branch} wasn't recorded (${written})`);
  }

  /** The task's checkpoint when a run of Clarvis's own engine ends, written while its lock is still held (M15 C3). */
  private async saveRunEnd(runner: CodingRun, lock: ProjectLock, base: TaskCheckpoint): Promise<void> {
    const facts = new GitFacts(base.workspaceRoot);
    const head = await facts.head();
    const branch = runner.branches.working;
    if (!head.commit || !branch) return;
    const agent = runner instanceof AgentRunner ? runner : undefined;
    const diffStat = base.git.baseCommit ? await facts.diffStat(base.git.baseCommit, head.commit) : [];
    const context = { workspaceRoot: base.workspaceRoot, host: windowIdentity().host, now: new Date() };
    const stopped = { branch, headCommit: head.commit, changedFiles: runner.result.files, diffStat, dirty: base.git.dirty, checks: agent?.checksRun ?? [], typed: [], interrupted: agent?.interruptedOperation, lockId: lock.ravisLockId };
    const checkpoint = { ...checkpointFromClarvis(base, stopped, context), status: runner.blocked ? ('interrupted' as const) : ('settled' as const) };
    const written = await writeCheckpoint(base.workspaceRoot, findGitDir(base.workspaceRoot), checkpoint, () => lock.stillHolds('commit'));
    if (written.kind !== 'saved') this.log(`agent: the task's checkpoint wasn't written (${written.kind})`);
  }

  private clarvisRunner(root: string | undefined, fence: RunFence | undefined, engine: AgentEngineOptions = {}, models: ModelService = this.models): AgentRunner {
    return new AgentRunner(
      this.context,
      root,
      models,
      this.terminal,
      this.log,
      // **Always handed over, decided per step.** Passing `undefined` here for a run
      // that started in Unattended would freeze that choice for the whole run, which
      // is the bug this replaced — `askStep` answers immediately when the mode says
      // not to ask, so the decision is made at the step rather than at the start.
      (step) => this.askStep(step),
      // So a modal sitting open mid-run reads as `waiting_for_approval` rather than
      // as a run that has silently stopped making progress.
      this.busy.reported,
      // The project lock this run holds: a run another window took over writes nothing more.
      fence,
      // M15 C3: a task carried on from another engine, or inherited from another window, continues on its branch.
      engine,
      // The owner's skills, when the coding model goes through RAVIS: read at the run's start (plan.md §4.6, "Skills").
      () => runSkillsLookup(models)
    );
  }

  private codexRunner(root: string, relay: RelayClient, locks?: LockClient): RemoteCodexRunner {
    return new RemoteCodexRunner({
      context: this.context,
      root,
      relay,
      locks,
      terminal: this.terminal,
      log: this.log,
      mode: codexModeFor(chatModeSetting()),
      modeNow: () => codexModeFor(chatModeSetting()),
      maxSteps: maxStepsSetting(),
      ask: (prompt, signal, again) => this.askCodex(prompt, signal, again),
      codexChoice: storedCodexChoice,
    });
  }

  /**
   * One of Codex's requests in the chat (M15 C2b; design §5.2): its line and detail written, never spoken — a task
   * can ask a dozen of these, as a run of Clarvis's own engine can — and RAVIS's choices as buttons. Typing still
   * works: `approvals.ts` takes typed words as a question's answer, or passes them to Codex and asks again. The
   * buttons go the moment the request no longer wants an answer — a Stop, another window answering, the policy.
   */
  private async askCodex(prompt: RequestPrompt, signal: AbortSignal, again: boolean): Promise<string | undefined> {
    if (signal.aborted) return undefined;
    if (!again) await this.note([prompt.line, ...prompt.detail].join('\n'));
    if (signal.aborted) return undefined;
    let settled = false;
    // Only while it is still this question waiting: once answered, the panel may already hold the next one.
    const letGo = () => {
      if (!settled) this.pending.cancel();
    };
    signal.addEventListener('abort', letGo, { once: true });
    try {
      return await this.pending.ask(prompt.options.map(({ label, detail }) => ({ label, detail })), prompt.about);
    } finally {
      settled = true;
      signal.removeEventListener('abort', letGo);
    }
  }

  /** A run that didn't start: why — and the Codex task to follow, when one holds the project. */
  private async refused(refusal: RunRefusal): Promise<void> {
    await this.note(refusal.refusal);
    if (refusal.attachSessionId) await this.reattachCodexTasks();
  }

  /**
   * Nothing typed to a run vanishes; a Codex start refused for a task already running follows it; a Codex
   * task RAVIS stopped at its step cap is offered "Carry on"; and a Codex task refused for want of git alone
   * is offered "Set up git here".
   */
  private async afterRun(runner: CodingRun, task: string): Promise<void> {
    const undelivered = undeliveredLine(runner.drainInterjections());
    if (undelivered) await this.note(undelivered);
    if (runner instanceof RemoteCodexRunner && runner.attachInstead) await this.reattachCodexTasks();
    if (runner instanceof RemoteCodexRunner && runner.endedAtStepCap) await this.offerCarryOn(runner);
    if (runner instanceof RemoteCodexRunner && runner.needsGitSetup) await this.offerGitSetup(task);
  }

  /**
   * Codex refused the task because the folder has no git, in a folder RAVIS would otherwise take: **Set up git
   * here**, in the chat, even after Clarvis's own offer was declined (plan.md M15, "Codex offers to set git up";
   * the owner's decision of 14 Sep 2026). The rules are `codexGitSetup.ts`'s.
   *
   * A typed answer ("git init", "set it up", "yes") reaches it the way every question here is answered:
   * `ChatService.runTook` hands the message to `answerStep` before anything else could send it to Codex as a
   * task. Anything else typed is the message it is, and the offer goes away.
   */
  private async offerGitSetup(task: string): Promise<void> {
    const root = workspaceRoot();
    if (!root) return;
    await offerCodexGitSetup({
      ask: () => this.pending.ask(gitSetupChoices(), 'setting git up for Codex', true, gitSetupChoice),
      note: (line) => this.note(line),
      setUp: () => setUpGitHere(root, this.log),
      memory: this.context.workspaceState,
      // Carried on, not restarted by hand: every check a task meets runs again, and the owner types nothing.
      carryOn: () => this.run(task, CODEX_GIT_LINES.carryingOn, true),
      log: this.log,
    });
  }

  /**
   * "Carry on" after Codex's step cap continues the same session with a `carry_on` turn (design §5.5, M15 C2a),
   * never a new task on a new branch. Only its own buttons answer it, so typing "carry on" works and anything
   * else is read as the message it is.
   */
  private async offerCarryOn(ended: RemoteCodexRunner): Promise<void> {
    const session = ended.codexSession;
    const root = workspaceRoot();
    const ravis = ravisAccess(this.models);
    if (!session || !root || ravis.kind !== 'ready') return;
    await this.note(CODEX_LINES.carryOnOffer);
    const answer = await this.pending.ask(
      [{ label: 'Carry on', detail: 'Codex continues the same task where it stopped' }, { label: 'Not now' }],
      'carrying on with the Codex task',
      true
    );
    if (answer !== 'Carry on') return;
    const runner = this.codexRunner(root, ravis.access.relay, ravis.access.locks);
    const opened = { runner, release: async () => undefined };
    await this.follow(opened, 'the Codex task in this project', (signal) => runner.carryOn(session.id, 'Carry on where you stopped.', signal), true);
  }

  /**
   * On window load: follows this workspace's live Codex task, if there is one (M15 C2a; design §5.7). A task
   * outlives the editor that started it, so the next window to open the project picks it up — asks its
   * waiting question, saves its finished work.
   */
  async reattachCodexTasks(): Promise<void> {
    const root = workspaceRoot();
    if (!root || this.running) return;
    const ravis = ravisAccess(this.models);
    if (ravis.kind !== 'ready') return this.noCodexAccess(ravis);
    const listed = await ravis.access.relay.listSessions(root);
    if (!listed.ok) return this.listFailed(listed.failure.kind);
    await this.followListed(root, ravis.access, listed.value);
  }

  /** The chat panel pinged: a Codex task followed from here counts this window attached (design §3.5.4). */
  panelPinged(): void {
    if (this.running instanceof RemoteCodexRunner) this.running.panelPinged();
  }

  /** A Codex task is running in this window: the bowtie's Codex section says a change applies to the next task (M15 C2b+). */
  get codexTaskRunning(): boolean {
    return this.running instanceof RemoteCodexRunner;
  }

  private async followListed(root: string, access: RavisAccess, sessions: SessionSummary[]): Promise<void> {
    const tokens = new TokenStore();
    await this.takeReattachStep(reattachStep(sessions, (sessionId) => tokens.read(root, sessionId)), root, access);
  }

  private async takeReattachStep(step: ReattachStep, root: string, access: RavisAccess): Promise<void> {
    if (step.kind === 'nothing') return;
    if (step.kind === 'unsafe_token') return this.note(tokenLine({ kind: 'refused', reason: step.reason }));
    // With RAVIS's lock API, so a task a closed editor left paused can be taken over and saved (F-A9).
    const runner = this.codexRunner(root, access.relay, access.locks);
    if (step.kind === 'reconnect' && !(await this.reconnected(runner, step.session))) return;
    // A task picked back up has no plan steps in this window: its checkpoint will carry them (C3).
    this.setFromPlan(false);
    this.log(`codex: following session ${step.session.id} (${step.session.state})`);
    const opened = { runner, release: async () => undefined };
    await this.follow(opened, 'the Codex task in this project', (signal) => runner.attach(step.session, signal), true);
  }

  /** A task whose token this editor lost: offered, never forced (design §5.7 step 3). */
  private async reconnected(runner: RemoteCodexRunner, session: SessionSummary): Promise<boolean> {
    await this.note(CODEX_LINES.tokenMissing);
    const answer = await this.pending.ask(
      [{ label: 'Reconnect', detail: 'Asks RAVIS for a new key to this task' }, { label: 'Not now' }],
      'reconnecting to the Codex task',
      true
    );
    if (answer !== 'Reconnect') return false;
    const refusal = await runner.reissue(session);
    if (refusal) await this.note(refusal);
    return refusal === undefined;
  }

  private noCodexAccessSaid = false;

  /** Said once per window: an editor that uses RAVIS but has no key for it can't see Codex tasks. */
  private async noCodexAccess(ravis: Exclude<RavisLookup, { kind: 'ready' }>): Promise<void> {
    if (ravis.kind !== 'no_credential' || this.noCodexAccessSaid) return;
    this.noCodexAccessSaid = true;
    await this.note(CODEX_LINES.noCredential);
  }

  private reattachRetry: NodeJS.Timeout | undefined;

  /** RAVIS not answering: said once, and looked at again every 30 s until it answers (design §5.7 step 2). */
  private async listFailed(kind: string): Promise<void> {
    this.log(`codex: couldn't list this project's Codex tasks (${kind})`);
    if (kind !== 'unreachable' || this.reattachRetry) return;
    await this.note(CODEX_LINES.tasksUnreachable);
    this.reattachRetry = setInterval(() => void this.retryReattach(), 30_000);
    this.reattachRetry.unref();
  }

  private async retryReattach(): Promise<void> {
    const root = workspaceRoot();
    const ravis = ravisAccess(this.models);
    if (!root || ravis.kind !== 'ready' || this.running) return;
    const listed = await ravis.access.relay.listSessions(root);
    if (!listed.ok) return;
    clearInterval(this.reattachRetry);
    this.reattachRetry = undefined;
    await this.followListed(root, ravis.access, listed.value);
  }

  /**
   * What follows a run: its closing words, where the work goes, a review of it, and what
   * next when it could not get past something missing.
   */
  private async wrapUp(runner: CodingRun, task: string, summary: string, closing: string): Promise<void> {
    const { commits, files } = runner.result;

    // **A blocked run is not a finished milestone.** It ended on a missing dependency the
    // person has just been asked about, so there is nothing to mark off, land or review
    // yet — offering to would invite ticking work whose checks never ran.
    const changed = runner.blocked ? 0 : files.length;
    const { askedWhereItGoes } = await this.close(task, summary, changed, closing, runner);

    await vscode.commands.executeCommand('clarvis.checkBranchFlow');

    // **Asked once, not twice.** Found live, 13 September 2026: "Leave it there" was answered,
    // and a moment later this offered "Keep it" — a merge — for the same work, from a run that
    // had stopped at its step limit. Where the work goes is settled by the question above
    // whenever it was asked; this is only for runs that question does not cover.
    if (changed > 0 && !askedWhereItGoes) await this.offerReview(commits, files);

    // **And what next, when it could not get past something missing.** Without this the
    // run simply ended, and "continue building" walked into the same wall again.
    const missing = runner.stillMissing;
    if (missing) await this.afterMissing(missing, summary);
  }

  /** Keeps what the run proposed beside what was missing, then hands both to the offer. */
  private async afterMissing(missing: MissingDependency, proposal: string): Promise<void> {
    const record = activeBlocker(this.context.workspaceState.get(BLOCKER_KEY), Date.now());
    if (record?.name === missing.name && proposal.trim()) {
      await this.context.workspaceState.update(BLOCKER_KEY, { ...record, proposal });
    }
    this.log(`agent: run ended with ${missing.name} still missing — offering what next`);
    await this.blockedHandler?.(missing, proposal);
  }

  /**
   * The event's text with any step announcement removed, or `undefined` when the
   * announcement was all there was.
   */
  private takeStepMarkers(event: { kind: string; text: string }): string | undefined {
    if (event.kind !== 'text' || this.steps.length === 0) return event.text;

    const progress = readStepMarkers(event.text);
    for (const announced of progress.announced) this.showStep(announced);
    return progress.text.trim() ? progress.text : undefined;
  }

  /**
   * Moves the progress display to the step just announced.
   *
   * An announcement matching no planned step is ignored rather than counted: the bar
   * holding still is a smaller lie than the bar pointing at the wrong step.
   */
  private showStep(announced: string): void {
    const index = matchStep(announced, this.steps);
    if (index === undefined) {
      this.log(`agent: announced a step that matches none in the plan — "${announced}"`);
      return;
    }

    this.log(`agent: step ${index + 1} of ${this.steps.length} — ${this.steps[index]}`);
    this.showProgress({ current: index + 1, total: this.steps.length, label: this.steps[index] });
  }

  /**
   * Whether this workspace has a `plan.md` at all.
   *
   * Read at the moment it matters rather than remembered from the start of the run: the
   * plan can arrive or leave while an agent works, and a stale answer here is a wrong
   * question put to the user.
   */
  private static async planExists(): Promise<boolean> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return false;
    return vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, 'plan.md')).then(
      () => true,
      () => false
    );
  }

  /**
   * The moment after a milestone: what changed, and whether to write it down.
   *
   * Offered rather than done silently. The plan is the user's document, and a tool
   * that edits it on its own behalf — recording its own work as complete, on its own
   * say-so — is exactly the thing sign-off exists to prevent.
   */
  private async settleMilestone(summary: string, changed: number, ending: 'finished' | 'step-cap'): Promise<void> {
    // A run that used every step it had did not finish its milestone, whatever it changed
    // on the way — so it is not offered as one (see `stepCapOffer`). A run handed over from
    // `NO-PLAN-NEEDED` has no plan to record against, and offering to update one anyway is
    // a button that could only do nothing.
    const { message, detail, actions } =
      ending === 'step-cap'
        ? stepCapOffer(summary, changed)
        : (await RunSession.planExists())
          ? plannedMilestoneOffer(summary, changed)
          : unplannedRunOffer(summary, changed);

    const answer = await vscode.window.showInformationMessage(message, { modal: true, detail }, ...actions);

    if (answer !== 'Update the plan') {
      this.log(ending === 'step-cap' ? 'agent: stopped at the step limit, plan left untouched' : 'agent: milestone finished, plan left untouched');
      return;
    }

    // Recording it also reports what is left, which is what makes the next milestone
    // a decision rather than a thing you have to remember to go and look for.
    await vscode.commands.executeCommand('clarvis.recordMilestone', summary);

    // **And then he reads his own code back.** The plan gets analysed before a line is
    // written; nothing looked at what was written afterwards, so a milestone was
    // finished on the strength of its own checks passing. Found by reading a finished
    // project by hand: "Chance of rain: 0%", always, past five checks that asked only
    // whether output appeared.
    await this.readBackWhatIWrote(summary);
  }

  /**
   * Offers to put the run's work where it belongs, once the run is over.
   *
   * **Only when there is something to land** — a run that committed nothing has no
   * branch worth discussing, and asking anyway is the nagging §6 exists to prevent.
   *
   * Merging is first and named, because it is what someone means by "that's fine, keep
   * it": the work ends up on the branch they were on, and the *next* run starts from
   * there rather than stacking on this one.
   */
  private async offerToLandTheWork(changed: number, branch?: string, home?: string): Promise<boolean> {
    if (changed === 0 || !branch || !home || branch === home) return false;

    this.log(`review: offering to land ${branch} on ${home}`);
    await this.note(
      await this.phrase(
        'ask',
        `That work is on \`${branch}\`. Shall I fold it into \`${home}\` and put you back there?`,
        [branch, home]
      )
    );

    const answer = await this.pending.ask(
      [
        { label: `Merge into ${home}`, detail: 'Puts the work, and you, back where you were' },
        { label: 'Show me what changed', detail: 'Opens the diff. Nothing moves.' },
        { label: 'Leave it there', detail: `Stays on \`${branch}\` — decide later` },
      ],
      `where ${branch} should go`,
      // **Only its own buttons answer it.** Found live, 11 September 2026: "that last
      // command failed", typed while this waited, came back as the answer, and anything
      // that was not "Show me what changed" merged. A reply that is not one of these
      // three now leaves the work where it is and goes on to be read as a message.
      true
    );

    if (!answer || answer === 'Leave it there') {
      this.log(`review: ${branch} left where it is`);
      return true;
    }

    await vscode.commands.executeCommand(
      'clarvis.reviewRun',
      answer === 'Show me what changed' ? 'diff' : 'merge-origin'
    );
    return true;
  }
  /**
   * Reviews the milestone's own diff, and offers what to do about it.
   *
   * Offered, never applied — rule 3 holds at the end of a build exactly as it does at
   * the start of one. Writing the findings into the plan is the option worth having:
   * they become a milestone like any other, with steps and checks, rather than a list
   * in a transcript that scrolls away.
   */
  private async readBackWhatIWrote(summary: string): Promise<void> {
    const findings = await reviewMilestone(this.models, summary, this.log);
    if (findings.length === 0) return;

    await this.note(reviewSummary(findings));
    await this.note(findings.map((finding) => `- **[${finding.class}]** ${finding.what}`).join('\n'));

    this.reviewFindings = findings;
    this.offer([
      { label: 'Fix them now', detail: 'A run that does nothing else, before the next milestone' },
      { label: 'Add to the plan', detail: 'A milestone of their own, to build when you choose' },
      { label: 'Leave them', detail: 'Recorded in the log and nowhere else' },
    ]);
  }

  /** Findings waiting on an answer about what to do with them. Read once. */
  private reviewFindings?: Finding[];

  get hasReviewFindings(): boolean {
    return this.reviewFindings !== undefined;
  }

  takeReviewFindings(): Finding[] | undefined {
    const findings = this.reviewFindings;
    this.reviewFindings = undefined;
    return findings;
  }

  /**
   * Describes one step and waits for a yes.
   *
   * Modal, and deliberately: the run is stopped until it is answered, and a toast
   * that timed out would either strand the run or, worse, be treated as consent.
   * "Skip this step" rather than "No", because the run continues either way — the
   * model is told what was declined and asked to find another route.
   */
  private async askStep(step: StepExplanation): Promise<boolean> {
    // Switching to Unattended mid-run means the *next* step stops asking, not the
    // next run. Falls back to the flag the run started with when nothing live was
    // supplied — the command-palette path has no mode button to read.
    if (!(this.asksNow?.() ?? this.stepApproval)) return true;

    // Written, never spoken. The step title is short and the question is solicited,
    // but a run has a dozen of these in it and hearing each one read aloud is how a
    // voice gets switched off (§4.4's rationing, applied to the surface that would
    // break it fastest).
    await this.note([step.title, '', step.what, ...(step.exact ? ['', step.exact] : [])].join('\n'));

    // M15 C3: a switch records the question on screen as never answered, by its title.
    this.stepTitle = step.title;
    const answer = await this.pending.ask(
      [{ label: 'Do it' }, { label: 'Skip this step' }],
      // What the nudge will be about, if it comes to that. The step title rather than
      // the whole explanation: this gets spoken aloud, and a paragraph read out to
      // someone who has walked away is not a reminder, it is a monologue.
      step.title
    );

    this.stepTitle = undefined;
    // No answer means the run was stopped or the panel went away — not consent.
    return answer === 'Do it';
  }

  /**
   * The result, and then the exhale.
   *
   * **Both of these were lost and neither was noticed.** The closing line — where the
   * run left you, and that your own branch is untouched — went to the terminal only,
   * while the comment above this loop claimed the chat got it. The aside disappeared in
   * the commit that stripped machine talk from the transcript: it depended on a variable
   * that rework removed, so a feature asked for two messages earlier went with it.
   *
   * They stay separate, which is the point of having both. The summary is information
   * and has to be trustworthy; the aside is comic relief after it. A summary trying to
   * be funny is a summary nobody can rely on.
   */
  private async close(
    task: string,
    summary: string,
    changed: number,
    closing = '',
    /** Where the work is, and whether the run finished or used every step it had. */
    run?: Pick<CodingRun, 'branches' | 'endedAtStepCap'>
  ): Promise<{ askedWhereItGoes: boolean }> {
    // **A run that changed nothing still ends.** There is no closing line in that case —
    // "your own work is untouched" is meaningless when nothing was touched at all — so
    // the chat went quiet after "Working on it…" and stayed that way. Silence is how a
    // crash looks, and this is the shape of a run that was refused, or that read a file
    // and correctly declined to act on it.
    // **"Nothing needed changing" was a claim, and it was false.** Found live: the
    // model stopped after reading two files and returned no summary at all, and this
    // line reported it as a finding — rewritten in his voice into "The code was
    // already doing what you wanted", about a project whose only file the user had
    // just deleted. A run that ends with nothing to say has established that *he
    // did nothing*, not that nothing needed doing, and the difference is the whole
    // of §2.2's no-invented-facts rule.
    const said =
      summary ||
      (changed === 0
        ? await this.phrase('report', 'I stopped without changing anything, and without saying why. Ask me again if that was not what you wanted.')
        : '');
    if (!said && !closing) return { askedWhereItGoes: false };

    // The branch note goes after whatever was said, and never instead of it. Joined
    // upstream it counted as a summary, so a run that narrated nothing looked like a
    // run that had reported — and the honest line above never fired.
    await this.note([said, closing].filter(Boolean).join('\n\n'));

    // **Where the work should live, asked once, at the end.** The review wizard has
    // always had merge, return and discard — behind a command nobody runs, so every
    // run left the user on its temp branch and the next one branched off *that*. Found
    // live: eight `clarvis/*` branches stacked in a straight line, each announcing "I
    // couldn't start cleanly from where you were", and a request to merge to main that
    // created a branch called `clarvis/merge-to-main`.
    const askedWhereItGoes = await this.offerToLandTheWork(changed, run?.branches.working, run?.branches.startedFrom);

    // A run that ended on a question is waiting for an answer, and the next message
    // is almost certainly it.
    this.unanswered = said.includes('?') ? { task, question: said } : undefined;

    // **The pause after a milestone.** §0 says the plan becomes a live checklist in
    // Code Mode, ticked as each step lands — which had never been implemented, so a
    // plan approved on Monday still read as entirely unbuilt on Friday. A run that
    // came from a plan stops here, shows what it changed, and offers to write that
    // back before anything else happens.
    if (this.fromPlan && changed > 0) await this.settleMilestone(said, changed, run?.endedAtStepCap ? 'step-cap' : 'finished');

    await this.sayAside(task, said);
    return { askedWhereItGoes };
  }

  /**
   * The aside after a run — comic relief once the summary has landed.
   *
   * **Stripped like the summary is.** Found live, 13 September 2026: the aside after a build
   * came back as "STEP: Implement a basic login form with username and password fields." — a
   * step announcement, not a remark — and reached the chat as its own line.
   */
  private async sayAside(task: string, said: string): Promise<void> {
    const aside = (await this.live?.afterTask(task, said)) ?? this.closers.pick('taskDone')?.text;
    const shown = aside && readStepMarkers(aside).text.trim();
    if (shown) await this.note(shown);
  }

  /**
   * The close of a run: what changed, what the options are, and the user chooses.
   *
   * Offered rather than forced — a modal after every run would be its own nuisance —
   * and only when something changed, because a run that touched nothing has nothing to
   * merge, keep or throw away and offering anyway is a dialog about an absence.
   */
  private async offerReview(commits: string[], files: string[]): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // The close of a run is a decision, not an announcement: what changed, what the
    // options are, and the user chooses. Offered rather than forced — a modal after
    // every run would be its own nuisance.
    // Only when there is something to review. A run that changed nothing has nothing
    // to merge, keep or throw away, and offering anyway is a dialog about an absence.
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
}
