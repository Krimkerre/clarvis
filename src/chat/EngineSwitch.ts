/**
 * `Clarvis: Switch Coding Engine`, and taking a project over from another window, in the chat
 * (plan.md M15, C3; design §6.2, §6.3).
 *
 * **Glue.** Every rule — the order of a switch, the lock held through it, branch continuation, what the checkpoint
 * carries, the takeover's checks — lives in `src/engine/` and is tested there against the fake RAVIS. This file only
 * finds the pieces in this window (the run going now, RAVIS, the git folder), asks the owner, and follows the run
 * that carries the task on the way the chat follows any run.
 *
 * **Three cases:**
 * - **a task running now** is switched with the full lifecycle (`EngineSwitch`): the lock reserved for the other
 *   engine, the run stopped and confirmed gone, its work saved and checkpointed, then the other engine started;
 * - **a task that stopped** is carried on from its checkpoint: the other engine takes the free project lock as any
 *   run does, on the task's branch at the saved commit, with the checkpoint in its brief;
 * - **a takeover**: when another window holds the project but isn't answering, or waits on its owner there, the owner
 *   is asked, naming the window and how long it has been quiet; a yes takes it over (`takeover.ts`) and the run
 *   continues that window's task on its branch, committing what it left first (review AL3).
 *
 * **Clarvis's own engine after Codex runs on the chat model.** The coding model setting still names Codex, which
 * Clarvis's own engine can't call; the chat model can never be Codex. The confirmation names that model, so the
 * owner knows what the API spend is on.
 *
 * Confirmations are modal dialogs, not the chat's question buttons: a step question may be on screen, and replacing
 * it would answer it.
 */

import * as vscode from 'vscode';
import { AgentRunner, type AgentEngineOptions, type AgentEvent } from '../agent/AgentRunner';
import { isAgentBranch, type BranchContinuation } from '../agent/branchNames';
import type { CodingRun } from '../engine/CodingRun';
import { renderCheckpoint } from '../engine/checkpoint/checkpointBrief';
import { readCheckpoint, writeCheckpoint } from '../engine/checkpoint/checkpointFile';
import { GitFacts } from '../engine/checkpoint/gitFacts';
import { withFeedbackDelivered, type TaskCheckpoint } from '../engine/checkpoint/taskCheckpoint';
import { RemoteCodexRunner } from '../engine/codex/RemoteCodexRunner';
import type { SwitchResult } from '../engine/codex/runCore';
import { CODEX_LINES } from '../engine/codex/translate';
import { CODEX_MODEL_ID } from '../engine/engineChoice';
import { windowIdentity, type RavisAccess } from '../engine/engineHost';
import { findGitDir } from '../engine/lock/gitDir';
import { ownStart } from '../engine/lock/processProbe';
import { takeProjectLock, takeoverQuestion, type ProjectLock, type ProjectLockDeps, type TakeoverOffer } from '../engine/lock/projectLock';
import { takeOverProjectLock } from '../engine/lock/takeover';
import { ClarvisDestination, ClarvisSource, type ClarvisRunHandle } from '../engine/transfer/clarvisSwitch';
import { EngineSwitch, type SwitchDestination, type SwitchOutcome, type SwitchSource } from '../engine/transfer/engineSwitch';
import { switchConfirmLine } from '../engine/transfer/transferState';
import type { ModelService } from '../model/ModelService';

/** The run going now in this window, as a switch needs it. */
export interface CurrentRun {
  runner: CodingRun;
  task: string;
  taskId: string;
  /** The project lock a run of Clarvis's own engine holds. */
  lock?: ProjectLock;
  /** The task's checkpoint as the run started it. */
  base?: TaskCheckpoint;
  /** Resolves once the run's loop has returned. */
  returned: Promise<void>;
}

/** What `RunSession` lends the switch. */
export interface SwitchHost {
  models: ModelService;
  log(line: string): void;
  note(text: string): Promise<void>;
  current(): CurrentRun | undefined;
  /** The chat's own Stop for the run: its abort and the release of a step question. */
  stopRun(): void;
  stepOnScreen(): string | undefined;
  clarvisRunner(fence: ProjectLock, engine: AgentEngineOptions, models: ModelService): AgentRunner;
  codexRunner(access: RavisAccess): RemoteCodexRunner;
  /** Follows a run in the chat, as `RunSession` follows any run. */
  follow(run: CurrentRunStart): Promise<void>;
  setFromPlan(on: boolean, steps: string[]): void;
}

