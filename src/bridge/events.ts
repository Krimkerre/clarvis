/**
 * The Bridge's event stream: a bounded buffer, and whoever is listening.
 *
 * `vscode`-free, like the rest of `src/bridge/`. It publishes nothing on its own
 * — callers emit — and it is deliberately dull, because §6.5 says telemetry
 * *"can never delay or fail editor work"* and the way to guarantee that is for
 * there to be nothing here that can block, throw or wait.
 *
 * **Everything is dropped rather than queued when the buffer is full.** An
 * unbounded buffer is an editor that runs out of memory because a dashboard was
 * closed, and §6.5 says buffering is bounded in as many words. Drops are counted
 * and reported in the stream, so a consumer knows it missed something rather
 * than seeing a gap it cannot distinguish from quiet.
 */

/** §6.4's families. Listed rather than freeform so a typo is a compile error. */
import { randomUUID } from 'crypto';

export type EventName =
  | 'clarvis.lifecycle.ready'
  | 'clarvis.lifecycle.stopping'
  | 'clarvis.gate.requested'
  | 'clarvis.gate.resolved'
  | 'clarvis.chat.started'
  | 'clarvis.chat.completed'
  | 'clarvis.chat.failed'
  | 'clarvis.chat.cancelled'
  | 'clarvis.agent.started'
  | 'clarvis.agent.step'
  | 'clarvis.agent.completed'
  | 'clarvis.agent.failed'
  | 'clarvis.agent.cancelled'
  | 'clarvis.tool.started'
  | 'clarvis.tool.completed'
  | 'clarvis.tool.failed'
  | 'clarvis.tool.refused'
  | 'clarvis.diagnostic.changed'
  | 'clarvis.model.requested'
  | 'clarvis.model.completed'
  | 'clarvis.model.failed'
  | 'clarvis.capability.changed';

/**
 * What a payload may contain.
 *
 * Primitives only, and that is the enforcement rather than a convention: §6.4's
 * forbidden list — source, terminal output, prompt and response text, command
 * strings, file contents, raw paths, secrets, approval details — is entirely
 * made of things that arrive as strings, and a nested object is where one hides
 * from a reviewer. Keeping the shape flat does not stop somebody putting a
 * command in a string field, but it does mean every field is visible at the
 * call site rather than three levels down in an object being spread.
 */
export type EventData = Readonly<Record<string, string | number | boolean>>;

export interface BridgeEvent {
  readonly id: number;
  readonly name: EventName;
  readonly occurred_at: string;
  readonly data: EventData;
  /**
   * The operation this belongs to, or '' for the events that belong to none.
   *
   * Top level rather than inside `data` because that is where NERVIS's hub
   * joins a trace: inside `data` it is an opaque field and the waterfall never
   * sees it.
   */
  readonly trace_id: string;
  /**
   * The model session the operation's requests carry, or '' when there is none.
   * Top level for the same reason as `trace_id`: §4.4's envelope has the field,
   * and NERVIS files an event under a conversation from it.
   */
  readonly session_id: string;
  /**
   * Unique across the ecosystem, unlike `id`.
   *
   * `id` is this stream's cursor — it restarts at zero with the window, so two
   * Clarvis windows produce the same ones. §4.4 wants an identifier the hub can
   * deduplicate on, which is a different thing, and an envelope without one is
   * quarantined.
   */
  readonly event_id: string;
}

/**
 * How many events are kept for a consumer that reconnects.
 *
 * Small on purpose. This is a reconnect cushion, not a history: §6.8 says the
 * Bridge is not the log, and a buffer big enough to be useful as one would be a
 * second copy of the run in the editor's memory.
 */
export const BUFFER_SIZE = 200;

/** Somebody listening. Writes are fire-and-forget; a slow reader is not waited for. */
export type Listener = (event: BridgeEvent) => void;

export class EventStream {
  private readonly buffer: BridgeEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private next = 1;
  private dropped = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Publish one event. Never throws, never blocks, never awaits.
   *
   * A listener that throws is dropped rather than allowed to abort the fan-out:
   * one broken consumer must not stop the others hearing, and it certainly must
   * not propagate back into the editor work that emitted this.
   */
  emit(name: EventName, data: EventData = {}, traceId = '', sessionId = ''): void {
    const event: BridgeEvent = {
      id: this.next++,
      name,
      // **To the millisecond.** Whole seconds put a Clarvis bar on NERVIS's
      // waterfall up to a second off either end, so a chat turn read as ending
      // before the RAVIS call inside it did (seen 16 September 2026, trace
      // 7886440e…). RFC 3339 allows the fraction and the hub reads it; RAVIS's
      // stamps already carry one.
      occurred_at: new Date(this.now()).toISOString(),
      data,
      event_id: randomUUID().replace(/-/g, ''),
      // Which operation this belongs to, for §11.2's waterfall. Empty for the
      // events that belong to no single one — a heartbeat is not part of a
      // request, and giving it a trace would put a bar in somebody's timeline.
      trace_id: traceId,
      session_id: sessionId,
    };

    this.buffer.push(event);
    while (this.buffer.length > BUFFER_SIZE) {
      this.buffer.shift();
      this.dropped += 1;
    }

    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  /**
   * Everything buffered after `id`, for a consumer that reconnected.
   *
   * `0` — or an absent `Last-Event-ID` — means "everything still held", which
   * for a fresh consumer is the whole cushion rather than nothing. A consumer
   * that wants only what happens next can simply ignore what it already has;
   * the reverse, wanting history it was never offered, is not recoverable.
   */
  since(id: number): readonly BridgeEvent[] {
    return this.buffer.filter((event) => event.id > id);
  }

  /** How many events fell out of the buffer, so a gap is reported rather than silent. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** The id of the newest event, or 0 when nothing has been published. */
  get cursor(): number {
    return this.next - 1;
  }

  /** Adds a listener and returns the way to remove it. */
  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** How many consumers are attached. Used by the health check and by tests. */
  get listenerCount(): number {
    return this.listeners.size;
  }
}

/**
 * One SSE frame.
 *
 * `id:` is what makes `Last-Event-ID` work on reconnect, and the payload is
 * JSON on a single `data:` line — a newline inside a `data:` value would split
 * the frame, and `JSON.stringify` escapes those, which is the reason the body is
 * JSON rather than anything more readable.
 */
export function frame(event: BridgeEvent): string {
  return `id: ${event.id}\nevent: ${event.name}\ndata: ${JSON.stringify({
    id: event.id,
    name: event.name,
    occurred_at: event.occurred_at,
    data: event.data,
  })}\n\n`;
}
