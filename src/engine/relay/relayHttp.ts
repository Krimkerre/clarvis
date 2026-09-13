/**
 * The one place Clarvis sends a request to RAVIS's relay (plan.md M15, C1).
 *
 * **The credential goes to this Mac's RAVIS and nowhere else.** A `RelayHttp` is built only from a
 * `RelayEndpoint`, and `relayEndpoint` refuses any address that isn't loopback — the rule
 * `src/model/ravisCredential.ts` already applies to model calls. A request whose URL would leave that
 * origin throws before anything is sent, so no path a caller builds can carry the credential away.
 *
 * **What every request carries** (`conventions.json`): the client credential as a bearer token, and
 * JSON bodies as `application/json`; where the route needs them, the session token
 * (`X-Agent-Session-Token`), the lock lease (`X-Lock-Lease`) and the `Idempotency-Key`.
 *
 * **Retries resend the same request.** A call with a `retry` policy is sent again, unchanged, only
 * after `unreachable`. Because the key is part of the request, RAVIS answers a retry of work it already
 * did with its original result rather than doing it twice. Any answer RAVIS actually gave — an error
 * included — is final here; whether to try again is the caller's decision.
 *
 * **Timeouts.** An action gets 10 s for the whole exchange. A stream gets 10 s to answer with its
 * headers and no limit after that: silence on an open stream is `sseReader.ts`'s to judge.
 */

import { isIdempotencyKey } from './idempotency';
import { failureFromNetworkError, failureFromResponse, type RelayOutcome } from './relayFailure';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const ACTION_TIMEOUT_MS = 10_000;
export const STREAM_CONNECT_TIMEOUT_MS = 10_000;

/** A loopback RAVIS and the credential to present to it. Build one with `relayEndpoint`. */
export interface RelayEndpoint {
  readonly origin: string;
  readonly credential: string;
}

export type EndpointResult =
  | { ok: true; endpoint: RelayEndpoint }
  | { ok: false; reason: 'invalid_url' | 'not_loopback' | 'no_credential' };

/** Where the relay is, or why there is no relay to talk to. */
export function relayEndpoint(baseUrl: string, credential: string | undefined): EndpointResult {
  const url = parseHttpUrl(baseUrl);
  if (!url) return { ok: false, reason: 'invalid_url' };
  if (!LOOPBACK.has(url.hostname)) return { ok: false, reason: 'not_loopback' };
  const secret = (credential ?? '').trim();
  if (secret === '') return { ok: false, reason: 'no_credential' };
  return { ok: true, endpoint: Object.freeze({ origin: url.origin, credential: secret }) };
}

/** Whether `baseUrl` is an http(s) address on this Mac: the only place the credential, or Codex, goes. */
export function isLoopbackUrl(baseUrl: string): boolean {
  const url = parseHttpUrl(baseUrl);
  return url !== undefined && LOOPBACK.has(url.hostname);
}

