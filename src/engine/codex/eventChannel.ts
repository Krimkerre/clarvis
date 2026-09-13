/**
 * A queue one side pushes into and the other drains with `for await` (plan.md M15, C2a).
 *
 * **Why the Codex runner needs one.** It works on two clocks. RAVIS's event stream has to be read
 * continuously — a reader that stops to wait for a person trips the stream's 45-second silence check
 * (C1's note) — and questions, steers and the settle each finish whenever they finish. `RunSession`,
 * meanwhile, reads the run's events one at a time and awaits the chat between them. This is the
 * hand-off between the two: everything pushed is kept in order, and the reader never polls.
 *
 * Pushing after `close()` does nothing, so a late event from work that is winding down cannot appear
 * after the run's closing line. Whatever was pushed before the close is still read.
 */

export class EventChannel<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | undefined;
  private closed = false;
  private iterated = false;

  push(item: T): void {
    if (this.closed) return;
    const waiting = this.waiting;
    if (!waiting) {
      this.items.push(item);
      return;
    }
    this.waiting = undefined;
    waiting({ value: item, done: false });
  }

  /** Ends the channel once what is already in it has been read. */
  close(): void {
    this.closed = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.iterated) throw new Error('an EventChannel is read once');
    this.iterated = true;
    return {
      next: () => this.next(),
      // A reader that stops early (an exception in its loop) closes the channel behind it.
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}
