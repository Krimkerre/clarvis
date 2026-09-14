/**
 * The answers FakeRavisRelay gives, built from RAVIS's contract fixtures (plan.md M15, C1 and C2a).
 *
 * Shared by the fake and its session state machine (`fakeSessions.ts`), which is why they live apart from
 * both: the machine builds the same answers the fake does, and neither should import the other's module
 * to get them. Test support only.
 */

import { errorCatalogue, exampleNamed, fixtureMessage, type FixtureRoute } from './relayContract';

export interface FakeAnswer {
  status: number;
  body?: unknown;
  /** Sent exactly as written and not checked: a deliberately malformed payload. */
  raw?: string;
  headers?: Record<string, string>;
  /** Why this answer is outside the fixtures on purpose. It is then not checked. */
  offContract?: string;
}

/** A named fixture example's response, as the fake sends it. */
export function fixtureAnswer(routeKey: string, name: string): FakeAnswer {
  const example = exampleNamed(routeKey, name);
  return { status: example.response.status, body: example.response.body };
}

/** A route's first success example: what it answers when nothing else is scripted. */
/** A fixture's error answer with other details, as RAVIS fills them in for the case at hand. */
export function withDetails(answer: FakeAnswer, details: Record<string, unknown>): FakeAnswer {
  (answer.body as { error: { details: Record<string, unknown> } }).error.details = details;
  return answer;
}

export function firstSuccess(route: FixtureRoute): FakeAnswer {
  const example = route.examples.find((candidate) => candidate.response.status < 300);
  if (!example) throw new Error(`${route.key} has no success example`);
  return { status: example.response.status, body: structuredClone(example.response.body) };
}

/** An error in RAVIS's envelope, with the fixtures' message and `retryable` for its code. */
export function errorAnswer(
  status: number,
  code: string,
  message: string = fixtureMessage(code),
  details: Record<string, unknown> = {}
): FakeAnswer {
  const error = {
    code,
    message,
    retryable: errorCatalogue()[code].retryable,
    details,
    request_id: 'fixture-request-id',
    trace_id: 'fixture-trace-id',
  };
  return { status, body: { error } };
}
