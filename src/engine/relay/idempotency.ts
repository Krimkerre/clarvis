/**
 * The `Idempotency-Key`s Clarvis sends RAVIS (plan.md M15, C1).
 *
 * **What a key is for.** RAVIS requires one on every call that must not happen twice: creating a
 * session, a turn, a steer, an answer, a settle, a token reissue, and taking, taking over or handing
 * on a project lock. When a response is lost and the call is retried **with the same key and the same
 * body**, RAVIS answers with the original result instead of doing it again — a retried settle returns
 * the settled view, not `409 CLAIM_INVALID`. The same key with a different body is refused (`422
 * IDEMPOTENCY_KEY_REUSED`), so a key belongs to one logical attempt, never to a session.
 *
 * **The three ways a key is made**, each fixed by the contract:
 * - creating a session: `sha256(taskId + ":" + windowId + ":" + attempt)`, attempts counted from 1 —
 *   the fixtures' key is exactly that digest for attempt 1, which the test checks;
 * - answering a request: `<request id>:<window id>`, so a retry from one window replays, and a second
 *   window never collides with the first (review AM6);
 * - everything else: a fresh random UUID, made once per logical call and reused by its retries.
 */

import { createHash, randomUUID } from 'crypto';

/**
 * 1-128 printable ASCII characters (`conventions.json`). Spaces are printable but never lead or
 * trail, because HTTP trims them off a header value and the key RAVIS stores would differ.
 */
const KEY_FORMAT = /^[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?$/;

/** The key for creating a session. `attempt` starts at 1 and grows only when the body changes. */
export function createSessionKey(taskId: string, windowId: string, attempt: number): string {
  return createHash('sha256').update(`${taskId}:${windowId}:${attempt}`).digest('hex');
}

/** The key for answering request `requestId` from window `windowId`. */
export function answerKey(requestId: string, windowId: string): string {
  return `${requestId}:${windowId}`;
}

/** A key for one logical call. Make it once, before the first attempt, and reuse it for every retry. */
export function freshKey(): string {
  return randomUUID();
}

export function isIdempotencyKey(key: string): boolean {
  return KEY_FORMAT.test(key);
}
