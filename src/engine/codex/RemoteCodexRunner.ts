/**
 * A Codex task RAVIS runs, as one of the chat's coding runs (plan.md M15, C2a; design §5.1).
 *
 * **Thin glue over `runCore.ts`**, which holds every rule and every test. This file hands the core what
 * only VS Code has — the token file's default folder, the per-host cursor store (`workspaceState`), git
 * through the Git extension, the terminal, this window's identity — and adds the one thing a run of
 * Clarvis's own engine ends with: the line saying where the owner's own work is.
 *
 * **Presence.** While a run is followed, a timer ticks the core's presence every 5 s, and the chat panel's
 * pings (`panelPinged`) keep the window counted as attached (design §3.5.4).
 *
 * **Approvals** (C2b). Codex's requests are asked in the chat by `approvals.ts`, one at a time, with RAVIS's
 * allowed decisions as buttons; the chat's own question mechanism shows them (`RunSession.askCodex`). Before an
 * approved file change, the files it touches are copied for **Clarvis: Undo Last Agent Run** (`undoCopies`).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentEvent } from '../../agent/AgentRunner';
import { Checkpoint } from '../../agent/Checkpoint';
import type { MissingDependency } from '../../agent/missingDependency';
import type { AgentTerminal } from '../../agent/tools/commandTools';
import type { CodingRun } from '../CodingRun';
import { readCheckpoint, writeCheckpoint } from '../checkpoint/checkpointFile';
import { GitFacts } from '../checkpoint/gitFacts';
import type { TaskCheckpoint } from '../checkpoint/taskCheckpoint';
import { windowIdentity } from '../engineHost';
import { findGitDir, gitDirForRelay } from '../lock/gitDir';
import type { LockClient } from '../lock/lockClient';
import { ownStart } from '../lock/processProbe';
import { takeProjectLock } from '../lock/projectLock';
import type { RelayClient } from '../relay/relayClient';
import type { SessionMode, SessionSummary } from '../relay/relayTypes';
import { TokenStore } from '../relay/tokenStore';
import { CodexDestination, CodexSource } from '../transfer/codexSwitch';
import { checkpointFromCodex } from '../transfer/fromSource';
import type { StoredCodexChoice } from '../codexChoice';
import type { PromptShower } from './approvals';
import { CodexGitGlue } from './codexGit';
import { CodexRunCore, type BuildOnTask, type CodexCheckpointPort, type CodexCursors, type CodexLockFloor } from './runCore';
import { projectFiles, scanSites } from './siteScan';

const PRESENCE_TICK_MS = 5_000;
/** Cursors are written to `workspaceState` at most this often: a stream of text deltas each carry an id. */
const CURSOR_WRITE_MS = 1_000;

export interface RemoteCodexDeps {
  context: vscode.ExtensionContext;
  root: string;
  relay: RelayClient;
  /** RAVIS's lock API, for taking a paused task's checkout over from an editor that closed (F-A9). */
  locks?: LockClient;
  terminal: AgentTerminal;
  log: (line: string) => void;
  mode: SessionMode;
  /** The chat's mode as it is now, so a switch to Unattended counts from the request on screen (C2b). */
  modeNow: () => SessionMode;
  maxSteps: number;
  /** Shows one of Codex's requests in the chat and comes back with the owner's reply (C2b). */
  ask: PromptShower;
  /** The Codex model and effort the owner chose in the bowtie menu, read when a task starts (C2b+). */
  codexChoice: () => StoredCodexChoice;
}

export class RemoteCodexRunner implements CodingRun {
  readonly engine = 'codex' as const;
  private readonly core: CodexRunCore;
  private readonly git: CodexGitGlue;

