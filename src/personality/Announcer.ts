import * as vscode from 'vscode';
import { AvatarController } from '../AvatarController';
import { ButlerState } from '../panels/ButlerViewProvider';
import { mayInterrupt, Priority } from './rateLimit';
import { SpeechOccasion } from '../voice/speechScope';
import { phrase } from './Voice';

/** How long a reaction stays on the avatar's face before it settles back. */
const REACTION_HOLD_MS = 4000;

/**
 * The one door every *unsolicited* remark goes through.
 *
 * M3's completion notices, M5's pattern hits and M6's quips all announce through here,
 * which is what makes the interruption budget (§6) actually mean something: a budget
 * enforced separately in three places is three budgets, and the user experiences the
 * sum of them.
 *
 * Deliberately *not* used by the briefing (M4, once per session) or by chat replies
 * (M8, solicited). Those aren't interruptions — §7 governs things the user didn't ask
 * for, and a question asked is never an interruption.
 */
export class Announcer {
  private lastSurfaceAt: number | undefined;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;

  /** Anyone who wants a copy of what was actually said (M8a: the chat transcript). */
  private readonly listeners: ((message: string, occasion: SpeechOccasion) => void)[] = [];

  /**
   * Subscribes to delivered remarks.
   *
   * **Suppressed remarks are not reported.** A remark the budget withheld is one
   * Clarvis did not make, and writing it into the transcript anyway would turn the
   * interruption budget into a rate limit on *toasts* rather than on talking. The
   * output channel still logs the suppression, which is where that belongs.
   */
  onAnnounce(listener: (message: string, occasion: SpeechOccasion) => void): void {
    this.listeners.push(listener);
  }

  constructor(
    private readonly avatar: AvatarController,
    private readonly log: (message: string) => void
  ) {}

  /**
   * Says something, if the budget allows.
   *
   * Returns whether it was delivered, mostly so callers can log honestly. A suppressed
   * remark produces no notification of its own suppression — telling someone you
   * decided not to interrupt them is still interrupting them.
   */
  announce(
    message: string,
    state: ButlerState,
    occasion: SpeechOccasion,
    priority: Priority = 'routine',
    now = Date.now()
  ): boolean {
    if (!mayInterrupt(this.lastSurfaceAt, now, priority)) {
      this.log(`suppressed (interruption budget, ${priority}): ${message}`);
      return false;
    }

    this.lastSurfaceAt = now;

    // Phrased here rather than at each caller: completion notices, pattern hits and
    // bank quips all arrive through this door, and the character should not depend on
    // which of them it was.
    void phrase('report', message).then((said) => this.deliver(said, state, occasion));
    return true;
  }

  /**
   * Announces something that has to be *produced*, and only if it will be heard.
   *
   * The budget is checked first and the producer is called second — the ordering is
   * the whole point (M8g2). Writing a line and then discovering it is suppressed
   * spends a model request on a remark nobody will ever see, on every build.
   *
   * A producer returning nothing falls back to `fallback`, so a slow or unusable model
   * costs the user nothing but the canned line they would have had anyway.
   */
  async announceWith(
    produce: () => Promise<string | undefined>,
    fallback: string,
    state: ButlerState,
    occasion: SpeechOccasion,
    priority: Priority = 'routine',
    now = Date.now()
  ): Promise<boolean> {
    if (!mayInterrupt(this.lastSurfaceAt, now, priority)) {
      this.log(`suppressed (interruption budget, ${priority}): ${fallback}`);
      return false;
    }

    // Reserved before producing, so a slow producer cannot let a second surface slip
    // through the budget while this one is still being written.
    this.lastSurfaceAt = now;

    const text = (await produce()) ?? fallback;
    this.deliver(text, state, occasion);
    return true;
  }

  /** The delivery half, shared by both entry points. */
  private deliver(message: string, state: ButlerState, occasion: SpeechOccasion): void {
    this.avatar.setState(state);
    void vscode.window.showInformationMessage(message);

    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this.avatar.setState('neutral'), REACTION_HOLD_MS);

    for (const listener of this.listeners) listener(message, occasion);
    this.log(`announced: ${message}`);
  }

  dispose(): void {
    clearTimeout(this.holdTimer);
  }
}
