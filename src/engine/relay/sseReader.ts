/**
 * Reading a Codex session's event stream from RAVIS, and staying connected to it
 * (plan.md M15, C1; design §3.5.4 and §9).
 *
 * **What the stream is.** `GET /api/v1/agent-sessions/{sid}/events` sends server-sent events: each
 * frame has a per-session, rising integer `id`, an `event` name and one JSON `data` line, and a comment
 * arrives every 15 s as a heartbeat. Connected without a cursor, the stream starts with a `snapshot` —
 * the whole session, open requests included; with `Last-Event-ID` it replays what came after that id.
 *
 * **What this reader adds, and why each piece is here:**
 * - **Resume.** It remembers the last id it handed on (`cursor`) and reconnects with it, so a dropped
 *   connection loses nothing. The caller keeps that cursor per host and passes it back after a reload.
 * - **An expired cursor.** A cursor older than what RAVIS still keeps is refused with `409
 *   EVENT_CURSOR_EXPIRED` before any frame. The reader then reads the session (`GET …/{sid}`), hands it
 *   on as a `snapshot` event, and reconnects with `?after=` its `last_event_id` — the recovery
 *   `event-stream.json` spells out.
 * - **Duplicates.** A frame whose id isn't past the cursor is dropped — an overlapping replay, or the
 *   same event sent twice — so nobody is asked the same question twice. A `snapshot` is never dropped:
 *   it replaces what the window knows.
 * - **Silence.** Nothing at all for 45 s, heartbeats included, counts as a dead connection and the
 *   reader reconnects: a half-open socket can otherwise look connected for ever.
 * - **Backoff.** Reconnects wait 2, 5, 10, then 30 s (design §9), starting again from 2 s after any
 *   connection RAVIS accepted. The server's `retry:` hint is read and not used; the design fixes the
 *   schedule.
 * - **Chunks.** Bytes arrive split anywhere, mid-line and mid-character (`SseFrameParser` here, and
 *   `decodeStream` from `src/model/sse.ts`).
 *
 * **What ends it:** `close()`, or a refusal no reconnect can fix, such as a wrong token's 404. RAVIS not
 * answering is not an end: the reader keeps trying and reports each wait as a `disconnected` item.
 * Closing the stream never stops the task; only `interrupt` does.
 *
 * **For whoever reads it:** keep pulling items. Waiting on a person inside the loop stalls the reads,
 * and the silence watchdog would then cut a healthy connection. Hand the question off, keep reading.
 */

import { decodeStream } from '../../model/sse';
import type { RelayClient } from './relayClient';
import { failureFromNetworkError, isTransient, type RelayFailure } from './relayFailure';
import { abortableSleep, type Sleep } from './relayHttp';
import type { Host } from './relayTypes';

export const RECONNECT_BACKOFF_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000];
export const SILENCE_LIMIT_MS = 45_000;

/** One dispatched frame, before its data is parsed. */
export interface SseFrame {
  id: string | undefined;
  event: string;
  data: string;
}

const LINE_END = /\r\n|\r|\n/;

