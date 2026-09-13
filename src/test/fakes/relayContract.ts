/**
 * RAVIS's contract fixtures, as something a test can hold a request or a response to
 * (plan.md M15, C1).
 *
 * The fixtures in `src/test/fixtures/relay-contract/` are RAVIS's word on every relay and lock route
 * (`ECOSYSTEM_RUNBOOK.md` §2.2), copied byte for byte and hash-checked by
 * `codexContractFixtures.test.ts`. This module reads them and answers three questions:
 * - `responseProblems`: is this an answer the fixtures say this route gives? A status its error code
 *   allows, `retryable` as catalogued, a code this route answers, and the same fields — nothing missing
 *   that every example has, nothing that no example has.
 * - `requestProblems`: does this request carry what the route needs — credential, session token,
 *   lease, `Idempotency-Key` — with a body made only of fields the fixtures' requests use?
 * - `frameProblems`: is this event-stream frame one `event-stream.json` describes?
 *
 * **How "the same fields" is judged.** The fixtures are examples, not a schema, so a value is compared
 * with every example of it at the same place: a field is allowed when any example has it, and required
 * when all of them do; its JSON type must match an example's; null matches anything, because the
 * fixtures show both for the same field; an unfixed body (`$unfixed`) matches anything. Examples are
 * narrowed by `kind`, `type` and `code` when one matches, so a file-change request is held to the
 * file-change example and an error's details to that error's.
 *
 * Test support only.
 */

import type { IncomingHttpHeaders } from 'http';
import * as fs from 'fs';
import * as path from 'path';

export const FIXTURES_DIR = path.join(findRepoRoot(__dirname), 'src', 'test', 'fixtures');

