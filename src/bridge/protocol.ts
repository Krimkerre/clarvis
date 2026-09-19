/**
 * The MEP bodies the Bridge publishes, and nothing that speaks HTTP.
 *
 * Split from the server so the shapes can be tested without binding a port, and
 * because these are the parts a peer parses: `ECOSYSTEM_RUNBOOK.md` §4.1 fixes
 * the field names, and NERVIS's probe (`nervis/src/nervis/probes.py`) reads them
 * positionally by key. A field renamed here is a field NERVIS silently reports
 * as empty, so this file's job is to match a document rather than to be pretty.
 */

import type { ActivitySnapshot, StatusFacts } from './activity';
import type { Identity } from './identity';

/** The MEP version this Bridge speaks. Must match the ecosystem's `PROTOCOL_VERSION`. */
export const PROTOCOL_VERSION = '1.0.0';
export const COMPATIBLE_PROTOCOL_MIN = '1.0.0';
export const COMPATIBLE_PROTOCOL_MAX = '1.999.999';

/** This Bridge's own API version, which moves independently of the protocol. */
export const API_VERSION = '1';

/**
 * §4.1's three capability states.
 *
 * A capability Clarvis knows about is never simply left out of the list: the
 * runbook is explicit that an honest *"unavailable, because X"* tells a peer
 * when to look again and silence tells it nothing.
 */
export type CapabilityState = 'available' | 'unavailable' | 'degraded';

export interface Capability {
  readonly version: string;
  readonly state: CapabilityState;
  /** Required whenever the state is not `available`, and that is the point of it. */
  readonly reason: string;
  readonly constraints?: Readonly<Record<string, unknown>>;
}

/**
 * What §6.2 lists, with the truth about each one as this build stands.
 *
 * Written out rather than computed from what happens to be wired, because the
 * runbook's rule is *"do not advertise an operation unless that exact operation
 * passes conformance"* — and a list derived from the code would advertise
 * whatever got wired, which is the opposite test.
 *
 * There is deliberately no `clarvis.gates.approve` and no tool or command
 * capability. §6.7 forbids them, and the enforcement that survives someone
 * adding a feature without reading the specification is that no such route
 * exists to advertise.
 */
export const CAPABILITIES: Readonly<Record<string, Capability>> = {
  'clarvis.status.read@1': {
    version: '1.0.0',
    state: 'available',
    reason: '',
  },
  /**
   * **Published, and read by nobody.** The stream works — it heartbeats, replays
   * a backlog on reconnect, and carries the §6.4 families — but no consumer
   * exists: NERVIS's dashboard reads `/v1/status` per instance and has no
   * subscriber, and its event screen shows its own hub rather than this.
   *
   * §4.1 says do not advertise an operation unless that exact operation passes
   * conformance, and a capability nothing has ever consumed has not been through
   * one. Declaring it `available` claimed a working integration on the strength
   * of one working half. Marked honestly until something reads it.
   */
  'clarvis.events@1': {
    version: '1.0.0',
    state: 'degraded',
    reason:
      'the stream is served and conformant, but nothing subscribes to it yet — ' +
      'no consumer has exercised reconnect, replay or the event families end to end',
  },
  /**
   * **The read that exists so a write does not have to.** §6.7 forbids NERVIS
   * changing a setting, and the Bridge has no write path to extend — so the
   * useful half of "can NERVIS manage Clarvis" is answered by publishing the
   * configuration instead of accepting one. An allowlist, in `config.ts`,
   * carrying model names, providers, modes and booleans; never a path, never a
   * URL somebody typed, never anything from SecretStorage.
   */
  'clarvis.config.summary@1': {
    version: '1.0.0',
    state: 'available',
    reason: '',
  },
  /**
   * `GET /v1/diagnostics`: the editor's problems counted by severity and by checker, never a
   * file or a message (19 September 2026). Unavailable here because a Bridge with no problem
   * reader serves no such route; `Bridge.capabilities` swaps in `DIAGNOSTICS_AVAILABLE` for a
   * host that hands one over, which every editor window does.
   */
  'clarvis.diagnostics.summary@1': {
    version: '1.0.0',
    state: 'unavailable',
    reason: 'this host hands the Bridge no problem reader, so /v1/diagnostics is not served',
  },
  'clarvis.logs.reference@1': {
    version: '1.0.0',
    state: 'unavailable',
    reason:
      'log tailing exists but has no per-workspace approval step, and §6.8 requires ' +
      'a reference rather than content — ClarvisLog records full command strings, ' +
      'sensitive paths and tool arguments',
  },
  'clarvis.ravis_provider@1': {
    version: '1.0.0',
    state: 'unavailable',
    reason: 'the model layer has no RAVIS provider row; it speaks to providers directly',
  },
  /**
   * Not in §6.2's list, and added because Stage 9's exit clause requires it:
   * *"voice limitations are advertised through capabilities and do not block
   * core support"*. Nothing advertised voice at all, so that clause could not be
   * satisfied by any amount of testing — a capability that does not exist cannot
   * carry a limitation.
   *
   * It is `degraded` rather than `unavailable` on a remote host because the
   * distinction is the whole point: speech still happens, out of the wrong
   * machine's speakers. A peer that read `unavailable` would conclude Clarvis
   * had gone quiet, which is a different and less alarming thing than what
   * actually occurs.
   */
  'clarvis.voice@1': {
    version: '1.0.0',
    state: 'unavailable',
    reason: 'set at startup from the host and the user setting; see voiceCapability()',
  },
};


