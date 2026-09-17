/**
 * Telling NERVIS this window exists, and keeping the lease alive.
 *
 * `vscode`-free, so a test can stand up a fake NERVIS on a real port and check
 * what actually goes over the wire — which matters more here than anywhere else
 * in `src/bridge/`, because the receiving half already shipped and this has to
 * match it rather than to be reasonable.
 *
 * **Two credentials, and they are not interchangeable.** Registration presents
 * the *enrolment secret* — a `0600` file beside NERVIS's database, whose
 * permissions are the whole authentication (`nervis/src/nervis/enrollment.py`).
 * Everything afterwards presents the *instance token* NERVIS returns, which
 * renews this one instance and can do nothing else. Keeping them apart is what
 * stops a leaked heartbeat token being a registration capability.
 *
 * **Nothing here can fail editor work.** Every call returns an outcome rather
 * than throwing, and the caller logs it. A dashboard that is not running is the
 * ordinary case, not an error worth interrupting anybody over.
 */

/** What NERVIS's allowlist accepts. Anything else is dropped with a log line at its end. */
export interface Claim {
  readonly service: 'clarvis';
  readonly instance_id: string;
  readonly machine_id: string;
  /**
   * A port, not a URL. NERVIS builds the endpoint itself — letting a registrant
   * supply one would hand it the SSRF primitive its endpoint guard exists to
   * deny — so sending a full address here would simply be ignored.
   */
  readonly port: number;
  /**
   * The extension version, so NERVIS can hold this Bridge to §12's peer window.
   *
   * Every other peer states one on `/ecosystem/identity`; an extension host has
   * no such surface for NERVIS to probe, so it arrives in the claim. NERVIS's
   * allowlist accepts it as a version string and judges it — it is never used
   * to look anything up.
   */
  readonly build_version: string;
  readonly api_version: string;
  readonly protocol_version: string;
  /** Flattened to `id -> version`, which is the only shape NERVIS keeps. */
  readonly capabilities: Readonly<Record<string, string>>;
}

export interface Registered {
  readonly ok: true;
  /** Returned once and never readable back out of the API. Lost means re-register. */
  readonly token: string;
  readonly leaseSeconds: number;
}

export interface Refused {
  readonly ok: false;
  /** Why, in words a log line can carry. Never a credential. */
  readonly detail: string;
}

export type RegistrationOutcome = Registered | Refused;

/**
 * How long any single call to NERVIS is waited for.
 *
 * Short, and it is a deadline rather than a retry budget: this runs during
 * activation and while an editor is being used, and §6.5 says telemetry must
 * never delay editor work. A NERVIS that is slow is treated exactly like a
 * NERVIS that is absent, because from here they are the same thing.
 */
export const CALL_TIMEOUT_MS = 2_000;

const REGISTRY = '/api/v1/registry/instances';

/** A JSON call to NERVIS that reports rather than throws. */
async function call(
  url: string,
  method: string,
  bearer: string,
  body?: unknown
): Promise<{ status: number; body: any } | { failure: string }> {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A fresh deadline per call — never a module constant, which would be a
      // signal that expired shortly after load and aborted every later call.
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  } catch (failure) {
    return { failure: failure instanceof Error ? failure.message : String(failure) };
  }
}

/**
 * The message from a refusal, without letting a NERVIS response decide what a
 * Clarvis log line says.
 *
 * §11.5's rule read the other way round: retrieved content is data, never
 * intent. NERVIS is a peer rather than a model, but the reason for bounding this
 * is the same — a remote string reaching a log verbatim is a remote string
 * choosing what a log looks like.
 */
function refusalDetail(status: number, body: any): string {
  const message = typeof body?.error?.message === 'string' ? body.error.message : '';
  return `${status}${message ? `: ${message.slice(0, 200)}` : ''}`;
}

/**
 * Register this instance and take the token back.
 *
 * A refusal is a normal outcome, and two of them are worth telling apart in a
 * log: the enrolment secret being wrong means the setting points at the wrong
 * file, and an `instance_id` already held by a live instance means this window
 * is trying to claim another's identity — which should be impossible, since the
 * ID is minted per extension host, and is therefore worth seeing.
 */
export async function register(
  nervisUrl: string,
  enrollmentSecret: string,
  claim: Claim
): Promise<RegistrationOutcome> {
  const result = await call(nervisUrl + REGISTRY, 'POST', enrollmentSecret, claim);
  if ('failure' in result) return { ok: false, detail: `could not reach NERVIS (${result.failure})` };
  if (result.status !== 201) return { ok: false, detail: refusalDetail(result.status, result.body) };

  const token = typeof result.body?.token === 'string' ? result.body.token : '';
  if (!token) {
    // Registered without a usable token is worse than refused: the Bridge would
    // be listed by NERVIS and unreadable by it, and nothing would say why.
    return { ok: false, detail: 'NERVIS accepted the registration but returned no token' };
  }
  return {
    ok: true,
    token,
    leaseSeconds: Number(result.body?.lease_seconds) || 0,
  };
}

/** Extend the lease. Presents the instance token, never the enrolment secret. */
export async function heartbeat(
  nervisUrl: string,
  token: string,
  instanceId: string
): Promise<RegistrationOutcome> {
  const url = `${nervisUrl}${REGISTRY}/clarvis/${encodeURIComponent(instanceId)}/heartbeat`;
  const result = await call(url, 'POST', token);
  if ('failure' in result) return { ok: false, detail: `could not reach NERVIS (${result.failure})` };
  if (result.status !== 200) return { ok: false, detail: refusalDetail(result.status, result.body) };
  return { ok: true, token, leaseSeconds: 0 };
}

/**
 * Say this window is going, rather than letting the lease run out.
 *
 * **Best-effort by design, not by neglect.** `deactivate()` waits for it
 * (`BridgeSlot`), but a host that crashes never sends it, so this is an
 * optimisation on top of NERVIS's 45-second lease and never the
 * mechanism. Building it as the mechanism would mean a crashed window stayed
 * listed forever.
 */
export async function deregister(
  nervisUrl: string,
  token: string,
  instanceId: string
): Promise<RegistrationOutcome> {
  const url = `${nervisUrl}${REGISTRY}/clarvis/${encodeURIComponent(instanceId)}`;
  const result = await call(url, 'DELETE', token);
  if ('failure' in result) return { ok: false, detail: `could not reach NERVIS (${result.failure})` };
  if (result.status !== 204) return { ok: false, detail: refusalDetail(result.status, result.body) };
  return { ok: true, token, leaseSeconds: 0 };
}

/**
 * How often to renew, given the lease NERVIS granted.
 *
 * A third of the lease, so two heartbeats can be lost — to a suspended laptop, a
 * busy event loop, a NERVIS restart — before the instance is dropped. Renewing
 * at the lease boundary means any single missed beat is an expiry, and renewing
 * far more often is a timer firing for nothing.
 *
 * Floored rather than trusted: a NERVIS that answered with `0`, or a response
 * without the field, would otherwise produce an interval of zero and a heartbeat
 * every tick.
 */
export function heartbeatInterval(leaseSeconds: number): number {
  const lease = leaseSeconds > 0 ? leaseSeconds : 45;
  return Math.max(5_000, Math.floor((lease / 3) * 1000));
}