export interface CurrentRunStart {
  runner: CodingRun;
  task: string;
  events: (signal: AbortSignal) => AsyncIterable<AgentEvent>;
  release(): Promise<void>;
  lock?: ProjectLock;
  base?: TaskCheckpoint;
}

export const SWITCH_CHAT_LINES = {
  already: 'A switch is already under way.',
  noFolder: 'There is no trusted folder open, so there is no task to switch.',
  needsRavis: "Switching engines goes through RAVIS's project lock, and this editor can't reach RAVIS right now.",
  nothing: "There's no unfinished task in this project to carry on with the other engine.",
  noBranch: "The saved task has no branch to carry on from, so it can't be switched.",
  cannotSwitchRun: "This run can't be switched: it holds no project lock (a folder without git, or Restricted Mode).",
  declined: 'Left as it was.',
  notStarted: "Clarvis's own engine didn't start on the task.",
};

export class ChatEngineSwitch {
  private active: EngineSwitch | undefined;

  constructor(private readonly host: SwitchHost) {}

  get isSwitching(): boolean {
    return this.active !== undefined;
  }

  /** Text typed while a switch is under way and no run takes it: into the checkpoint's `latestFeedback` (review H8). */
  noteFeedback(text: string): boolean {
    if (!this.active) return false;
    this.active.noteFeedback(text);
    void this.host.note(CODEX_LINES.keptForLater);
    return true;
  }

  async switchEngine(root: string | undefined, access: RavisAccess | undefined): Promise<void> {
    if (this.active) return this.host.note(SWITCH_CHAT_LINES.already);
    if (!root || !vscode.workspace.isTrusted) return this.host.note(SWITCH_CHAT_LINES.noFolder);
    if (!access) return this.host.note(SWITCH_CHAT_LINES.needsRavis);
    const current = this.host.current();
    return current ? this.switchRunning(root, current, access) : this.carryOnStopped(root, access);
  }

  // ── A task running now ──────────────────────────────────────────────────────

  private async switchRunning(root: string, current: CurrentRun, access: RavisAccess): Promise<void> {
    const gitDir = findGitDir(root);
    const pair = current.runner instanceof RemoteCodexRunner ? await this.codexToClarvis(root, gitDir, current.runner, access) : this.clarvisToCodex(root, gitDir, current, access);
    if ('line' in pair) return this.host.note(pair.line);
    const engineSwitch = new EngineSwitch({ ...pair, prompts: this.prompts(), host: windowIdentity().host, log: this.host.log });
    this.active = engineSwitch;
    try {
      await this.tell(await engineSwitch.run());
    } finally {
      this.active = undefined;
    }
  }

  private async codexToClarvis(root: string, gitDir: string | undefined, runner: RemoteCodexRunner, access: RavisAccess): Promise<{ source: SwitchSource; destination: SwitchDestination; sourceModel: string }> {
    const read = readCheckpoint(root, gitDir);
    const state = await access.relay.codexState();
    const source = runner.switchSource({ workspaceRoot: root, gitDir, saved: read.kind === 'found' ? read.checkpoint : undefined, homeFingerprint: state.ok ? state.value.home?.fingerprint : undefined });
    const destination = new ClarvisDestination({
      model: this.host.models.model('chat'),
      workspaceRoot: root,
      gitDir,
      take: async (token, checkpoint) => takeProjectLock({ ...(await this.lockDeps(root, gitDir, checkpoint.taskId, access)), transferToken: token, transferredFrom: checkpoint.codexSession?.id }),
      run: (checkpoint, lock) => this.runClarvis(checkpoint, lock),
    });
    return { source, destination, sourceModel: CODEX_MODEL_ID };
  }

