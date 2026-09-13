/**
 * Switching an unfinished task between Codex and Clarvis's own engine, in either direction
 * (plan.md M15, C3; design §6.2; review B1, B2, H8, N1, N2, AH4).
 *
 * **The order is the whole point**, and this class is where it is kept:
 * 1. the destination is asked whether it can take the task at all, then the owner confirms what it costs —
 *    nothing stops and nothing is spent before that yes;
 * 2. `stopping`: the source reserves the project lock for the destination (it goes to `transferring` and a transfer
 *    token comes back), and only then stops its work. If the reservation is refused, nothing has stopped;
 * 3. `confirming`: every process the source started is confirmed gone. Something left over is put to the owner —
 *    stop it, or cancel the switch, and cancelling keeps the locks until it is gone (N1). A destination never starts
 *    beside a leftover;
 * 4. `settling`: the source commits its work on the task's branch and says where it stands;
 * 5. `saved`: the checkpoint is written, while the source still holds the project — with every note typed during the
 *    switch in `latestFeedback` (H8), open questions as never answered, and interrupted operations as uncertain;
 * 6. `starting`: the source hands on (Codex settles `next: "transfer"`, staying idle and never ended — AH4), then the
 *    destination takes the lock with the transfer token and continues on the branch at the saved commit (B2);
 * 7. `started`: only now does the source let go of what it held (Clarvis's lock file), and the notes the destination
 *    started with are marked delivered.
 *
 * **Held throughout.** From step 2 until the destination has started, the source holds the lock in `transferring`,
 * and nothing in this class releases it (N2). A failure at any step before `started` leaves the project with the
 * source, which lets go only once its processes are confirmed gone and its work saved (`SwitchSource.stayed`). An
 * expired transfer token releases nothing.
 *
 * **Never replayed.** Nothing here runs a command or makes a change. What was uncertain is written down for the next
 * engine to check.
 *
 * vscode-free: each engine is a `SwitchSource` or `SwitchDestination` (`clarvisSwitch.ts`, `codexSwitch.ts`).
 */

import type { EngineKind } from '../CodingRun';
import { withFeedback, withFeedbackDelivered, type TaskCheckpoint, type TransferStep } from '../checkpoint/taskCheckpoint';
import type { SwitchConfirmation, SwitchResult } from '../codex/runCore';
import type { Host } from '../relay/relayTypes';
import { mayMove, switchConfirmLine } from './transferState';

export interface SwitchSource {
  readonly engine: EngineKind;
  /** Step 2: the project reserved for the destination, then the source's work stopped. Nothing stops on a refusal. */
  stopForSwitch(): Promise<SwitchResult<{ transferToken: string }>>;
  /** Step 3: every process the source started confirmed gone, what is left, or that it couldn't be told. */
  confirmStopped(): Promise<SwitchConfirmation>;
  /** Leftovers: stopped, then confirmed again. */
  stopLeftovers(): Promise<SwitchConfirmation>;
  /** Step 4: the source's work committed on the task's branch, and the checkpoint as it stands — not yet written. */
  settle(): Promise<SwitchResult<TaskCheckpoint>>;
  /** Step 5: written only while the source still holds the project. */
  saveCheckpoint(checkpoint: TaskCheckpoint): Promise<boolean>;
  /** Step 6, before the destination starts. */
  handOn(): Promise<SwitchResult<void>>;
  /** Step 7: the destination holds the project now. */
  handedOver(): void;
  /** The switch failed or was cancelled: the source keeps the project, and lets go only once all is gone and saved. */
  stayed(): Promise<void>;
}

export interface SwitchDestination {
  readonly engine: EngineKind;
  readonly model: string;
  /** Before anything stops: whether this engine can take the task now. */
  ready(): Promise<SwitchResult<void>>;
  /** Takes the project with the transfer token and continues the task on its branch. Resolves once it has started. */
  start(checkpoint: TaskCheckpoint, transferToken: string): Promise<SwitchResult<void>>;
  /** Written once the destination holds the project. */
  saveCheckpoint(checkpoint: TaskCheckpoint): Promise<boolean>;
}

export interface SwitchPrompts {
  /** The confirmation of what the destination costs (design §6.2 step 1). */
  confirm(line: string): Promise<boolean>;
  /** Something the source started is still running: stop it, or cancel the switch. */
  leftover(line: string): Promise<'stop_them' | 'cancel'>;
}

export type SwitchOutcome =
  | { kind: 'declined' }
  | { kind: 'refused'; line: string }
  /** `lateFeedback`: typed after the destination's brief was written — the caller passes it to the new run. */
  | { kind: 'started'; checkpoint: TaskCheckpoint; lateFeedback: string[] }
  | { kind: 'cancelled'; line: string }
  | { kind: 'failed'; step: TransferStep; line: string };

export const SWITCH_LINES = {
  cancelled: 'The switch is cancelled. The project stays locked until what was still running has stopped; then the task is saved as it is.',
  notSaved: "The task's checkpoint couldn't be saved, so the switch stopped there. Nothing was handed over.",
};