  constructor(private readonly deps: RemoteCodexDeps) {
    this.git = new CodexGitGlue(deps.context, deps.root, deps.log);
    const gitDir = findGitDir(deps.root);
    this.core = new CodexRunCore({
      relay: deps.relay,
      tokens: new TokenStore(),
      cursors: workspaceCursors(deps.context.workspaceState),
      git: this.git,
      window: windowIdentity(),
      workspace: { root: deps.root, gitDir: gitDirForRelay(deps.root, gitDir) },
      mode: deps.mode,
      modeNow: deps.modeNow,
      maxSteps: deps.maxSteps,
      ask: deps.ask,
      capture: undoCopies(deps),
      // C2b+: the sites a task will likely need, asked about before it starts; and the owner's model and effort.
      sitesFor: (task) => scanSites(projectFiles(deps.root), task),
      codexChoice: deps.codexChoice,
      floor: deps.locks ? checkoutFloor(deps, deps.locks) : undefined,
      // M15 C3: a switch reserves the project with the session's token, and every settle writes the checkpoint first.
      locks: deps.locks,
      checkpoint: checkpointPort(deps, gitDir),
      terminal: (text) => deps.terminal.write(text),
      log: deps.log,
    });
  }

  run(task: string, signal: AbortSignal): AsyncIterable<AgentEvent> {
    return this.followed(this.core.start(task, signal));
  }

  /** Picks up a task another window started, or this one before a reload. */
  attach(summary: SessionSummary, signal: AbortSignal): AsyncIterable<AgentEvent> {
    return this.followed(this.core.attach(summary, signal));
  }

  /** A new token for a task whose token file lost it. Undefined once kept; otherwise why not. */
  reissue(summary: SessionSummary): Promise<string | undefined> {
    return this.core.reissue(summary);
  }

  /** "Carry on" after the step cap: a new turn on the same Codex session, followed like the first (design §5.5). */
  carryOn(sessionId: string, text: string, signal: AbortSignal): AsyncIterable<AgentEvent> {
    return this.followed(this.core.carryOn(sessionId, text, signal));
  }

  /**
   * **Build on** Codex's earlier work left on its branch: a `continue` turn with the new request on that idle session,
   * on its branch, followed like any task (plan.md M15; the owner's decision of 15 Sep 2026).
   */
  buildOn(left: BuildOnTask, task: string, signal: AbortSignal): AsyncIterable<AgentEvent> {
    return this.followed(this.core.buildOn(left, task, signal));
  }

  /** The task's last turn ended at RAVIS's step cap. */
  get endedAtStepCap(): boolean {
    return this.core.endedAtStepCap;
  }

  /** The task was refused because the folder needs git set up, in a folder RAVIS would take (plan.md M15). */
  get needsGitSetup(): boolean {
    return this.core.needsGitSetup;
  }

  /** This Codex task as the engine a switch stops (M15 C3; design §6.2). */
  switchSource(place: { workspaceRoot: string; gitDir: string | undefined; saved: TaskCheckpoint | undefined; homeFingerprint?: string }): CodexSource {
    return new CodexSource({ core: this.core, host: windowIdentity().host, ...place });
  }

  /** Codex as the engine a switch hands a task to (M15 C3). `follow` is the chat's run loop, given this runner's events. */
  switchDestination(place: { workspaceRoot: string; gitDir: string | undefined }, follow: (run: (signal: AbortSignal) => AsyncIterable<AgentEvent>) => void): CodexDestination {
    return new CodexDestination({
      core: this.core,
      relay: this.deps.relay,
      git: new GitFacts(place.workspaceRoot),
      host: windowIdentity().host,
      ...place,
      follow: (run) => follow((signal) => this.followed(run(signal))),
    });
  }

  interject(text: string): void {
    this.core.interject(text);
  }

  drainInterjections(): string[] {
    return this.core.drainInterjections();
  }

  panelPinged(): void {
    this.core.panelPinged(Date.now());
  }

  /** The chat's mode changed: Unattended may answer the request on screen itself (C2b). */
  modeChanged(): void {
    this.core.modeChanged();
  }

  get result(): { commits: string[]; files: string[] } {
    return this.core.result;
  }

  get blocked(): boolean {
    return this.core.blocked;
  }

  get branches(): { working?: string; startedFrom?: string } {
    return this.git.branches;
  }

  /** Codex's missing dependencies are Codex's to report; the chat's offer for them is Clarvis's engine only. */
  get stillMissing(): MissingDependency | undefined {
    return undefined;
  }

  get codexSession(): { id: string; threadId?: string } | undefined {
    return this.core.codexSession;
  }

  /** Set when a start was refused because a Codex session already holds the project. */
  get attachInstead(): string | undefined {
    return this.core.attachInstead;
  }