export interface RelayRequest {
  method: 'GET' | 'POST' | 'DELETE';
  /** An absolute path on RAVIS, e.g. `/api/v1/agent-sessions`. */
  path: string;
  query?: Record<string, string | number | null | undefined>;
  body?: unknown;
  token?: string;
  lease?: string;
  idempotencyKey?: string;
  /** Anything else, such as `Last-Event-ID`. Can't replace the credential. */
  headers?: Record<string, string>;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Resend after `unreachable`, up to `attempts` sends in all, `delayMs` apart. */
  retry?: { attempts: number; delayMs: number };
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export class RelayHttp {
  constructor(
    readonly endpoint: RelayEndpoint,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: Sleep = abortableSleep
  ) {}

  /** Sends an action and reads its JSON answer. A 2xx with no body is `null`. */
  async send<T>(request: RelayRequest, options: CallOptions = {}): Promise<RelayOutcome<T>> {
    const { attempts, delayMs } = retryOf(options);
    let outcome = await this.exchange<T>(request, options);
    for (let sent = 1; sent < attempts && isUnreachable(outcome); sent++) {
      await this.sleep(delayMs, options.signal);
      outcome = await this.exchange<T>(request, options);
    }
    return outcome;
  }

  /** Opens a streaming GET, handing the response back once its headers arrive and say it is a stream. */
  async open(
    request: RelayRequest,
    signal: AbortSignal,
    connectTimeoutMs: number = STREAM_CONNECT_TIMEOUT_MS
  ): Promise<RelayOutcome<Response>> {
    const url = this.url(request);
    const connecting = new AbortController();
    const timer = setTimeout(() => connecting.abort(), connectTimeoutMs);
    const init = this.init(request, AbortSignal.any([signal, connecting.signal]), 'text/event-stream');
    try {
      const response = await this.fetchImpl(url, init);
      if (!response.ok) return failed(response.status, await response.text(), response.headers.get('retry-after'));
      return isEventStream(response) ? { ok: true, status: response.status, value: response } : notAStream(response);
    } catch (error) {
      return { ok: false, failure: failureFromNetworkError(error, signal.aborted) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The request's full URL. Throws for a path that would leave RAVIS's origin. */
  url(request: Pick<RelayRequest, 'path' | 'query'>): string {
    const url = new URL(request.path, this.endpoint.origin);
    if (!request.path.startsWith('/') || url.origin !== this.endpoint.origin) {
      throw new TypeError(`${request.path} is not a path on RAVIS`);
    }
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }
    return url.toString();
  }

  private async exchange<T>(request: RelayRequest, options: CallOptions): Promise<RelayOutcome<T>> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? ACTION_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    // Built outside the try: a bad path or key is a bug to throw, not RAVIS being unreachable.
    const url = this.url(request);
    const init = this.init(request, signal, 'application/json');
    try {
      const response = await this.fetchImpl(url, init);
      return interpret<T>(response.status, await response.text(), response.headers.get('retry-after'));
    } catch (error) {
      return { ok: false, failure: failureFromNetworkError(error, options.signal?.aborted === true) };
    }
  }

  private init(request: RelayRequest, signal: AbortSignal, accept: string): RequestInit {
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    return { method: request.method, headers: this.headers(request, accept), body, signal };
  }

  private headers(request: RelayRequest, accept: string): Record<string, string> {
    // Spread first, so nothing a caller passes can replace the credential.
    const headers: Record<string, string> = {
      ...request.headers,
      Authorization: `Bearer ${this.endpoint.credential}`,
      Accept: accept,
    };
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';
    if (request.token !== undefined) headers['X-Agent-Session-Token'] = request.token;
    if (request.lease !== undefined) headers['X-Lock-Lease'] = request.lease;
    if (request.idempotencyKey === undefined) return headers;
    if (!isIdempotencyKey(request.idempotencyKey)) throw new TypeError('not a valid Idempotency-Key');
    return { ...headers, 'Idempotency-Key': request.idempotencyKey };
  }
}

/** A sleep that ends early, without throwing, when `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function interpret<T>(status: number, text: string, retryAfter: string | null): RelayOutcome<T> {
  if (status < 200 || status >= 300) return failed(status, text, retryAfter);
  if (text.trim() === '') return { ok: true, status, value: null as T };
  const body = parseJson(text);
  if (body.parsed) return { ok: true, status, value: body.value as T };
  return { ok: false, failure: { kind: 'malformed', status, detail: 'the body is not JSON' } };
}

function failed(status: number, text: string, retryAfter: string | null): { ok: false; failure: ReturnType<typeof failureFromResponse> } {
  return { ok: false, failure: failureFromResponse(status, parseJson(text).value, retryAfter) };
}

function parseJson(text: string): { parsed: boolean; value: unknown } {
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false, value: undefined };
  }
}

function isEventStream(response: Response): boolean {
  const type = response.headers.get('content-type') ?? '';
  return type.includes('text/event-stream') && response.body !== null;
}

function notAStream(response: Response): RelayOutcome<Response> {
  void response.body?.cancel();
  return { ok: false, failure: { kind: 'malformed', status: response.status, detail: 'not an event stream' } };
}

function isUnreachable(outcome: RelayOutcome<unknown>): boolean {
  return !outcome.ok && outcome.failure.kind === 'unreachable';
}

function retryOf(options: CallOptions): { attempts: number; delayMs: number } {
  const retry = options.retry ?? { attempts: 1, delayMs: 0 };
  return { attempts: Math.max(1, retry.attempts), delayMs: Math.max(0, retry.delayMs) };
}

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