export interface EngineSwitchDeps {
  source: SwitchSource;
  destination: SwitchDestination;
  prompts: SwitchPrompts;
  host: Host;
  /** The coding model the task used before the switch, so switching back knows it. */
  sourceModel: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export class EngineSwitch {
  private readonly typed: string[] = [];
  private current: TransferStep | undefined;
  private readonly startedAt: string;

  constructor(private readonly deps: EngineSwitchDeps) {
    this.startedAt = this.now().toISOString();
  }

  /** Where the switch has got to. */
  get step(): TransferStep | undefined {
    return this.current;
  }

  /** Something the owner typed while the switch is under way: it goes into the checkpoint, and on to the destination. */
  noteFeedback(text: string): void {
    if (text.trim() !== '') this.typed.push(text.trim());
  }

  async run(): Promise<SwitchOutcome> {
    const { source, destination, prompts } = this.deps;
    const ready = await destination.ready();
    if (!ready.ok) return { kind: 'refused', line: ready.line };
    if (!(await prompts.confirm(switchConfirmLine(destination.engine, destination.model)))) return { kind: 'declined' };
    this.move('stopping');
    const reserved = await source.stopForSwitch();
    if (!reserved.ok) {
      // Nothing was stopped: the source carries on, holding the project as before.
      this.move('failed');
      return { kind: 'failed', step: 'stopping', line: reserved.line };
    }
    this.move('confirming');
    const stuck = await this.confirmGone();
    return stuck ?? this.settleAndStart(reserved.value.transferToken);
  }

  /** Step 3, with the owner deciding about anything left over. Undefined once everything is gone. */
  private async confirmGone(): Promise<SwitchOutcome | undefined> {
    const { source, prompts } = this.deps;
    let confirmation = await source.confirmStopped();
    while (confirmation.gone === false) {
      if ((await prompts.leftover(confirmation.leftover)) === 'cancel') return this.giveUp({ kind: 'cancelled', line: SWITCH_LINES.cancelled });
      confirmation = await source.stopLeftovers();
    }
    return confirmation.gone === undefined ? this.giveUp({ kind: 'failed', step: 'confirming', line: confirmation.line }) : undefined;
  }

  /** Steps 4 to 7. */
  private async settleAndStart(transferToken: string): Promise<SwitchOutcome> {
    const { source, destination } = this.deps;
    this.move('settling');
    const settled = await source.settle();
    if (!settled.ok) return this.giveUp({ kind: 'failed', step: 'settling', line: settled.line });
    const saved = this.checkpointAt(settled.value, 'saved');
    if (!(await source.saveCheckpoint(saved))) return this.giveUp({ kind: 'failed', step: 'settling', line: SWITCH_LINES.notSaved });
    this.move('saved');
    const handed = await source.handOn();
    if (!handed.ok) return this.giveUp({ kind: 'failed', step: 'saved', line: handed.line });
    this.move('starting');
    const briefed = this.checkpointAt(saved, 'starting');
    const started = await destination.start(briefed, transferToken);
    if (!started.ok) return this.giveUp({ kind: 'failed', step: 'starting', line: started.line });
    return this.started(briefed);
  }

  private async started(briefed: TaskCheckpoint): Promise<SwitchOutcome> {
    const { source, destination } = this.deps;
    source.handedOver();
    this.move('started');
    // What the destination started with is delivered; anything typed since is kept, and passed on by the caller.
    const late = this.typed.splice(0);
    const running: TaskCheckpoint = { ...withFeedbackDelivered(briefed), engine: destination.engine, status: 'running', savedAt: this.now().toISOString() };
    // The switch is over: the record no longer says one is under way.
    delete running.transfer;
    const checkpoint = withFeedback(running, late, this.deps.host, this.now());
    if (!(await destination.saveCheckpoint(checkpoint))) this.deps.log?.('switch: the started checkpoint was not written');
    return { kind: 'started', checkpoint, lateFeedback: late };
  }

  /** Every note typed so far goes into the checkpoint, with where the switch has got to. */
  private checkpointAt(checkpoint: TaskCheckpoint, step: TransferStep): TaskCheckpoint {
    const { source, destination, host, sourceModel } = this.deps;
    const withTyped = withFeedback(checkpoint, this.typed.splice(0), host, this.now());
    const transfer = { from: source.engine, to: destination.engine, toModel: destination.model, startedAt: this.startedAt, step };
    return { ...withTyped, status: 'transferring', previousModel: sourceModel, transfer };
  }

  /** A failure or a cancel: the project stays with the source, which lets go only when it may. */
  private async giveUp(outcome: SwitchOutcome): Promise<SwitchOutcome> {
    this.move('failed');
    await this.deps.source.stayed();
    return outcome;
  }

  private move(step: TransferStep): void {
    if (!mayMove(this.current, step)) throw new Error(`a switch can't go from ${this.current ?? 'nothing'} to ${step}`);
    this.current = step;
    this.deps.log?.(`switch: ${step}`);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}