  private clarvisToCodex(root: string, gitDir: string | undefined, current: CurrentRun, access: RavisAccess): { source: SwitchSource; destination: SwitchDestination; sourceModel: string } | { line: string } {
    const runner = current.runner;
    if (!(runner instanceof AgentRunner) || !current.lock || !current.base) return { line: SWITCH_CHAT_LINES.cannotSwitchRun };
    const source = new ClarvisSource({ lock: current.lock, run: this.handleFor(current, runner), git: new GitFacts(root), base: current.base, gitDir, host: windowIdentity().host });
    const codex = this.host.codexRunner(access);
    const destination = codex.switchDestination({ workspaceRoot: root, gitDir }, (events) =>
      void this.host.follow({ runner: codex, task: 'the Codex task in this project', events, release: async () => undefined })
    );
    return { source, destination, sourceModel: this.host.models.model('agent') };
  }

  private handleFor(current: CurrentRun, runner: AgentRunner): ClarvisRunHandle {
    return {
      stop: () => this.host.stopRun(),
      returned: current.returned,
      drainInterjections: () => runner.drainInterjections(),
      pendingQuestion: () => this.host.stepOnScreen(),
      interruptedOperation: () => runner.interruptedOperation,
      checksRun: () => runner.checksRun,
      get result() {
        return runner.result;
      },
      get branches() {
        return runner.branches;
      },
    };
  }

  // ── A task that stopped ─────────────────────────────────────────────────────

  /** Carries a stopped task on with the other engine, from its checkpoint, taking the free project lock. */
  private async carryOnStopped(root: string, access: RavisAccess): Promise<void> {
    const gitDir = findGitDir(root);
    const read = readCheckpoint(root, gitDir);
    const checkpoint = read.kind === 'found' ? read.checkpoint : undefined;
    if (!checkpoint) return this.host.note(SWITCH_CHAT_LINES.nothing);
    if (!checkpoint.git.branch || !checkpoint.git.headCommit) return this.host.note(SWITCH_CHAT_LINES.noBranch);
    const toCodex = checkpoint.engine === 'clarvis';
    const model = toCodex ? CODEX_MODEL_ID : this.host.models.model('chat');
    if (!(await confirm(switchConfirmLine(toCodex ? 'codex' : 'clarvis', model), 'Switch'))) return this.host.note(SWITCH_CHAT_LINES.declined);
    const carried = toCodex ? await this.carryOnWithCodex(root, gitDir, checkpoint, access) : await this.carryOnWithClarvis(root, gitDir, checkpoint, access);
    if (!carried.ok) await this.host.note(carried.line);
  }

  private async carryOnWithClarvis(root: string, gitDir: string | undefined, checkpoint: TaskCheckpoint, access: RavisAccess): Promise<SwitchResult<void>> {
    const taken = await takeProjectLock(await this.lockDeps(root, gitDir, checkpoint.taskId, access));
    if (!taken.held) return { ok: false, line: taken.line };
    const running = { ...checkpoint, previousModel: CODEX_MODEL_ID };
    const started = await this.runClarvis(running, taken.lock);
    if (started.ok) await writeCheckpoint(root, gitDir, { ...withFeedbackDelivered(running), engine: 'clarvis', status: 'running' }, () => taken.lock.stillHolds('commit'));
    return started;
  }

  private async carryOnWithCodex(root: string, gitDir: string | undefined, checkpoint: TaskCheckpoint, access: RavisAccess): Promise<SwitchResult<void>> {
    const codex = this.host.codexRunner(access);
    const destination = codex.switchDestination({ workspaceRoot: root, gitDir }, (events) =>
      void this.host.follow({ runner: codex, task: 'the Codex task in this project', events, release: async () => undefined })
    );
    const ready = await destination.ready();
    if (!ready.ok) return ready;
    // No transfer token: nothing holds the project, and Codex takes the lock as a new task does.
    return destination.start({ ...checkpoint, previousModel: this.host.models.model('agent') }, undefined);
  }

  // ── Taking a project over ───────────────────────────────────────────────────