  private async *followed(events: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
    const ticking = setInterval(() => this.core.presenceTick(Date.now()), PRESENCE_TICK_MS);
    ticking.unref();
    try {
      for await (const event of events) yield event.kind === 'done' ? this.withClosing(event) : event;
    } finally {
      clearInterval(ticking);
    }
  }

  /** Where the owner's own work is, as Clarvis's own engine says it. */
  private withClosing(event: AgentEvent): AgentEvent {
    const { working, startedFrom } = this.git.branches;
    if (!event.files?.length || !working || !startedFrom) return event;
    return { ...event, closing: `\n\nYour own work on \`${startedFrom}\` is untouched — Codex's changes are on \`${working}\`.` };
  }
}

/**
 * Copies each file before an approved Codex change touches it, so **Clarvis: Undo Last Agent Run** can put it back
 * (M15 C2b; design §5.2). The copies start at the task's first approved change, replacing the last run's the way a
 * run of Clarvis's own engine does; the task branch stays the undo for everything else, including whatever Codex
 * changed while no window was attached. `approvals.ts` hands only paths inside the project.
 */
export function undoCopies(deps: Pick<RemoteCodexDeps, 'context' | 'root' | 'log'>): (paths: string[]) => Promise<void> {
  let checkpoint: Checkpoint | undefined;
  return async (paths) => {
    if (!checkpoint) {
      checkpoint = new Checkpoint(deps.context, deps.root, deps.log);
      await checkpoint.begin('a Codex task');
    }
    for (const file of paths) await checkpoint.capture(path.join(deps.root, file));
  };
}

/**
 * The checkout lock file, for a task RAVIS paused because another editor held the checkout when it restarted:
 * taken over only when that editor is gone by the shared lock rule, after what it left running is stopped,
 * and registered with RAVIS as an adoption (design §5.7 step 6; final check F-A9).
 */
function checkoutFloor(deps: RemoteCodexDeps, locks: LockClient): CodexLockFloor {
  return {
    takeFromGoneEditor: async (taskId) => {
      const outcome = await takeProjectLock({
        root: deps.root,
        gitDir: findGitDir(deps.root),
        taskId,
        window: windowIdentity(),
        pid: process.pid,
        pidStart: (await ownStart()) ?? '',
        locks,
        adopt: true,
        log: deps.log,
      });
      return outcome.held ? { release: () => outcome.lock.release() } : { refusal: outcome.line };
    },
  };
}

/**
 * The checkpoint at every settle, written before the settle tells RAVIS it was (M15 C3; design §6.1). The core calls
 * it only from the window holding RAVIS's settle claim, on a lock RAVIS didn't give away — its fence for Codex.
 */
function checkpointPort(deps: RemoteCodexDeps, gitDir: string | undefined): CodexCheckpointPort {
  return {
    save: async (facts) => {
      const read = readCheckpoint(deps.root, gitDir);
      const saved = read.kind === 'found' ? read.checkpoint : undefined;
      const checkpoint = checkpointFromCodex(saved, facts, { workspaceRoot: deps.root, host: windowIdentity().host, now: new Date() });
      const written = await writeCheckpoint(deps.root, gitDir, checkpoint, async () => true);
      if (written.kind !== 'saved') deps.log(`codex: the task's checkpoint wasn't written (${written.kind})`);
      return written.kind === 'saved';
    },
  };
}

/** The last event id per session, kept per host in `workspaceState` and written at most once a second. */
function workspaceCursors(memento: vscode.Memento): CodexCursors {
  const latest = new Map<string, number>();
  let pending: NodeJS.Timeout | undefined;
  const key = (sessionId: string) => `clarvis.codex.lastEvent.${sessionId}`;
  const flush = () => {
    pending = undefined;
    for (const [sessionId, eventId] of latest) void memento.update(key(sessionId), eventId);
  };
  return {
    get: (sessionId) => latest.get(sessionId) ?? memento.get<number>(key(sessionId)) ?? null,
    set: (sessionId, eventId) => {
      latest.set(sessionId, eventId);
      pending ??= setTimeout(flush, CURSOR_WRITE_MS);
    },
  };
}
