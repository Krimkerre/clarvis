/**
 * Checking that a success body carries what its caller will read (plan.md M15, C1).
 *
 * Deliberately shallow: the named fields exist, with the named JSON types. The full comparison with
 * RAVIS's contract fixtures belongs to the tests (`src/test/fakes/relayContract.ts`); at runtime the
 * only question is whether reading a field will find one, so a caller never works from a half-filled
 * value that looked like a success.
 */

import type { RelayOutcome } from './relayFailure';
import type { CallOptions, RelayHttp, RelayRequest } from './relayHttp';

export type JsonKind = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
export type Guard = (value: unknown) => boolean;

export function jsonKind(value: unknown): JsonKind | 'other' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const kind = typeof value;
  return kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'object' ? kind : 'other';
}

/** A guard that `value` is an object whose named fields have one of the named kinds. */
export function shaped(fields: Record<string, JsonKind | readonly JsonKind[]>): Guard {
  return (value) => {
    if (jsonKind(value) !== 'object') return false;
    const record = value as Record<string, unknown>;
    return Object.entries(fields).every(([name, kinds]) => {
      const allowed: readonly string[] = typeof kinds === 'string' ? [kinds] : kinds;
      return allowed.includes(jsonKind(record[name]));
    });
  };
}

/** For a route whose success body the contract doesn't fix, like `204` presence or lock release. */
export const anyBody: Guard = () => true;

/** Sends a request and turns a success that fails `guard` into `malformed`. */
export async function sendExpecting<T>(
  http: RelayHttp,
  request: RelayRequest,
  guard: Guard,
  options?: CallOptions
): Promise<RelayOutcome<T>> {
  const outcome = await http.send<unknown>(request, options);
  if (!outcome.ok || guard(outcome.value)) return outcome as RelayOutcome<T>;
  const detail = `${request.method} ${request.path}: the answer lacks a field the contract fixes`;
  return { ok: false, failure: { kind: 'malformed', status: outcome.status, detail } };
}
