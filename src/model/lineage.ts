import { randomBytes } from 'crypto';

/**
 * The two correlation headers RAVIS joins on, and how Clarvis fills them.
 *
 * **Why this exists.** Runbook §8's fourth acceptance scenario asks that a chat
 * turn and an agent run each preserve one session and one trace. Clarvis sent
 * neither: outbound requests carried `content-type` and `authorization` and
 * nothing else, so RAVIS saw no `traceparent` and minted an empty trace id, and
 * every request became its own island. A route decision could say *why this
 * model* and never *for which conversation* — the two facts a person is holding
 * together when they ask why an answer was slow.
 *
 * **Two identifiers, because they answer different questions.** The session is
 * the conversation: RAVIS keys model affinity on it (`sessions.py`), so a
 * follow-up question can land on the model that already has the context warm.
 * The trace is one *operation* — a single chat turn, or one agent run that may
 * make a dozen model calls — and it is what a waterfall assembles from.
 *
 * Nothing here is derived from the workspace, the machine or the user. A
 * correlation key that encodes where it came from is an identifier for the
 * person, and §6.1 rules that out for exactly this reason.
 *
 * **Sent to every OpenAI-compatible endpoint, not only to RAVIS.** `traceparent`
 * is a W3C standard header carrying two random ids and no content, and
 * `x-session-id` is an opaque key; a provider that does not read them ignores
 * them. Sniffing for RAVIS to decide would be a second thing to keep correct,
 * and it would fail exactly where RAVIS is reached through `custom` — which is
 * how it is reached, since Clarvis has no `ravis` provider of its own.
 */

/** W3C `traceparent` version 00, the only one defined. */
const VERSION = '00';

/**
 * Sampled. Clarvis has no sampler and records everything it starts, so claiming
 * otherwise would tell a collector to drop spans this ecosystem wants kept.
 */
const SAMPLED = '01';

/** 16 bytes as 32 hex characters, per the W3C spec. */
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** 8 bytes as 16 hex characters — a fresh span for each request in the trace. */
function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * One `traceparent` for a request belonging to `traceId`.
 *
 * A new span id every call, deliberately. The trace id is what joins an agent
 * run's twelve model calls into one story; the span id is what keeps them
 * distinguishable inside it. Reusing one span id for all of them would collapse
 * the waterfall into a single bar and lose the ordering that makes it useful.
 */
export function traceparent(traceId: string): string {
  return `${VERSION}-${traceId}-${newSpanId()}-${SAMPLED}`;
}

/**
 * The correlation headers for one outbound model request.
 *
 * Both are omitted rather than sent empty when there is nothing to say. An empty
 * `x-session-id` is a session whose id is the empty string, which RAVIS would
 * store and then correlate every anonymous request to — worse than no header,
 * because it looks like an answer.
 */
export function lineageHeaders(traceId: string, sessionId: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (traceId) headers.traceparent = traceparent(traceId);
  if (sessionId) headers['x-session-id'] = sessionId;
  return headers;
}
