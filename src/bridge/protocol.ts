/**
 * The MEP bodies the Bridge publishes, and nothing that speaks HTTP.
 *
 * Split from the server so the shapes can be tested without binding a port, and
 * because these are the parts a peer parses: `ECOSYSTEM_RUNBOOK.md` §4.1 fixes
 * the field names, and NERVIS's probe (`nervis/src/nervis/probes.py`) reads them
 * positionally by key. A field renamed here is a field NERVIS silently reports
 * as empty, so this file's job is to match a document rather than to be pretty.
 */

import type { ActivitySnapshot } from './activity';
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
  'clarvis.events@1': {
    version: '1.0.0',
    state: 'available',
    reason: '',
  },
  'clarvis.diagnostics.summary@1': {
    version: '1.0.0',
    state: 'unavailable',
    reason: 'not built; the Bridge publishes status and events only',
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
};

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
export function statusBody(snapshot: ActivitySnapshot, now: string): unknown {
  return { ...snapshot, observed_at: now };
}

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