/** Turns decoded text, split anywhere, into frames. */
export class SseFrameParser {
  /** The last `retry:` hint, in milliseconds. */
  retry: number | undefined;
  private buffer = '';
  private id: string | undefined;
  private event = '';
  private data: string[] = [];

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (let end = this.nextLineEnd(); end; end = this.nextLineEnd()) {
      const line = this.buffer.slice(0, end.index);
      this.buffer = this.buffer.slice(end.index + end[0].length);
      const frame = this.take(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** The next complete line ending. A `\r` at the very end may be half of `\r\n`, so it waits. */
  private nextLineEnd(): RegExpExecArray | null {
    const end = LINE_END.exec(this.buffer);
    if (!end || (end[0] === '\r' && end.index === this.buffer.length - 1)) return null;
    return end;
  }

  private take(line: string): SseFrame | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined; // a comment: RAVIS's heartbeat
    const colon = line.indexOf(':');
    if (colon === -1) return this.field(line, '');
    const value = line.slice(colon + 1);
    return this.field(line.slice(0, colon), value.startsWith(' ') ? value.slice(1) : value);
  }

  private field(name: string, value: string): undefined {
    if (name === 'data') this.data.push(value);
    else if (name === 'event') this.event = value;
    else if (name === 'id' && !value.includes('\0')) this.id = value;
    else if (name === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
    return undefined;
  }

  /**
   * A blank line ends a frame. Unlike a browser's EventSource, an id is not carried into the next
   * frame: a frame without an id of its own must not inherit one and then look like a duplicate.
   */
  private dispatch(): SseFrame | undefined {
    const frame =
      this.data.length === 0 ? undefined : { id: this.id, event: this.event || 'message', data: this.data.join('\n') };
    this.id = undefined;
    this.event = '';
    this.data = [];
    return frame;
  }
}

/** Why a connection ended: RAVIS closed it, it went silent, or a request failed. */
export type Disconnect = { kind: 'closed' } | { kind: 'silent' } | RelayFailure;

export type StreamItem =
  | { type: 'connected'; cursor: number | null }
  | { type: 'event'; id: number | null; event: string; data: Record<string, unknown> }
  | { type: 'malformed'; id: number | null; event: string; raw: string }
  | { type: 'cursor_expired'; oldestEventId: number | null }
  | { type: 'disconnected'; reason: Disconnect; retryInMs: number }
  | { type: 'ended'; failure: RelayFailure };

export interface EventStreamOptions {
  client: RelayClient;
  sessionId: string;
  token: string;
  windowId: string;
  host: Host;
  /** The last event id this window saw; null or absent to start from a snapshot. */
  cursor?: number | null;
  backoffMs?: readonly number[];
  silenceLimitMs?: number;
  sleep?: Sleep;
}

type Step = { then: 'stop' } | { then: 'reconnect_now' } | { then: 'wait'; reason: Disconnect; accepted: boolean };

const STOP: Step = { then: 'stop' };
const RECONNECT_NOW: Step = { then: 'reconnect_now' };

/** A session's event stream that reconnects until closed. Iterate it once. */
export class RelayEventStream implements AsyncIterable<StreamItem> {
  /** Frames dropped because their id wasn't past the cursor. */
  duplicatesDropped = 0;
  private readonly closer = new AbortController();
  private lastId: number | null;
  private resumeWithAfter = false;
  private iterated = false;

  constructor(private readonly options: EventStreamOptions) {
    this.lastId = options.cursor ?? null;
  }

  /** The id of the last event handed on: store it, and pass it back to resume. */
  get cursor(): number | null {
    return this.lastId;
  }

  /** Stops reading and reconnecting. Never stops the task. */
  close(): void {
    this.closer.abort();
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamItem> {
    if (this.iterated) throw new Error('a RelayEventStream is read once');
    this.iterated = true;
    return this.run();
  }

  private async *run(): AsyncGenerator<StreamItem> {
    let refusedInARow = 0;
    try {
      while (!this.closer.signal.aborted) {
        const step = yield* this.connect();
        if (step.then === 'stop') return;
        if (step.then === 'reconnect_now') continue;
        refusedInARow = step.accepted ? 0 : refusedInARow + 1;
        const retryInMs = this.backoff(refusedInARow);
        yield { type: 'disconnected', reason: step.reason, retryInMs };
        await (this.options.sleep ?? abortableSleep)(retryInMs, this.closer.signal);
      }
    } finally {
      // Also reached when the reader stops iterating early: the open request must not outlive it.
      this.close();
    }
  }

  private async *connect(): AsyncGenerator<StreamItem, Step> {
    const { client, sessionId, token, windowId, host } = this.options;
    const connection = new AbortController();
    const resume = this.resumeWithAfter ? { after: this.lastId } : { lastEventId: this.lastId };
    const signal = AbortSignal.any([this.closer.signal, connection.signal]);
    const opened = await client.openEvents(sessionId, token, { windowId, host, ...resume }, signal);
    if (!opened.ok) return yield* this.refused(opened.failure);
    this.resumeWithAfter = false;
    yield { type: 'connected', cursor: this.lastId };
    return yield* this.read(opened.value, connection);
  }

  private async *refused(failure: RelayFailure): AsyncGenerator<StreamItem, Step> {
    if (failure.kind === 'cancelled' || this.closer.signal.aborted) return STOP;
    if (isCursorExpired(failure)) return yield* this.recover(failure);
    if (isTransient(failure)) return { then: 'wait', reason: failure, accepted: false };
    yield { type: 'ended', failure };
    return STOP;
  }

  /** `409 EVENT_CURSOR_EXPIRED`: take the session as a snapshot, then continue after it. */
  private async *recover(failure: Extract<RelayFailure, { kind: 'refused' }>): AsyncGenerator<StreamItem, Step> {
    yield { type: 'cursor_expired', oldestEventId: numberOrNull(failure.details.oldest_event_id) };
    const { client, sessionId, token } = this.options;
    const view = await client.getSession(sessionId, token, { signal: this.closer.signal });
    if (!view.ok) return yield* this.refused(view.failure);
    this.lastId = view.value.last_event_id;
    this.resumeWithAfter = true;
    yield { type: 'event', id: this.lastId, event: 'snapshot', data: { session_id: sessionId, ...view.value } };
    return RECONNECT_NOW;
  }

  private async *read(response: Response, connection: AbortController): AsyncGenerator<StreamItem, Step> {
    const parser = new SseFrameParser();
    const watchdog = new Watchdog(this.options.silenceLimitMs ?? SILENCE_LIMIT_MS, () => connection.abort());
    try {
      for await (const chunk of decodeStream(response.body as ReadableStream<Uint8Array>)) {
        watchdog.heard();
        for (const frame of parser.push(chunk)) {
          const item = this.accept(frame);
          if (item) yield item;
        }
      }
      return { then: 'wait', reason: { kind: 'closed' }, accepted: true };
    } catch (error) {
      if (this.closer.signal.aborted) return STOP;
      const reason: Disconnect = watchdog.fired ? { kind: 'silent' } : failureFromNetworkError(error, false);
      return { then: 'wait', reason, accepted: true };
    } finally {
      watchdog.stop();
      connection.abort();
    }
  }

  private accept(frame: SseFrame): StreamItem | undefined {
    const id = eventId(frame.id);
    if (!this.isNew(id, frame.event)) {
      this.duplicatesDropped++;
      return undefined;
    }
    if (id !== null) this.lastId = id;
    const data = jsonObject(frame.data);
    if (!data) return { type: 'malformed', id, event: frame.event, raw: frame.data };
    return { type: 'event', id, event: frame.event, data };
  }

  private isNew(id: number | null, event: string): boolean {
    return event === 'snapshot' || id === null || this.lastId === null || id > this.lastId;
  }

  private backoff(refusedInARow: number): number {
    const schedule = this.options.backoffMs ?? RECONNECT_BACKOFF_MS;
    return schedule[Math.min(refusedInARow, schedule.length - 1)];
  }
}

/** Calls `onSilence` once nothing has been heard for `limitMs`. */
class Watchdog {
  fired = false;
  private timer: NodeJS.Timeout;

  constructor(
    private readonly limitMs: number,
    private readonly onSilence: () => void
  ) {
    this.timer = this.arm();
  }

  heard(): void {
    clearTimeout(this.timer);
    this.timer = this.arm();
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  private arm(): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.fired = true;
      this.onSilence();
    }, this.limitMs);
    // A watchdog is never a reason for the extension host, or a test, to stay alive.
    timer.unref();
    return timer;
  }
}

function isCursorExpired(failure: RelayFailure): failure is Extract<RelayFailure, { kind: 'refused' }> {
  return failure.kind === 'refused' && failure.code === 'EVENT_CURSOR_EXPIRED';
}

function eventId(raw: string | undefined): number | null {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
