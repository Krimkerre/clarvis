/**
 * Codex's open requests — approvals, questions and blocked sites — as this window holds them
 * (plan.md M15, C2a and C2b; design §5.2, §5.3; review M2, M3).
 *
 * **One at a time, in the order RAVIS opened them.** Codex can open several requests at once. They are
 * asked in order, and the next one only once the one on screen has an answer, so nobody answers a question
 * they cannot see. Rendering them is `approvals.ts`; this holds the order and the rules.
 *
 * **A site ask waits behind Codex's own requests** (C2b). A site ask never holds Codex up — the command it
 * is about has already failed — while a command or file change waiting behind it would. So when both are
 * queued, Codex's requests go first, each kind still in the order it arrived. One already on screen is never
 * taken away for a later one: the owner may be halfway through reading it.
 *
 * **Asked once.** A request arrives again on a reconnect's replay, in a snapshot, or after RAVIS re-sends it.
 * Anything already held, answered or let go is not asked a second time — unless this window puts it back on
 * purpose (`redraw`): RAVIS narrowed what it offers, refused to add a site, or never received the answer.
 *
 * **Stop lets go of everything at once, before anything is sent.** Reported 11 September 2026 for Clarvis's
 * own engine: Stop did not release the question on screen, so the stop only landed once someone answered
 * it. Here `releaseAll` aborts the question being asked — its asker sees the signal and comes back with
 * nothing — and empties the queue, synchronously, before the runner makes any network call. Each request is
 * remembered as let go, so a late answer to it is an answer to nothing.
 *
 * **Resolved elsewhere means gone here.** Another window answering, RAVIS's own stop, or the unanswered
 * policy (`request.resolved`) removes the request, aborts it if it is the one on screen, and keeps it from
 * ever being put back.
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
  /** Requests answered, resolved or let go: never asked again, unless redrawn. */
  private readonly finished = new Set<string>();
  /** Requests RAVIS says are resolved: never asked again, not even redrawn. */
  private readonly resolvedByRavis = new Set<string>();
  private current: { request: RequestView; controller: AbortController } | undefined;

  /** Adds a request RAVIS opened. False when it is already held or already finished — a replay. */
  open(request: RequestView): boolean {
    if (this.finished.has(request.id) || this.holds(request.id)) return false;
    this.queue.push(request);
    return true;
  }

  /** The next request to ask, when none is being asked: Codex's own first, then site asks. */
  next(): Asking | undefined {
    if (this.current || this.queue.length === 0) return undefined;
    const blocking = this.queue.findIndex((request) => request.kind !== 'site');
    const [request] = this.queue.splice(blocking === -1 ? 0 : blocking, 1);
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

  /**
   * Puts a request back to be asked again, ahead of the queue — as RAVIS now offers it. False when RAVIS
   * has resolved it meanwhile, or Stop let it go, or it is already held.
   */
  redraw(request: RequestView): boolean {
    if (this.resolvedByRavis.has(request.id) || this.holds(request.id)) return false;
    this.finished.delete(request.id);
    this.queue.unshift(request);
    return true;
  }

  /** RAVIS says `id` is resolved. Removes it, aborting it if it is on screen. */
  resolve(id: string): Resolution {
    this.finished.add(id);
    this.resolvedByRavis.add(id);
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
    for (const request of released) {
      this.finished.add(request.id);
      // Let go by a stop is final: nothing puts it back, whatever comes back from RAVIS afterwards.
      this.resolvedByRavis.add(request.id);
    }
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
