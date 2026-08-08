// The three VS Code event sources M1's spike identified as "busy" signals.
export type BusySource = 'task' | 'terminal' | 'debug';

// What a caller learns when a tracked thing finishes. exitCode is undefined for
// debug sessions (VS Code's debug API doesn't expose one).
export interface Outcome {
  id: string;
  source: BusySource;
  label: string;
  exitCode: number | undefined;
  durationMs: number;
}

/**
 * Single idle|busy state machine fed by tasks, terminal shell executions, and debug
 * sessions. Each source is normalized to start(id)/end(id, exitCode) — nothing
 * downstream touches raw VS Code events. onOutcome always fires on end(), regardless
 * of duration; callers apply their own thresholds (e.g. M3's notification floor).
 */
export class BusyTracker {
  // Everything currently running, keyed by a caller-assigned id (see
  // wireBusyTracker.ts for how those ids are minted per event source). Busy simply
  // means this map is non-empty — no separate boolean to fall out of sync.
  private active = new Map<string, { source: BusySource; label: string; startedAt: number }>();
  private onBusyChangeCbs: Array<(busy: boolean) => void> = [];
  private onOutcomeCbs: Array<(outcome: Outcome) => void> = [];

  // Fires on every idle->busy and busy->idle transition (not on every start/end —
  // e.g. starting a second overlapping task doesn't fire this again).
  onBusyChange(cb: (busy: boolean) => void): void {
    this.onBusyChangeCbs.push(cb);
  }

  // Fires once per finished thing, always — independent of how long it ran.
  // Callers that only care about long-running things apply their own duration
  // filter on the outcome (see extension.ts's minDurationSeconds check).
  onOutcome(cb: (outcome: Outcome) => void): void {
    this.onOutcomeCbs.push(cb);
  }

  // Marks `id` as started. Idempotent — calling start() twice for the same id
  // (shouldn't happen, but cheap to guard) doesn't double-count it or refire
  // onBusyChange.
  start(id: string, source: BusySource, label: string): void {
    if (this.active.has(id)) return;
    const wasIdle = this.active.size === 0;
    this.active.set(id, { source, label, startedAt: Date.now() });
    if (wasIdle) this.fireBusyChange(true);
  }

  // Marks `id` as finished. Unknown ids are ignored rather than throwing — this is
  // how debug session dedup works upstream (wireBusyTracker never calls start()
  // for a child session, so its end() here is just a no-op instead of needing its
  // own special case).
  end(id: string, exitCode: number | undefined): void {
    const entry = this.active.get(id);
    if (!entry) return; // unknown id (e.g. deduped debug child) — ignore
    this.active.delete(id);
    const durationMs = Date.now() - entry.startedAt;
    this.onOutcomeCbs.forEach((cb) =>
      cb({ id, source: entry.source, label: entry.label, exitCode, durationMs })
    );
    // Only flip back to idle once EVERYTHING overlapping has finished — this is
    // the piece that keeps two concurrent tasks from prematurely reporting idle
    // when just one of them ends (M3's overlap exit-checklist item).
    if (this.active.size === 0) this.fireBusyChange(false);
  }

  private fireBusyChange(busy: boolean): void {
    this.onBusyChangeCbs.forEach((cb) => cb(busy));
  }
}
