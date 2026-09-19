/**
 * The Bridge's one place in a window: started when asked, started again when an earlier start
 * came to nothing (a folder not yet trusted), and stopped in a way `deactivate` can wait for.
 *
 * **Why `deactivate` has to wait.** Stopping deregisters from NERVIS, and it used to be started
 * and not awaited, so the extension host ended before the request left: a reloaded window and
 * a closed tab each stayed listed as live until NERVIS's 45-second lease ran out (attended
 * session, 17 September 2026). VS Code waits for a promise `deactivate` returns. The lease stays
 * the mechanism for a window that crashes.
 *
 * vscode-free: the host hands in how to start one.
 */

export interface Stoppable {
  stop(): Promise<void>;
}

export class BridgeSlot<H extends Stoppable> {
  private running: Promise<H | undefined> = Promise.resolve(undefined);
  private busy = false;
  private closed = false;

  constructor(
    private readonly start: () => Promise<H | undefined>,
    private readonly log: (message: string) => void
  ) {}

  /** Starts a Bridge unless one is running or starting. A start that returned nothing may be tried again. */
  launch(): void {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.running = this.start().then(
      (handle) => {
        if (!handle) this.busy = false;
        return handle;
      },
      (failure: unknown) => {
        // Caught rather than allowed to become an unhandled rejection: a Bridge that could not
        // start must not take the editor's error handling with it.
        this.busy = false;
        this.log(`bridge: could not start (${failure instanceof Error ? failure.message : String(failure)})`);
        return undefined;
      }
    );
  }

  /** Stops it for good, resolving once the Bridge has stopped — deregistration included. */
  /** The running handle, if one started and the slot isn't closed — for a read, never a stop. */
  async current(): Promise<H | undefined> {
    return this.closed ? undefined : this.running;
  }

  async stop(): Promise<void> {
    this.closed = true;
    const handle = await this.running;
    await handle?.stop();
  }
}
