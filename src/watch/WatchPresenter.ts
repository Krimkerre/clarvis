import * as vscode from 'vscode';
import { AvatarController } from '../AvatarController';
import { BusyTracker, Outcome } from './BusyTracker';
import { outcomeMessage } from './outcomeMessages';

/**
 * How long an outcome reaction (impressed/judging) stays on the avatar's face
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
    private readonly log: (message: string) => void
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
   * Note: no rate limiting beyond this duration floor yet. M6's interruption
   * budget (§6, ≤1 unsolicited surface per 10 min) closes that gap; until then a
   * burst of slow jobs will produce a burst of notifications.
   */
  private handleOutcome(outcome: Outcome): void {
    const minDurationSeconds = readMinDurationSeconds();
    this.log(
      `outcome ${outcome.source} "${outcome.label}" ` +
        `exitCode=${outcome.exitCode} durationMs=${outcome.durationMs} ` +
        `(threshold=${minDurationSeconds}s)`
    );

    if (outcome.durationMs < minDurationSeconds * 1000) return;

    // exitCode 0 reads as success; anything else — including `undefined`, which is
    // what a debug session reports — earns a skeptical look.
    const succeeded = outcome.exitCode === 0;
    this.avatar.setState(succeeded ? 'impressed' : 'judging');
    vscode.window.showInformationMessage(outcomeMessage(outcome));
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
