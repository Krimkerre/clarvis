/**
 * Watching one model request from the outside, for §6.4's `clarvis.model.*` events.
 *
 * `vscode`-free, so the fast suite can drive it. Every stream `ModelService` hands
 * out passes through here, which is what makes the events cover every caller —
 * chat, the agent, titles, the voice check — without any of them knowing.
 *
 * **Watching never changes the stream.** Every item is passed on as it arrives, an
 * error is rethrown as it was, and a reader that stops early still closes the
 * request underneath. A watcher that throws is the caller's problem to contain
 * (`ModelService.tell` drops it), never the request's.
 */

import { ModelError, type StreamEvent } from './ModelProvider';

/** Who a request is, decided before it is made. */
export interface ModelCall {
  readonly role: 'chat' | 'agent';
  readonly provider: string;
  readonly model: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly sessionId: string;
}

/** A request at one moment of its life, as the Bridge's `ModelNote` takes it. */
export interface WatchedCall extends ModelCall {
  readonly phase: 'requested' | 'completed' | 'failed';
  readonly elapsedMs?: number;
  readonly firstOutputMs?: number;
  readonly textChunks?: number;
  readonly toolCalls?: number;
  readonly result?: 'answered' | 'cancelled' | 'closed' | 'error';
  readonly retryable?: boolean;
}

/**
 * A stop, or a deadline Clarvis set itself — both reach here as `AbortError`, and
 * neither is the model failing. The same line `fail()` draws in `activity.ts`.
 */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** What arrived, counted as it passes. */
class Tally {
  first?: number;
  text = 0;
  tools = 0;

  constructor(private readonly began: number, private readonly now: () => number) {}

  count(item: string | StreamEvent): void {
    if (this.first === undefined) this.first = this.now() - this.began;
    if (typeof item === 'string' || item.type === 'text') this.text += 1;
    else if (item.type === 'toolCall') this.tools += 1;
  }

  ended(): Pick<WatchedCall, 'elapsedMs' | 'firstOutputMs' | 'textChunks' | 'toolCalls'> {
    return {
      elapsedMs: Math.max(0, this.now() - this.began),
      ...(this.first === undefined ? {} : { firstOutputMs: Math.max(0, this.first) }),
      textChunks: this.text,
      toolCalls: this.tools,
    };
  }
}

/**
 * `open()`'s stream, with `tell` called when the request is made and once when it ends.
 *
 * The request is made when the stream is first read, not when it is created — the
 * adapters are generators — so `requested` is told then, and the clock starts then.
 */
export async function* watchedStream<T extends string | StreamEvent>(
  call: ModelCall,
  open: () => AsyncIterable<T>,
  tell: (watched: WatchedCall) => void,
  now: () => number = Date.now
): AsyncGenerator<T> {
  const tally = new Tally(now(), now);
  let told = false;
  const end = (watched: Omit<WatchedCall, keyof ModelCall | 'elapsedMs'>): void => {
    told = true;
    tell({ ...call, ...tally.ended(), ...watched });
  };
  tell({ ...call, phase: 'requested' });
  try {
    for await (const item of open()) {
      tally.count(item);
      yield item;
    }
    end({ phase: 'completed', result: 'answered' });
  } catch (error) {
    if (isAbort(error)) end({ phase: 'completed', result: 'cancelled' });
    else end({ phase: 'failed', result: 'error', ...(error instanceof ModelError ? { retryable: error.retryable } : {}) });
    throw error;
  } finally {
    // A reader that stopped reading: `return()` lands here with nothing told yet.
    if (!told) end({ phase: 'completed', result: 'closed' });
  }
}
