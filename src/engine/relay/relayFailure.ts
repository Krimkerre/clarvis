/**
 * Every way a call to RAVIS's relay can fail, as one typed value (plan.md M15, C1).
 *
 * **Why the kinds are kept apart.** The owner's handoff for the Codex engine names the confusions to
 * avoid: an allowance that ran out is not throttling, throttling is not being signed out, a Codex
 * version that needs re-testing is not any of those, and none of them is RAVIS not answering. Each
 * leads somewhere different — wait for the reset, try again shortly, sign in on the dashboard,
 * re-test from the menu bar, or say RAVIS is down — so each is its own `kind` here, and the tests
 * hold them apart. A failure the contract doesn't single out stays `refused`, with RAVIS's code and
 * details untouched, for the caller to read.
 *
 * **Where the states come from.** RAVIS refuses a new session or turn with `409 CODEX_NOT_READY`,
 * whose `details.state` is one of `GET /api/v1/codex`'s states (`codex-state.json`). A bare HTTP 429
 * is throttling, never the allowance (design §9: quota is "not inferred from a bare 429").
 *
 * Pure: no network, no clock.
 */

/** The MEP error envelope RAVIS's management API answers with (runbook §4.5). */
export interface ErrorEnvelope {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

export type RelayFailure =
  /** No answer: connection refused, reset, or the timeout ran out. */
  | { kind: 'unreachable'; detail: string }
  /** The caller gave up (a Stop, a closed stream). Never reported as RAVIS being down. */
  | { kind: 'cancelled' }
  /** HTTP 429: too many requests for now. Never the allowance. */
  | { kind: 'throttled'; code: string | null; retryAfterSeconds: number | null }
  /** The ChatGPT plan's allowance is used up (`CODEX_NOT_READY`, state `quota_exhausted`). */
  | { kind: 'quota_exhausted'; reason: string }
  /** Codex is signed out, or its sign-in expired (`signed_out`, `sign_in_expired`). */
  | { kind: 'signed_out'; expired: boolean; reason: string }
  /** The installed Codex needs re-testing, or its file rules aren't proven for it (`untested_version`). */
  | { kind: 'untested_version'; fileRulesUnproven: boolean; reason: string }
  /** Any other state that refuses work: a changed account, the process restarting, not installed. */
  | { kind: 'codex_not_ready'; state: string; reason: string }
  /** `503 CODEX_RUNTIME_UNAVAILABLE`: RAVIS answered, its Codex process didn't. */
  | { kind: 'runtime_unavailable'; message: string }
  /** Any other error RAVIS answered with. `code` is null when the body wasn't an envelope. */
  | {
      kind: 'refused';
      status: number;
      code: string | null;
      message: string;
      retryable: boolean;
      details: Record<string, unknown>;
    }
  /** A success status whose body isn't what the contract says. */
  | { kind: 'malformed'; status: number; detail: string };

/** A relay call's result: the parsed body on success, a typed failure otherwise. */
export type RelayOutcome<T> = { ok: true; status: number; value: T } | { ok: false; failure: RelayFailure };

/** The envelope inside a body, when there is a well-formed one. */
export function readEnvelope(body: unknown): ErrorEnvelope | undefined {
  const error = isRecord(body) ? body.error : undefined;
  if (!isRecord(error)) return undefined;
  const { code, message, retryable, details } = error;
  if (typeof code !== 'string' || typeof message !== 'string') return undefined;
  if (typeof retryable !== 'boolean' || !isRecord(details)) return undefined;
  return { code, message, retryable, details };
}

/** Turns a non-2xx answer into a failure. `retryAfter` is the raw `Retry-After` header, if any. */
export function failureFromResponse(status: number, body: unknown, retryAfter: string | null): RelayFailure {
  const envelope = readEnvelope(body);
  if (status === 429) {
    return { kind: 'throttled', code: envelope?.code ?? null, retryAfterSeconds: parseRetryAfter(retryAfter) };
  }
  if (!envelope) {
    return { kind: 'refused', status, code: null, message: `HTTP ${status}`, retryable: status >= 500, details: {} };
  }
  if (envelope.code === 'CODEX_NOT_READY') return notReady(envelope.details);
  if (envelope.code === 'CODEX_RUNTIME_UNAVAILABLE') return { kind: 'runtime_unavailable', message: envelope.message };
  return { kind: 'refused', status, ...envelope };
}

/** Turns a thrown fetch error into a failure. `callerAborted` separates a Stop from a timeout. */
export function failureFromNetworkError(error: unknown, callerAborted: boolean): RelayFailure {
  if (callerAborted) return { kind: 'cancelled' };
  return { kind: 'unreachable', detail: networkDetail(error) };
}

/** True for an error a stream should reconnect after, rather than give up on. */
export function isTransient(failure: RelayFailure): boolean {
  if (failure.kind === 'refused') return failure.status >= 500;
  return TRANSIENT_KINDS.has(failure.kind);
}

const TRANSIENT_KINDS = new Set<RelayFailure['kind']>(['unreachable', 'throttled', 'runtime_unavailable', 'malformed']);

/**
 * The states `CODEX_NOT_READY` carries that get a kind of their own. `strict_file_rules_unproven` is
 * the fixed word the fixtures use for unproven file rules (`conventions.json` open_points); any other
 * reason is RAVIS's sentence and passes through as it is.
 */
const NOT_READY_KINDS: Record<string, (reason: string) => RelayFailure> = {
  quota_exhausted: (reason) => ({ kind: 'quota_exhausted', reason }),
  signed_out: (reason) => ({ kind: 'signed_out', expired: false, reason }),
  sign_in_expired: (reason) => ({ kind: 'signed_out', expired: true, reason }),
  untested_version: (reason) => ({
    kind: 'untested_version',
    fileRulesUnproven: reason === 'strict_file_rules_unproven',
    reason,
  }),
};

function notReady(details: Record<string, unknown>): RelayFailure {
  const state = typeof details.state === 'string' ? details.state : 'unknown';
  const reason = typeof details.reason === 'string' ? details.reason : '';
  return failureForCodexState(state, reason);
}

/**
 * The failure a Codex state stands for — from `409 CODEX_NOT_READY`, or read ahead of a start from
 * `GET /api/v1/codex` (`codexReadiness.ts`, C2a), so both say the same thing.
 */
export function failureForCodexState(state: string, reason: string): RelayFailure {
  // hasOwn, so a state named like an Object.prototype member can't reach a function that isn't ours.
  if (Object.hasOwn(NOT_READY_KINDS, state)) return NOT_READY_KINDS[state](reason);
  return { kind: 'codex_not_ready', state, reason };
}

/** Whole seconds only: the HTTP-date form is rare on loopback and not worth a parser. */
function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

/** The most specific thing Node says about a failed connection, e.g. `ECONNREFUSED` or `TimeoutError`. */
function networkDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  return error.name === 'Error' ? error.message : error.name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
