/**
 * Codex's open requests — approvals and questions — as this window holds them
 * (plan.md M15, C2a; design §5.2, §5.3; review M2, M3).
 *
 * **One at a time, first in, first out.** Codex can open several requests at once. They are asked in
 * the order RAVIS opened them, and the next one only once the one on screen has an answer, so nobody
 * answers a question they cannot see. Rendering them is C2b; this holds the order and the rules.
 *
 * **Asked once.** A request arrives again on a reconnect's replay, in a snapshot, or after RAVIS
 * re-sends it. Anything already held, answered or let go is not asked a second time.
 *
 * **Stop lets go of everything at once, before anything is sent.** Reported 11 September 2026 for
 * Clarvis's own engine: Stop did not release the question on screen, so the stop only landed once
 * someone answered it. Here `releaseAll` aborts the question being asked — its asker sees the signal
 * and comes back with nothing — and empties the queue, synchronously, before the runner makes any
 * network call. Each request is remembered as let go, so a late answer to it is an answer to nothing.
 *
 * **Resolved elsewhere means gone here.** Another window answering, RAVIS's own stop, or the unanswered
 * policy (`request.resolved`) removes the request, and aborts it if it is the one on screen.
 *
 * Pure.
 */

import type { RequestView } from '../relay/relayTypes';

/** The request being asked, and the signal that says it no longer needs an answer. */
export interface Asking {
  request: RequestView;
  signal: AbortSignal;
}

export type Resolution = 'showing' | 'queued' | 'unknown';

export class QuestionBoard {
  private readonly queue: RequestView[] = [];
  /** Requests answered, resolved or let go: never asked again. */
  private readonly finished = new Set<string>();
  private current: { request: RequestView; controller: AbortController } | undefined;

  /** Adds a request RAVIS opened. False when it is already held or already finished — a replay. */
  open(request: RequestView): boolean {
    if (this.finished.has(request.id) || this.holds(request.id)) return false;
    this.queue.push(request);
    return true;
  }

  /** The next request to ask, when none is being asked. */
  next(): Asking | undefined {
    if (this.current || this.queue.length === 0) return undefined;
    const request = this.queue.shift() as RequestView;
    this.current = { request, controller: new AbortController() };
    return { request, signal: this.current.controller.signal };
  }

  /** Whether `id` is on screen and still wants this window's answer. */
  stillAsking(id: string): boolean {
    return this.current?.request.id === id && !this.current.controller.signal.aborted;
  }

  /** The asker came back for `id`, with or without an answer: the slot is free for the next one. */
  answered(id: string): void {
    this.finished.add(id);
    if (this.current?.request.id === id) this.current = undefined;
  }

  /** RAVIS says `id` is resolved. Removes it, aborting it if it is on screen. */
  resolve(id: string): Resolution {
    this.finished.add(id);
    if (this.current?.request.id === id) {
      this.current.controller.abort();
      this.current = undefined;
      return 'showing';
    }
    const index = this.queue.findIndex((request) => request.id === id);
    if (index === -1) return 'unknown';
    this.queue.splice(index, 1);
    return 'queued';
  }

  /** Stop: lets go of the request on screen and every queued one. Returns how many there were. */
  releaseAll(): number {
    const released = [...(this.current ? [this.current.request] : []), ...this.queue];
    this.current?.controller.abort();
    this.current = undefined;
    this.queue.length = 0;
    for (const request of released) this.finished.add(request.id);
    return released.length;
  }

  /** Every request held, the one on screen first: what a switch records as never answered (C3). */
  get held(): RequestView[] {
    return [...(this.current ? [this.current.request] : []), ...this.queue];
  }

  /** How many requests are held, on screen or queued. */
  get size(): number {
    return this.queue.length + (this.current ? 1 : 0);
  }

  private holds(id: string): boolean {
    return this.current?.request.id === id || this.queue.some((request) => request.id === id);
  }
}
