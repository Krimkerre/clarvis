/**
 * When a window counts as attached to a Codex task, decided from its chat panel's pings
 * (plan.md M15, C1; design §3.5.4, review AH2).
 *
 * **Why the panel and not the extension host.** code-server keeps a closed tab's extension host
 * alive for three hours. If "attached" meant "the extension host is running", a task whose tab was
 * closed would look watched for three hours, and RAVIS's 30-minute rule for unanswered questions with
 * nobody there would never start. So the chat webview pings every 10 s, and this tracker turns those
 * pings into what the host tells RAVIS:
 * - while pings are fresh, `presence {panel_connected: true}` every 20 s;
 * - once they have been silent for 25 s, `panel_connected: false`, and the event stream is closed;
 * - when they come back — the tab reopened, same extension host — `true` at once, and the stream is
 *   opened again from its cursor (final check F-A8).
 *
 * RAVIS counts a window attached while its last `true` is under 45 s old, so a window that posts
 * every 20 s never drops out between posts.
 *
 * Pure: the caller supplies the clock, sends the POSTs and runs the stream. The timings are the
 * contract's (`event-stream.json` attachment), and the test reads them from there.
 */

export const PANEL_PING_MS = 10_000;
export const PRESENCE_EVERY_MS = 20_000;
export const PINGS_LOST_AFTER_MS = 25_000;

export type PresenceAction =
  | { kind: 'post'; panelConnected: boolean }
  /** Open the event stream from the stored cursor, or without one for a snapshot. */
  | { kind: 'open_stream' }
  /** Close the stream. Closing it never stops the task. */
  | { kind: 'close_stream' };

export class PresenceTracker {
  private lastPing: number | undefined;
  private lastPost = 0;
  private connected = false;

  /** The chat panel pinged at `now`. */
  ping(now: number): PresenceAction[] {
    this.lastPing = now;
    if (this.connected) return [];
    this.connected = true;
    this.lastPost = now;
    return [{ kind: 'post', panelConnected: true }, { kind: 'open_stream' }];
  }

  /** A timer tick at `now`; call it at least every few seconds. */
  tick(now: number): PresenceAction[] {
    if (!this.connected || this.lastPing === undefined) return [];
    if (now - this.lastPing >= PINGS_LOST_AFTER_MS) {
      this.connected = false;
      this.lastPost = now;
      return [{ kind: 'post', panelConnected: false }, { kind: 'close_stream' }];
    }
    if (now - this.lastPost < PRESENCE_EVERY_MS) return [];
    this.lastPost = now;
    return [{ kind: 'post', panelConnected: true }];
  }

  get panelConnected(): boolean {
    return this.connected;
  }
}
