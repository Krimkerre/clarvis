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
 * **Approvals, until C2b.** Codex's requests are declined where RAVIS allows declining, and said so; a
 * question stays open, and Stop still ends the task. Rendering them properly, one at a time from RAVIS's
 * allowed decisions, waits on calibration (plan.md M15 C2b).
 */

import * as vscode from 'vscode';
import type { AgentEvent } from '../../agent/AgentRunner';
import type { MissingDependency } from '../../agent/missingDependency';
import type { AgentTerminal } from '../../agent/tools/commandTools';
import type { CodingRun } from '../CodingRun';
import { windowIdentity } from '../engineHost';
import { findGitDir, gitDirForRelay } from '../lock/gitDir';
import type { RelayClient } from '../relay/relayClient';
import type { Decision, RequestView, SessionMode, SessionSummary } from '../relay/relayTypes';
import { TokenStore } from '../relay/tokenStore';
import { CodexGitGlue } from './codexGit';
import { CodexRunCore, type CodexCursors } from './runCore';
import { declinedLine } from './translate';

const PRESENCE_TICK_MS = 5_000;
/** Cursors are written to `workspaceState` at most this often: a stream of text deltas each carry an id. */
const CURSOR_WRITE_MS = 1_000;

export interface RemoteCodexDeps {
  context: vscode.ExtensionContext;
  root: string;
  relay: RelayClient;
  terminal: AgentTerminal;
  log: (line: string) => void;
  mode: SessionMode;
  maxSteps: number;
}

export class RemoteCodexRunner implements CodingRun {
  readonly engine = 'codex' as const;
  private readonly core: CodexRunCore;
  private readonly git: CodexGitGlue;

  constructor(deps: RemoteCodexDeps) {
    this.git = new CodexGitGlue(deps.context, deps.root, deps.log);
    this.core = new CodexRunCore({
      relay: deps.relay,
      tokens: new TokenStore(),
      cursors: workspaceCursors(deps.context.workspaceState),
      git: this.git,
      window: windowIdentity(),
      workspace: { root: deps.root, gitDir: gitDirForRelay(deps.root, findGitDir(deps.root)) },
      mode: deps.mode,
      maxSteps: deps.maxSteps,
      ask: (request) => this.declineUntilApprovals(request),
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

  interject(text: string): void {
    this.core.interject(text);
  }

  drainInterjections(): string[] {
    return this.core.drainInterjections();
  }

  panelPinged(): void {
    this.core.panelPinged(Date.now());
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

  private async declineUntilApprovals(request: RequestView): Promise<Decision | undefined> {
    this.core.note(declinedLine(request));
    return request.allowed_decisions.includes('skip') ? { kind: 'skip' } : undefined;
  }
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
