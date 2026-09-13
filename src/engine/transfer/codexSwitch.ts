/**
 * Codex in a switch: as the task that stops, and as the task that takes over from Clarvis's own engine
 * (plan.md M15, C3; design §6.2).
 *
 * **As the source** (Codex → Clarvis): `CodexRunCore` does the relay's part — the lock reserved with the session's
 * token, questions let go and recorded, the interrupt `{reason: "switch"}`, RAVIS's word on the stop, the claim and
 * the commit "stopped for a switch", then `settle {next: "transfer"}` once the checkpoint is written. The session is
 * left idle with its thread, never ended or archived, so switching back reuses it (AH4). This file turns the core's
 * facts into the checkpoint and writes it while this window holds the settle claim.
 *
 * **As the destination** (Clarvis → Codex): Codex is asked whether it may run before anything stops. At the start, the
 * checkpoint decides how Codex takes the task back (`codexStartFor`): the task's idle session with a catch-up turn,
 * a new session resuming its thread, or a fresh brief — each taking the project with the transfer token, after the
 * task's branch is continued at the saved commit. The catch-up says what changed since Codex last saw the project.
 *
 * vscode-free: the core, the relay and git are handed in.
 */

import type { AgentEvent } from '../../agent/AgentRunner';
import { catchUpText, renderCheckpoint } from '../checkpoint/checkpointBrief';
import { writeCheckpoint } from '../checkpoint/checkpointFile';
import type { GitFacts } from '../checkpoint/gitFacts';
import type { TaskCheckpoint } from '../checkpoint/taskCheckpoint';
import type { CodexRunCore, SwitchConfirmation, SwitchResult } from '../codex/runCore';
import { failureLine } from '../codex/translate';
import { CODEX_MODEL_ID } from '../engineChoice';
import { codexReadiness } from '../relay/codexReadiness';
import type { RelayClient } from '../relay/relayClient';
import type { Host } from '../relay/relayTypes';
import type { SwitchDestination, SwitchSource } from './engineSwitch';
import { checkpointFromCodex } from './fromSource';
import { codexStartFor } from './transferState';

interface Place {
  workspaceRoot: string;
  gitDir: string | undefined;
  host: Host;
  now?: () => Date;
}

export interface CodexSourceDeps extends Place {
  core: CodexRunCore;
  /** The checkpoint already saved for the task, if any: its brief and plan carry over. */
  saved: TaskCheckpoint | undefined;
  /** `GET /api/v1/codex` `home.fingerprint`, so a later switch back can resume the thread. */
  homeFingerprint?: string;
}

export class CodexSource implements SwitchSource {
  readonly engine = 'codex' as const;

  constructor(private readonly deps: CodexSourceDeps) {}

  stopForSwitch(): Promise<SwitchResult<{ transferToken: string }>> {
    return this.deps.core.stopForSwitch();
  }

  confirmStopped(): Promise<SwitchConfirmation> {
    return this.deps.core.stoppedForSwitch();
  }

  stopLeftovers(): Promise<SwitchConfirmation> {
    return this.deps.core.stopLeftoversForSwitch();
  }

  async settle(): Promise<SwitchResult<TaskCheckpoint>> {
    const claimed = await this.deps.core.claimForSwitch();
    if (!claimed.ok) return claimed;
    const context = { workspaceRoot: this.deps.workspaceRoot, host: this.deps.host, now: now(this.deps), homeFingerprint: this.deps.homeFingerprint };
    return { ok: true, value: checkpointFromCodex(this.deps.saved, claimed.value, context) };
  }

  async saveCheckpoint(checkpoint: TaskCheckpoint): Promise<boolean> {
    const written = await writeCheckpoint(this.deps.workspaceRoot, this.deps.gitDir, checkpoint, async () => this.deps.core.holdsSwitchClaim());
    return written.kind === 'saved';
  }

  handOn(): Promise<SwitchResult<void>> {
    return this.deps.core.settleForSwitch();
  }

  handedOver(): void {
    // The session is settled and idle, without the lock: there is nothing more to let go of here.
  }

  async stayed(): Promise<void> {
    this.deps.core.abandonSwitch();
  }
}

export interface CodexDestinationDeps extends Place {
  core: CodexRunCore;
  relay: RelayClient;
  /** For the catch-up's changes since Codex last saw the project. */
  git: GitFacts;
  /**
   * Follows the new Codex run: the chat's run loop, or a test's reader. It hands in the signal its own Stop aborts,
   * so a Stop after the switch reaches Codex as any Stop does.
   */
  follow(run: (signal: AbortSignal) => AsyncIterable<AgentEvent>): void;
}

export class CodexDestination implements SwitchDestination {
  readonly engine = 'codex' as const;
  readonly model = CODEX_MODEL_ID;

  constructor(private readonly deps: CodexDestinationDeps) {}

  /** Refused up front when Codex may not run (design §6.2 step 1): nothing is stopped for a Codex that can't start. */
  async ready(): Promise<SwitchResult<void>> {
    const state = await this.deps.relay.codexState();
    if (!state.ok) return { ok: false, line: failureLine(state.failure, 'start') };
    const refusal = codexReadiness(state.value);
    return refusal ? { ok: false, line: failureLine(refusal, 'start') } : { ok: true, value: undefined };
  }

  /** `transferToken` is absent when a stopped task is carried on: nothing holds the project, and Codex takes it as a new task does. */
  async start(checkpoint: TaskCheckpoint, transferToken: string | undefined): Promise<SwitchResult<void>> {
    const state = await this.deps.relay.codexState();
    if (!state.ok) return { ok: false, line: failureLine(state.failure, 'start') };
    const start = codexStartFor(checkpoint, state.value, await this.idleSession(checkpoint));
    const brief = `${checkpoint.task}\n\n${renderCheckpoint(checkpoint)}`;
    const catchUp = catchUpText(checkpoint, { headCommit: checkpoint.git.headCommit ?? '', diffStat: await this.changesSinceCodex(checkpoint) });
    // `started` must exist before anything follows the run, so the run gets its own stop, joined to the follower's.
    const stop = new AbortController();
    const { events, started } = this.deps.core.continueFromSwitch({ checkpoint, transferToken, start, brief, catchUp }, stop.signal);
    this.deps.follow((signal) => {
      if (signal.aborted) stop.abort();
      else signal.addEventListener('abort', () => stop.abort(), { once: true });
      return events;
    });
    return started;
  }

  async saveCheckpoint(checkpoint: TaskCheckpoint): Promise<boolean> {
    const written = await writeCheckpoint(this.deps.workspaceRoot, this.deps.gitDir, checkpoint, async () => this.deps.core.holdsProjectLock());
    return written.kind === 'saved';
  }

  /** The task's earlier Codex session, when RAVIS still keeps it idle (the normal case after a switch, AH4). */
  private async idleSession(checkpoint: TaskCheckpoint): Promise<string | undefined> {
    const id = checkpoint.codexSession?.id;
    if (!id) return undefined;
    const listed = await this.deps.relay.listSessions(this.deps.workspaceRoot);
    return listed.ok && listed.value.some((session) => session.id === id && session.state === 'idle') ? id : undefined;
  }

  private async changesSinceCodex(checkpoint: TaskCheckpoint) {
    const since = checkpoint.codexSession?.sawHeadCommit;
    const head = checkpoint.git.headCommit;
    return since && head ? this.deps.git.diffStat(since, head) : checkpoint.git.diffStat;
  }
}

function now(place: Place): Date {
  return (place.now ?? (() => new Date()))();
}