/** `clarvis.diagnostics.summary@1` where the host supplies a problem reader. */
export const DIAGNOSTICS_AVAILABLE: Capability = {
  version: '1.0.0',
  state: 'available',
  reason: '',
};

/**
 * What to say about voice on the host this window is actually running in.
 *
 * Three answers, and the middle one is why this exists — but **the reason for
 * the middle one changed on 30 August 2026 and the wording had to change with
 * it.** It used to say speech came out of the server's speakers, which was true
 * while playback was always a subprocess of the extension host. Tier 1 now sends
 * rendered audio to the webview wherever the workbench is a browser or the host
 * is remote (`voice/audioDestination.ts`), so that sentence would be a
 * capability advertising a defect that no longer exists.
 *
 * It stays `degraded` rather than becoming `available`, for a smaller and real
 * reason: playing through the webview needs the panel to be open, and browsers
 * refuse audio until the document has had a user gesture — so the first
 * utterance after a reload can be declined. §4.1's rule is that a capability
 * which is not `available` must say why, and this is the why.
 */
export function voiceCapability(
  enabled: boolean,
  remoteName: string | undefined,
  playsInWebview = Boolean(remoteName)
): Capability {
  if (!enabled) {
    return { version: '1.0.0', state: 'unavailable', reason: 'turned off in settings' };
  }
  if (playsInWebview) {
    return {
      version: '1.0.0',
      state: 'degraded',
      reason:
        'speech is played by the Clarvis panel rather than by the extension host, so it ' +
        'needs the panel open and one interaction with it before the first utterance — ' +
        'a browser will refuse audio until then',
      constraints: {
        plays_on: 'webview',
        ...(remoteName ? { remote: remoteName } : {}),
      },
    };
  }
  return { version: '1.0.0', state: 'available', reason: '' };
}

/** `clarvis.events@1` → `clarvis.events`. §4.1: the `@<major>` is never a wire value. */
export const wireIdentifier = (capabilityId: string): string => capabilityId.split('@', 1)[0];

/**
 * The `GET /ecosystem/capabilities` body.
 *
 * Sorted by declared id so two reads of an unchanged set are byte-identical,
 * which is what makes `revision` worth comparing at all. Sorted on the declared
 * key rather than the wire id, so `foo@1` stays ahead of `foo@2` — they share a
 * wire id and would otherwise order arbitrarily.
 */
