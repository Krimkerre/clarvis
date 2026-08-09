import * as vscode from 'vscode';
import { AvatarController } from '../AvatarController';
import { Announcer } from '../personality/Announcer';
import { BusyTracker, Outcome } from './BusyTracker';
import { outcomeMessage } from './outcomeMessages';
import { reactionTo } from './reactions';

/**
 * How long an outcome reaction (impressed/judging/surprised) stays on the avatar's face
 * before it settles back to neutral, assuming nothing else starts running.
 */
const REACTION_HOLD_MS = 4000;

/** Default seconds below which a finished job isn't worth mentioning. */
const DEFAULT_MIN_DURATION_SECONDS = 30;

/**
 * Turns raw busy/outcome events into everything the user actually sees: the
 * avatar's expression and the completion notification.
 *
 * Split out from extension.ts because deciding *how to react* to work finishing is
 * its own responsibility — separate from tracking whether work is running
 * (BusyTracker) and from rendering an expression (AvatarController).
 */
export class WatchPresenter {
  /**
   * Set while a post-outcome reaction is on screen, so a quick idle blip doesn't
   * wipe the expression before the user has seen it.
   */
  private holdingReaction = false;
  private reactionHoldTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly avatar: AvatarController,
    private readonly log: (message: string) => void,
    /** Shared interruption budget (§6) — completion notices are unsolicited too. */
    private readonly announcer: Announcer
  ) {}

  /** Subscribes to a tracker's events. Call once per tracker. */
  attachTo(tracker: BusyTracker): void {
    tracker.onBusyChange((busy) => this.handleBusyChange(busy));
    tracker.onOutcome((outcome) => this.handleOutcome(outcome));
  }

  /** Frees the pending reaction timer so a reload can't leave one dangling. */
  dispose(): void {
    clearTimeout(this.reactionHoldTimer);
  }

  /**
   * Work started or everything stopped. Busy always means "thinking"; going idle
   * only resets to neutral when we aren't mid-reaction to a just-finished job.
   */
  private handleBusyChange(busy: boolean): void {
    if (busy) {
      this.cancelReactionHold();
      this.avatar.setState('thinking');
    } else if (!this.holdingReaction) {
      this.avatar.setState('neutral');
    }
  }

  /**
   * One job finished. Short jobs are logged but never surfaced — nobody wants a
   * notification for a two-second command.
   *
   * Delivered through the Announcer, so the §6 interruption budget applies. It was
   * bypassing it — this class took an Announcer and then called
   * `showInformationMessage` directly, which meant a burst of slow jobs produced a
   * burst of notifications no matter what the budget said.
   */
  private handleOutcome(outcome: Outcome): void {
    const minDurationSeconds = readMinDurationSeconds();
    this.log(
      `outcome ${outcome.source} "${outcome.label}" ` +
        `exitCode=${outcome.exitCode} durationMs=${outcome.durationMs} ` +
        `(threshold=${minDurationSeconds}s)`
    );

    if (outcome.durationMs < minDurationSeconds * 1000) return;

    // The Announcer sets the face and returns it to rest on the same 4s hold, so a
    // suppressed notice must not leave this class holding a reaction nothing showed.
    if (!this.announcer.announce(outcomeMessage(outcome), reactionTo(outcome), 'completion')) return;

    this.startReactionHold();
  }

  /** Keeps the reaction on screen briefly, then lets the avatar settle. */
  private startReactionHold(): void {
    this.cancelReactionHold();
    this.holdingReaction = true;
    this.reactionHoldTimer = setTimeout(() => {
      this.holdingReaction = false;
      this.avatar.setState('neutral');
    }, REACTION_HOLD_MS);
  }

  private cancelReactionHold(): void {
    clearTimeout(this.reactionHoldTimer);
    this.holdingReaction = false;
  }
}

/** Read fresh each time so changing the setting takes effect without a reload. */
function readMinDurationSeconds(): number {
  return vscode.workspace
    .getConfiguration('clarvis')
    .get<number>('watch.minDurationSeconds', DEFAULT_MIN_DURATION_SECONDS);
}
