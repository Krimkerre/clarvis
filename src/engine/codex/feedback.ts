/**
 * What the person typed for Codex that hasn't reached it yet (plan.md M15, C2a; design §5.4, review H8).
 *
 * **Never dropped.** Clarvis 0.13 logged a mid-run redirect, took it off the queue and never sent it —
 * the model carried on as if nobody had spoken (`src/model/toolResultTurn.test.ts` guards that for
 * Clarvis's own engine). A second engine must not bring the same bug back. So text that cannot go to
 * Codex right now is kept here instead: typed while the task is stopping, while RAVIS can't be reached
 * or the stream is down, refused with `409 SESSION_STOPPING` or `409 PROJECT_LOCKED`, or handed back by
 * RAVIS as `feedback {how: "not_delivered"}`. It goes to Codex the next time it can — steered into a
 * turn that is running, or put first in the next turn's text — and only then is it marked delivered.
 *
 * This is the checkpoint's `latestFeedback` (design §6.1), kept in memory for the run. Writing it to the
 * checkpoint file, so it survives a reload or a switch of engines, is C3.
 *
 * Pure: the caller supplies the clock and the host name.
 */

import { interjectionMessage } from '../../agent/interjections';

export interface FeedbackEntry {
  text: string;
  typedAt: string;
  host: string;
  delivered: boolean;
}

export class FeedbackQueue {
  private readonly entries: FeedbackEntry[] = [];

  /**
   * Keeps text for later. False for nothing to keep, or text already waiting — the same words kept
   * locally and then handed back by RAVIS are one message, not two.
   */
  keep(text: string, host: string, now: Date): boolean {
    const trimmed = text.trim();
    if (trimmed === '' || this.pending.includes(trimmed)) return false;
    this.entries.push({ text: trimmed, typedAt: now.toISOString(), host, delivered: false });
    return true;
  }

  /** The texts still waiting to reach Codex, oldest first. */
  get pending(): string[] {
    return this.entries.filter((entry) => !entry.delivered).map((entry) => entry.text);
  }

  get all(): readonly FeedbackEntry[] {
    return this.entries;
  }

  markDelivered(text: string): void {
    const trimmed = text.trim();
    for (const entry of this.entries) {
      if (entry.text === trimmed) entry.delivered = true;
    }
  }

  /** Takes every waiting note out, with when and where it was typed, for a switch's checkpoint (C3). */
  drainEntries(): FeedbackEntry[] {
    const waiting = this.entries.filter((entry) => !entry.delivered).map((entry) => ({ ...entry }));
    this.drain();
    return waiting;
  }

  /** Takes every waiting text out, for a caller that will carry it on (review H8's `drainInterjections`). */
  drain(): string[] {
    const texts = this.pending;
    for (let index = this.entries.length - 1; index >= 0; index--) {
      if (!this.entries[index].delivered) this.entries.splice(index, 1);
    }
    return texts;
  }

  /**
   * A new turn's text with everything waiting put first, framed the way Clarvis's own engine frames a
   * redirect, so it outranks the plan already in flight. The caller marks it delivered once RAVIS
   * accepts the turn.
   */
  turnText(text: string): string {
    const said = interjectionMessage(this.pending);
    return said === '' ? text : `${said}\n\n${text}`;
  }
}