export function capabilitiesBody(
  revision: number,
  declared: Readonly<Record<string, Capability>> = CAPABILITIES
): unknown {
  return {
    revision,
    capabilities: Object.keys(declared)
      .sort()
      .map((id) => ({
        id: wireIdentifier(id),
        version: declared[id].version,
        state: declared[id].state,
        constraints: { ...(declared[id].constraints ?? {}) },
        reason: declared[id].reason,
      })),
  };
}

/**
 * The `GET /ecosystem/health` body.
 *
 * `ready` is independently truthful: §4.1 says a successful TCP connect is not
 * readiness, so this reports what the Bridge has verified about itself and not
 * the fact that it managed to answer — which the response arriving already
 * proves.
 *
 * A Bridge that has not been given its token yet is **live but not ready**, and
 * that is a real state rather than a startup wrinkle: the token arrives in the
 * registration response, so between binding the port and completing
 * registration there is a real window in which every read will be refused. A
 * peer that saw `ready` there would conclude the refusals were a bug.
 */
export function healthBody(now: string, checks: readonly HealthCheck[]): unknown {
  const passed = checks.every((check) => check.status === 'pass');
  return {
    status: passed ? 'healthy' : 'degraded',
    live: true,
    ready: passed,
    checked_at: now,
    checks: checks.map((check) => ({ ...check })),
  };
}

export interface HealthCheck {
  readonly name: string;
  readonly status: 'pass' | 'fail';
  readonly detail: string;
}

/** The `GET /ecosystem/identity` body. Field names are NERVIS's probe's, exactly. */
export function identityBody(identity: Identity, startedAt: string): unknown {
  return {
    service_id: identity.service_id,
    service_type: identity.service_type,
    instance_id: identity.instance_id,
    machine_id: identity.machine_id,
    // §6.1's two extras. NERVIS's probe ignores them, which is fine — MEP lets a
    // service publish more than a given consumer reads, and the runbook's own
    // identity block names both.
    workspace_id: identity.workspace_id,
    host_kind: identity.host_kind,
    api_version: identity.api_version,
    protocol_version: identity.protocol_version,
    build_version: identity.build_version,
    started_at: startedAt,
  };
}

/**
 * The `GET /ecosystem/version` body.
 *
 * §4.1 requires this to answer even when `ready` is false — a peer diagnosing an
 * incompatibility needs it exactly when things are unwell — so it depends on
 * nothing that can be unwell.
 */
export function versionBody(buildVersion: string): unknown {
  return {
    build_version: buildVersion,
    api_version: API_VERSION,
    protocol_version: PROTOCOL_VERSION,
    schema_versions: { mep: PROTOCOL_VERSION },
    compatible_protocol: { min: COMPATIBLE_PROTOCOL_MIN, max: COMPATIBLE_PROTOCOL_MAX },
  };
}

/**
 * The `GET /v1/status` body — §6.3's interpreted state, and only that.
 *
 * A pass-through of the snapshot rather than a re-derivation: `activity.ts` has
 * already decided what may be said, and a second place that builds a status is a
 * second place that can decide differently. `undefined` fields are dropped by
 * `JSON.stringify` on the way out, which is how "unknown stays unknown" reaches
 * the wire — an absent field means nobody knows, and a `null` would be a value.
 */
export function statusBody(snapshot: StatusReport, now: string): unknown {
  return { ...snapshot, observed_at: now };
}

/**
 * The state and what is known beside it (§6.3), plus the newest event id — the cursor a reader resumes
 * the event stream from. `JSON.stringify` drops the facts nobody knows yet.
 */
export type StatusReport = ActivitySnapshot & StatusFacts & { readonly event_cursor?: number };

/**
 * §4.3's error envelope, which is the same shape all three sibling services
 * render. A consumer written against the document branches on `code`, so
 * answering with node's default body would give it nothing to branch on.
 */
export function errorBody(
  code: string,
  message: string,
  requestId: string,
  traceId: string
): unknown {
  return { error: { code, message, details: {}, request_id: requestId, trace_id: traceId } };
}

/** An RFC 3339 UTC timestamp, which is what every MEP field expects. */
export const timestamp = (moment: number): string =>
  new Date(moment).toISOString().replace(/\.\d{3}Z$/, 'Z');