  /**
   * Another window holds the project and isn't answering, or waits on its owner there: asked, then taken over. The
   * run that follows continues that window's task on its branch, its leftovers committed first (review AL3).
   */
  async takeOver(root: string, offer: TakeoverOffer, access: RavisAccess | undefined): Promise<{ lock: ProjectLock; taskId: string; engine: AgentEngineOptions } | { refusal: string }> {
    if (!(await confirm(takeoverQuestion(offer), 'Take it over'))) return { refusal: SWITCH_CHAT_LINES.declined };
    const gitDir = findGitDir(root);
    const outcome = await takeOverProjectLock(await this.lockDeps(root, gitDir, 'taking-over', access), offer);
    if (outcome.kind !== 'taken') return { refusal: outcome.line };
    const continueOn = await this.continuationOf(root, gitDir, outcome.taskId, `Work the other window left on its task (taken over from ${outcome.takenFrom})`);
    return { lock: outcome.lock, taskId: outcome.taskId, engine: continueOn ? { continueOn } : {} };
  }

  /** How a run continues a task it inherited: from its checkpoint when it is this folder's, else HEAD's agent branch. */
  async continuationOf(root: string, gitDir: string | undefined, taskId: string, leftoversMessage: string): Promise<BranchContinuation | undefined> {
    const read = readCheckpoint(root, gitDir);
    const saved = read.kind === 'found' && read.checkpoint.taskId === taskId ? read.checkpoint : undefined;
    const facts = new GitFacts(root);
    const head = await facts.head();
    const branch = saved?.git.branch ?? (head.branch && isAgentBranch(head.branch) ? head.branch : undefined);
    const tip = branch ? await facts.tip(branch) : undefined;
    return branch && tip ? { branch, headCommit: tip, theirs: saved?.git.dirty ?? [], leftoversMessage } : undefined;
  }

  // ── Shared ──────────────────────────────────────────────────────────────────

  /** Starts Clarvis's own engine on the task, on the chat model; resolves once it has started, or with why not. */
  private runClarvis(checkpoint: TaskCheckpoint, lock: ProjectLock): Promise<SwitchResult<void>> {
    return new Promise((resolve) => {
      const continueOn: BranchContinuation = { branch: checkpoint.git.branch ?? '', headCommit: checkpoint.git.headCommit ?? '', theirs: checkpoint.git.dirty };
      const runner = this.host.clarvisRunner(lock, { continueOn, onStarted: () => resolve({ ok: true, value: undefined }) }, agentOnChatModel(this.host.models));
      const brief = `${checkpoint.task}\n\n${renderCheckpoint(checkpoint)}`;
      this.host.setFromPlan(checkpoint.plan.fromPlan, checkpoint.plan.steps);
      void this.host
        .follow({ runner, task: brief, events: (signal) => runner.run(brief, signal), release: async () => void (await lock.release()), lock, base: checkpoint })
        .finally(() => resolve({ ok: false, line: SWITCH_CHAT_LINES.notStarted }));
    });
  }

  private async lockDeps(root: string, gitDir: string | undefined, taskId: string, access: RavisAccess | undefined): Promise<ProjectLockDeps> {
    return { root, gitDir, taskId, window: windowIdentity(), pid: process.pid, pidStart: (await ownStart()) ?? '', locks: access?.locks, log: this.host.log };
  }

  private prompts() {
    return {
      confirm: (line: string) => confirm(line, 'Switch'),
      leftover: async (line: string) => ((await confirm(line, 'Stop them', 'Cancel the switch')) ? ('stop_them' as const) : ('cancel' as const)),
    };
  }

  private async tell(outcome: SwitchOutcome): Promise<void> {
    if (outcome.kind === 'declined') return this.host.note(SWITCH_CHAT_LINES.declined);
    if (outcome.kind !== 'started') return this.host.note(outcome.line);
    // Typed after the destination's brief was written: handed to the run that carries the task on.
    for (const text of outcome.lateFeedback) this.host.current()?.runner.interject(text);
  }
}

/** A modal yes-or-no, so a step question on screen is left alone. */
async function confirm(line: string, yes: string, no = 'Not now'): Promise<boolean> {
  return (await vscode.window.showInformationMessage(line, { modal: true }, yes, no)) === yes;
}

/**
 * The model service as Clarvis's own engine sees it after a switch from Codex: the coding role answered by the chat
 * model, because the coding setting still names Codex, which this engine can't call.
 */
function agentOnChatModel(models: ModelService): ModelService {
  return new Proxy(models, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => (value as (...inner: unknown[]) => unknown).apply(target, args.map((arg) => (arg === 'agent' ? 'chat' : arg)));
    },
  });
}
