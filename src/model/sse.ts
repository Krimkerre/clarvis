/**
 * Reading server-sent events off a streaming HTTP body.
 *
 * Pure and transport-free, because the bug this code exists to avoid is invisible in
 * a happy-path test: **a chunk boundary can fall anywhere**, including mid-line and
 * mid-UTF-8-character. A parser that assumes one chunk is one event works perfectly in
 * development against a fast local endpoint and drops tokens over a real connection.
 */
export class SseParser {
  private buffer = '';

  /**
   * Feeds a decoded chunk in, returns whatever complete `data:` payloads it completed.
   *
   * Incomplete tails stay in the buffer for the next chunk. Comment lines (`:`), which
   * some providers send as keep-alives, are skipped rather than parsed as data.
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const payloads: string[] = [];

    // Events are separated by a blank line, but providers differ on \n vs \r\n, so
    // lines are split individually rather than on a fixed record separator.
    const lines = this.buffer.split('\n');
    // The final element is either an incomplete line or an empty string after a
    // trailing newline. Either way it is not ready to parse.
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trimEnd(); // drops the \r in \r\n
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (!trimmed.startsWith('data:')) continue;

      payloads.push(trimmed.slice('data:'.length).trim());
    }

    return payloads;
  }
}

/**
 * Streams decoded text from a fetch body.
 *
 * `TextDecoder` with `{ stream: true }` is the load-bearing detail: a multi-byte
 * character split across two chunks decodes to a replacement character without it,
 * which shows up as a mangled quote mark in one reply out of fifty and is miserable to
 * track down later.
 */
export async function* decodeStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    // Flush anything the decoder was holding for a continuation byte that never came.
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
