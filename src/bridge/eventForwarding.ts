/**
 * Sending Clarvis's own events to NERVIS's hub, so a trace has a caller in it.
 *
 * **Why this exists.** §11.2's waterfall joins events from every service on one
 * `trace_id`. Clarvis emitted the right families all along — `clarvis.chat.started`,
 * `clarvis.agent.completed` and the rest — into its *own* stream, which nothing
 * reads. RAVIS and SIRVIS instead POST to NERVIS, and NERVIS's hub duly held
 * events from three services and none from Clarvis.
 *
 * Observed on the first live walk of §8's scenario 4: every assembled trace
 * carried *"RAVIS appears with no calling service recorded — the caller either
 * does not publish events or its span was lost"*. The first half was true.
 *
 * **Best-effort, and silent about it.** The Bridge is optional and NERVIS may be
 * absent, restarting, or refusing; a chat turn must not slow down or fail because
 * a telemetry hub is unreachable. Nothing here is awaited by the work it
 * describes, and a failure is dropped rather than retried — the hub is
 * operational telemetry, not the system of record (§11.1), so a lost event costs
 * a bar in a diagram.
 */

/** Long enough for a loopback POST, short enough never to be noticed. */
const PUBLISH_TIMEOUT_MS = 1_500;

const EVENTS_PATH = '/api/v1/events';

export interface ForwardedEvent {
  readonly name: string;
  readonly data: Record<string, unknown>;
  /** The operation this belongs to, or '' when it belongs to none. */
  readonly traceId: string;
}

/**
 * What NERVIS needs to attribute an event, and nothing more.
 *
 * `trace_id` is at the top level rather than inside `data` because that is where
 * the hub joins on it — inside `data` it is an opaque field and the waterfall
 * never sees it.
 */
export function eventBody(event: ForwardedEvent): Record<string, unknown> {
  const body: Record<string, unknown> = {
    event_type: event.name,
    severity: 'info',
    data: event.data,
  };
  if (event.traceId) body.trace_id = event.traceId;
  return body;
}

/**
 * Post one event, reporting whether it landed.
 *
 * Returns rather than throws for the same reason `registration.ts` does: the
 * caller is a fire-and-forget observer, and an unhandled rejection from
 * telemetry would take out the thing being observed.
 */
export async function forwardEvent(
  nervisUrl: string,
  token: string,
  event: ForwardedEvent,
  send: typeof fetch = fetch
): Promise<boolean> {
  if (!token) return false; // Not registered: there is nowhere to send it.
  try {
    const response = await send(nervisUrl + EVENTS_PATH, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventBody(event)),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
