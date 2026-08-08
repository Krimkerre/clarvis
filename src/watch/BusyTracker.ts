/** The three VS Code event sources M1's spike identified as "busy" signals. */
export type BusySource = 'task' | 'terminal' | 'debug';

/**
 * What a caller learns when a tracked job finishes.
 *
 * `exitCode` is undefined for debug sessions — VS Code's debug API doesn't expose
 * one — so consumers must treat "no exit code" as its own case, not as success.
 */
export interface Outcome {
  id: string;
  source: BusySource;
  label: string;
  exitCode: number | undefined;
  durationMs: number;
}

type BusyChangeListener = (busy: boolean) => void;
type OutcomeListener = (outcome: Outcome) => void;

/**
 * Single idle|busy state machine fed by tasks, terminal shell executions, and
 * debug sessions.
 *
 * Each source is normalized to start(id)/end(id, exitCode), so nothing downstream
 * touches raw VS Code events. Deliberately free of any vscode import: that keeps
 * the concurrency logic here unit-testable without an extension host.
 */
export class BusyTracker {
  /**
   * Everything currently running, keyed by a caller-assigned id (see
   * wireBusyTracker for how those are minted). "Busy" just means this map is
   * non-empty — there's no separate boolean that could fall out of sync.
   */
  private readonly active = new Map<
    string,
    { source: BusySource; label: string; startedAt: number }
  >();

  private readonly busyChangeListeners: BusyChangeListener[] = [];
  private readonly outcomeListeners: OutcomeListener[] = [];

  /**
   * Subscribes to idle->busy and busy->idle transitions. Note this fires on
   * transitions only: starting a second overlapping job doesn't fire it again.
   */
  onBusyChange(listener: BusyChangeListener): void {
    this.busyChangeListeners.push(listener);
  }

  /**
   * Subscribes to finished jobs. Fires for every job regardless of how long it
   * ran — callers that only care about slow ones apply their own duration filter
   * (see WatchPresenter).
   */
  onOutcome(listener: OutcomeListener): void {
    this.outcomeListeners.push(listener);
  }

  /**
   * Marks a job as started. Idempotent: a repeated id is ignored rather than
   * double-counted, so a duplicate event can't leave the tracker stuck busy.
   */
  start(id: string, source: BusySource, label: string): void {
    if (this.active.has(id)) return;

    const wasIdle = this.active.size === 0;
    this.active.set(id, { source, label, startedAt: Date.now() });
    if (wasIdle) this.notifyBusyChange(true);
  }

  /**
   * Marks a job as finished and reports its outcome.
   *
   * Unknown ids are ignored rather than throwing — that's what makes debug-session
   * dedup work upstream: wireBusyTracker never calls start() for a nested child
   * session, so the child's end() lands here as a harmless no-op.
   */
  end(id: string, exitCode: number | undefined): void {
    const job = this.active.get(id);
    if (!job) return;

    this.active.delete(id);
    this.notifyOutcome({
      id,
      source: job.source,
      label: job.label,
      exitCode,
      durationMs: Date.now() - job.startedAt,
    });

    // Only report idle once everything overlapping has finished — this is what
    // stops two concurrent jobs from reporting idle when just one of them ends.
    if (this.active.size === 0) this.notifyBusyChange(false);
  }

  private notifyBusyChange(busy: boolean): void {
    this.busyChangeListeners.forEach((listener) => listener(busy));
  }

  private notifyOutcome(outcome: Outcome): void {
    this.outcomeListeners.forEach((listener) => listener(outcome));
  }
}
