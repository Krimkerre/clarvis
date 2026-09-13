/**
 * What a coding run looks like from the chat, whichever engine does the work
 * (plan.md M15, C2a; design §5.1).
 *
 * **Two engines, one surface.** `RunSession` starts a task, streams its steps into the chat and the
 * terminal, hands the run anything the person types, and afterwards asks what the run changed.
 * Clarvis's own engine (`AgentRunner`) and a Codex task that RAVIS runs (`RemoteCodexRunner`) both
 * answer those questions through this interface. That is what keeps the progress bar, milestone
 * ticking, the review offers and Stop working the same for both: none of them needs to know which
 * engine it is talking to.
 *
 * Types only, and vscode-free. `AgentEvent` and `MissingDependency` come in as types, which the
 * compiler erases, so nothing here loads the extension host.
 */

import type { AgentEvent } from '../agent/AgentRunner';
import type { MissingDependency } from '../agent/missingDependency';
import type { RunningCommand } from './relay/relayTypes';

export type EngineKind = 'clarvis' | 'codex';

export interface CodingRun {
  readonly engine: EngineKind;
  /** Runs the task, reporting as it goes. Aborting `signal` is Stop. */
  run(task: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
  /** Something the person said mid-run. It must reach the engine, or be kept until it can. */
  interject(text: string): void;
  /** Everything said that the engine has not received yet, taken out of the run (review H8). */
  drainInterjections(): string[];
  /** Commits the run made and files it changed, for the review and the milestone offer. */
  readonly result: { commits: string[]; files: string[] };
  /** True when the run ended on something it could not get past. A person's Stop is not that. */
  readonly blocked: boolean;
  /** True when the run ended because it used every step it was allowed, not because it finished. */
  readonly endedAtStepCap: boolean;
  /** The branch the work is on, and the branch the person started from. */
  readonly branches: { working?: string; startedFrom?: string };
  readonly stillMissing: MissingDependency | undefined;
  /** Set for a Codex run: the RAVIS session, for the run record. */
  readonly codexSession?: { id: string; threadId?: string };
}

/**
 * What a run of Clarvis's own engine asks before it changes anything (design §6.3, the fence).
 *
 * The lock is held around the run by whoever started it; the run only needs these three things from
 * it, so this is all it is handed.
 */
export interface RunFence {
  /**
   * False only on evidence that another window took the project over. `commit` sends a heartbeat
   * first, because a commit is the write that matters most.
   */
  stillHolds(moment: 'tool' | 'commit'): Promise<boolean>;
  /** A sandboxed command started, so a takeover knows which process group to stop. */
  commandStarted(command: RunningCommand): void;
  commandEnded(): void;
}