export interface FixtureRequest {
  caller: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface FixtureFrame {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

export interface FixtureExample {
  name: string;
  request: FixtureRequest;
  response: { status: number; body: unknown; frames?: FixtureFrame[] };
}

export interface FixtureRoute {
  /** `METHOD /path/{param}`, without the query the fixtures sometimes show. */
  key: string;
  method: string;
  template: string;
  needs: string[];
  examples: FixtureExample[];
  pattern: RegExp;
}

export const EVENTS_ROUTE = 'GET /api/v1/agent-sessions/{sid}/events';

const parsed = new Map<string, any>();

/** A fixture file — a name in `relay-contract/`, or `lock-rule-cases.json` — as a fresh copy. */
export function fixture<T = any>(name: string): T {
  return structuredClone(raw(name)) as T;
}

/** The relay and lock routes the fixtures describe, the event stream included. */
export function contractRoutes(): FixtureRoute[] {
  if (!parsed.has('routes')) {
    const stream = raw('event-stream.json');
    parsed.set('routes', [
      ...raw('agent-sessions.json').routes.map(routeFrom),
      ...raw('project-locks.json').routes.map(routeFrom),
      routeFrom({ ...stream.route, examples: stream.examples }),
    ]);
  }
  return parsed.get('routes');
}

export function matchRoute(method: string, pathname: string): FixtureRoute | undefined {
  return contractRoutes().find((route) => route.method === method && route.pattern.test(pathname));
}

export function routeByKey(key: string): FixtureRoute {
  const route = contractRoutes().find((candidate) => candidate.key === key);
  if (!route) throw new Error(`no route ${key} in the fixtures`);
  return route;
}

export function exampleNamed(key: string, name: string): FixtureExample {
  const example = routeByKey(key).examples.find((candidate) => candidate.name === name);
  if (!example) throw new Error(`no example "${name}" for ${key}`);
  return structuredClone(example);
}

export function errorCatalogue(): Record<string, { status: number[]; retryable: boolean; where: string }> {
  return raw('conventions.json').error_codes;
}

/** The routes that require an `Idempotency-Key`, by route key. */
export function idempotentRoutes(): Set<string> {
  return new Set(raw('conventions.json').headers['Idempotency-Key'].required_on as string[]);
}

/** The message the fixtures give an error code, from the first example that has it. */
export function fixtureMessage(code: string): string {
  const example = examplesWithCode(code)[0];
  if (!example) throw new Error(`no example answers ${code}`);
  return (example.response.body as { error: { message: string } }).error.message;
}

export function responseProblems(method: string, pathname: string, status: number, body: unknown): string[] {
  const route = matchRoute(method, pathname);
  if (!route) return [`${method} ${pathname}: no such route in the fixtures`];
  const error = errorIn(body);
  return error ? errorProblems(route, status, error, body) : successProblems(route, status, body);
}

export function requestProblems(route: FixtureRoute, pathname: string, headers: IncomingHttpHeaders, body: unknown): string[] {
  const problems = headerProblems(route, pathname, headers);
  if (body === undefined) return problems;
  if (!header(headers, 'content-type')?.startsWith('application/json')) problems.push(`${route.key}: a body without application/json`);
  const bodies = route.examples.map((example) => example.request.body).filter((example) => example !== undefined);
  return [...problems, ...shapeProblems(body, bodies, `${route.key} request body`, false)];
}

export function frameProblems(event: string, data: unknown): string[] {
  const examples = streamExamples().get(event);
  if (!examples) return [`event ${event}: not in event-stream.json`];
  return shapeProblems(data, examples, `event ${event}`, true);
}

/** Compares `actual` with every example of it (see the module comment for the rules). */
export function shapeProblems(actual: unknown, examples: unknown[], where: string, requireKeys: boolean): string[] {
  const known = examples.filter((example) => example !== null && example !== undefined);
  if (actual === null || known.length === 0 || known.some(isUnfixed)) return [];
  const kind = jsonKind(actual);
  const alike = known.filter((example) => jsonKind(example) === kind);
  if (alike.length === 0) return [`${where} is ${kind}; the fixtures have ${[...new Set(known.map(jsonKind))].join(' or ')}`];
  if (kind === 'array') return arrayProblems(actual as unknown[], alike as unknown[][], where, requireKeys);
  if (kind !== 'object') return [];
  const objects = narrow(actual as Record<string, unknown>, alike as Record<string, unknown>[]);
  return objectProblems(actual as Record<string, unknown>, objects, where, requireKeys);
}

function successProblems(route: FixtureRoute, status: number, body: unknown): string[] {
  const examples = route.examples.filter((example) => example.response.status === status && !errorIn(example.response.body));
  if (examples.length === 0) return [`${route.key}: the fixtures never answer ${status} without an error`];
  return shapeProblems(body, examples.map((example) => example.response.body), `${route.key} ${status}`, true);
}

function errorProblems(route: FixtureRoute, status: number, error: { code: string; retryable?: unknown }, body: unknown): string[] {
  const entry = errorCatalogue()[error.code];
  if (!entry) return [`${route.key}: ${error.code} is not in the error catalogue`];
  const problems: string[] = [];
  if (!entry.status.includes(status)) problems.push(`${route.key}: ${error.code} with ${status}; the catalogue says ${entry.status.join(' or ')}`);
  if (error.retryable !== entry.retryable) problems.push(`${route.key}: ${error.code} retryable ${String(error.retryable)}; the catalogue says ${entry.retryable}`);
  const own = route.examples.filter((example) => errorIn(example.response.body)?.code === error.code);
  if (own.length === 0 && !crossCutting(route, error.code)) problems.push(`${route.key}: the fixtures never answer ${error.code} here`);
  const examples = own.length > 0 ? own : examplesWithCode(error.code);
  return [...problems, ...shapeProblems(body, examples.map((example) => example.response.body), `${route.key} ${error.code}`, true)];
}

/** Codes the conventions apply to whole families of routes, so no route lists them all. */
function crossCutting(route: FixtureRoute, code: string): boolean {
  if (code === 'AGENT_CLIENT_NOT_ALLOWED') return true;
  if (code === 'AGENT_SESSION_NOT_FOUND') return route.template.includes('{sid}');
  if (code === 'IDEMPOTENCY_KEY_REQUIRED' || code === 'IDEMPOTENCY_KEY_REUSED') return idempotentRoutes().has(route.key);
  return false;
}

/** The headers a request carried that the rules below look at. */
interface Carried {
  credential: string | undefined;
  key: string | undefined;
  token: string | undefined;
  lease: string | undefined;
  /** The request id in an answer's path. */
  requestId: string | undefined;
}

/** What each route's `needs` asks of a request: [the route needs it, the request breaks it, the problem]. */
const HEADER_RULES: [(route: FixtureRoute) => boolean, (carried: Carried) => boolean, string][] = [
  [() => true, (carried) => !/^Bearer \S+$/.test(carried.credential ?? ''), 'no client credential'],
  [(route) => idempotentRoutes().has(route.key), (carried) => !validKey(carried.key), 'no valid Idempotency-Key'],
  [
    (route) => needs(route, 'Idempotency-Key: <rid>:<window_id>'),
    (carried) => !carried.key?.startsWith(`${carried.requestId}:`),
    'the answer key is not <rid>:<window_id>',
  ],
  [(route) => route.needs.includes('session token'), (carried) => !carried.token, 'no session token'],
  [(route) => route.needs.includes('client credential, no token'), (carried) => carried.token !== undefined, 'a session token where none belongs'],
  [(route) => route.needs.includes('X-Lock-Lease'), (carried) => !carried.lease, 'no lease'],
  [(route) => route.needs.includes('no lease'), (carried) => carried.lease !== undefined, 'a lease where none belongs'],
  [(route) => needs(route, 'X-Lock-Lease, or'), (carried) => !carried.lease && !carried.token, 'neither a lease nor a session token'],
];

function headerProblems(route: FixtureRoute, pathname: string, headers: IncomingHttpHeaders): string[] {
  const carried: Carried = {
    credential: header(headers, 'authorization'),
    key: header(headers, 'idempotency-key'),
    token: header(headers, 'x-agent-session-token'),
    lease: header(headers, 'x-lock-lease'),
    requestId: pathname.split('/')[6],
  };
  return HEADER_RULES.filter(([applies, broken]) => applies(route) && broken(carried)).map(([, , problem]) => `${route.key}: ${problem}`);
}

function needs(route: FixtureRoute, prefix: string): boolean {
  return route.needs.some((entry) => entry.startsWith(prefix));
}

function arrayProblems(actual: unknown[], examples: unknown[][], where: string, requireKeys: boolean): string[] {
  const items = examples.flat();
  if (items.length === 0) return [];
  return actual.flatMap((item, index) => shapeProblems(item, items, `${where}[${index}]`, requireKeys));
}

function objectProblems(actual: Record<string, unknown>, examples: Record<string, unknown>[], where: string, requireKeys: boolean): string[] {
  const problems: string[] = [];
  const known = new Set(examples.flatMap((example) => Object.keys(example)));
  for (const [key, value] of Object.entries(actual)) {
    if (!known.has(key)) {
      problems.push(`${where}.${key}: not in the fixtures`);
      continue;
    }
    const candidates = examples.filter((example) => key in example).map((example) => example[key]);
    problems.push(...shapeProblems(value, [...candidates, ...library(key)], `${where}.${key}`, requireKeys));
  }
  if (!requireKeys) return problems;
  for (const key of known) {
    if (examples.every((example) => key in example) && !(key in actual)) problems.push(`${where}.${key}: missing`);
  }
  return problems;
}

/** Keeps the examples of the same kind, type or error code as `actual`, when any match. */
function narrow(actual: Record<string, unknown>, examples: Record<string, unknown>[]): Record<string, unknown>[] {
  for (const discriminator of ['kind', 'type', 'code']) {
    const value = actual[discriminator];
    const same = examples.filter((example) => typeof value === 'string' && example[discriminator] === value);
    if (same.length > 0) return same;
  }
  return examples;
}

/** Examples the fixtures keep outside the routes: the four request kinds, and the normalised items. */
function library(key: string): unknown[] {
  if (key === 'pending_requests') return [raw('agent-sessions.json').request_view_examples];
  if (key === 'request') return raw('agent-sessions.json').request_view_examples;
  if (key === 'item') return Object.values(raw('event-stream.json').normalised_items);
  return [];
}

function streamExamples(): Map<string, unknown[]> {
  if (!parsed.has('frames')) {
    const stream = raw('event-stream.json');
    const byEvent = new Map<string, unknown[]>();
    for (const entry of stream.events) byEvent.set(entry.event, [entry.example_data]);
    for (const example of stream.examples as FixtureExample[]) {
      for (const frame of example.response.frames ?? []) byEvent.get(frame.event)?.push(frame.data);
    }
    parsed.set('frames', byEvent);
  }
  return parsed.get('frames');
}

function examplesWithCode(code: string): FixtureExample[] {
  return contractRoutes()
    .flatMap((route) => route.examples)
    .filter((example) => errorIn(example.response.body)?.code === code);
}

function routeFrom(route: { method: string; path: string; needs: string[] | string; examples: FixtureExample[] }): FixtureRoute {
  const template = route.path.split('?')[0];
  const segments = template.split('/').map((segment) => (/^\{\w+\}$/.test(segment) ? '([^/]+)' : segment.replace(/[.*+?^$()|[\]\\]/g, '\\$&')));
  return {
    key: `${route.method} ${template}`,
    method: route.method,
    template,
    needs: Array.isArray(route.needs) ? route.needs : [route.needs],
    examples: route.examples,
    pattern: new RegExp(`^${segments.join('/')}$`),
  };
}

function errorIn(body: unknown): { code: string; retryable?: unknown } | undefined {
  const error = isRecord(body) ? body.error : undefined;
  return isRecord(error) && typeof error.code === 'string' ? (error as { code: string; retryable?: unknown }) : undefined;
}

function raw(name: string): any {
  if (!parsed.has(name)) {
    const folder = name === 'lock-rule-cases.json' ? FIXTURES_DIR : path.join(FIXTURES_DIR, 'relay-contract');
    parsed.set(name, JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')));
  }
  return parsed.get(name);
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function validKey(key: string | undefined): boolean {
  return key !== undefined && /^[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?$/.test(key);
}

function isUnfixed(value: unknown): boolean {
  return isRecord(value) && '$unfixed' in value;
}

function jsonKind(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findRepoRoot(start: string): string {
  for (let current = start; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    if (path.dirname(current) === current) throw new Error(`no package.json above ${start}`);
  }
}
