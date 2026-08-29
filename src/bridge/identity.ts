/**
 * Who this Clarvis is, in the terms `CLARVIS.md` §6.1 asks for.
 *
 * `vscode`-free like its neighbour, and for the same reason: the identity rules
 * are the kind that are wrong quietly. An ID that turns out to be derived from
 * hardware, or a workspace ID that turns out to be the same on two machines,
 * still looks like a working feature. Only a test catches those, and a test can
 * only reach code that does not import `vscode`.
 *
 * Everything here is generated locally and means nothing outside this
 * installation. That is deliberate and it is the whole design: §6.1 wants IDs
 * that let NERVIS tell two editor windows apart, and nothing else — not who the
 * user is, not which machine this is, not what they are working on.
 */

import { createHash, randomUUID } from 'crypto';

/** MEP's name for what Clarvis is. Never claimed dynamically — §5.1 forbids that. */
export const SERVICE_TYPE = 'clarvis';

/** The editors this build is prepared to name. Anything else is `other`, honestly. */
export type HostKind = 'vscode' | 'vscodium' | 'code-server' | 'other';

/**
 * The installation-scoped values, which live in `globalState` and outlive a
 * window. Kept together because they are written together the first time and
 * because losing one of them without the others produces a half-identity that is
 * worse than a fresh one.
 */
export interface StoredIdentity {
  /** Stable per installation. What makes two windows recognisably the same Clarvis. */
  readonly service_id: string;
  /**
   * Opaque, resettable, locally generated — and explicitly **not** derived from
   * hardware. A MAC address or a hostname digest would survive a reset and
   * survive reinstalling, which would make it an identifier for the machine
   * rather than for this installation of this extension. §6.1 rules that out in
   * as many words, so this is a random value and nothing else.
   */
  readonly machine_id: string;
  /**
   * The salt every workspace ID is hashed with.
   *
   * Without it a workspace ID is a hash of a path, and a hash of a path is a
   * *shared* identifier: the same repository checked out at the same location on
   * two machines would produce the same ID, which turns an opaque local
   * correlation key into a way to recognise a project across installations.
   * Never published, and never leaves this object.
   */
  readonly workspace_salt: string;
}

/** What the Bridge publishes at `/ecosystem/identity`. */
export interface Identity {
  readonly service_type: typeof SERVICE_TYPE;
  readonly service_id: string;
  /** Fresh for every extension host, so a reload is honestly a new instance (§6.6). */
  readonly instance_id: string;
  readonly machine_id: string;
  /**
   * Opaque and salted. Absent — not empty — when no folder is open, because "no
   * workspace" is a real state and §6.3 says unknown values stay unknown.
   */
  readonly workspace_id?: string;
  readonly host_kind: HostKind;
  readonly build_version: string;
  readonly api_version: string;
  readonly protocol_version: string;
}

/** Just enough of `vscode.Memento` to store the above, so this file imports nothing. */
export interface Storage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

/** One key, because the three values are only ever right together. */
export const IDENTITY_KEY = 'clarvis.bridge.identity';

/** A fresh opaque value. `randomUUID` rather than a counter, a time or a hash of anything. */
const opaque = (): string => randomUUID();

/**
 * The stored identity, minted on first use.
 *
 * **Read, validate, then write — never write on every call.** A `service_id` that
 * changed when a field was missing would make every window a different
 * installation, which is the failure §6.6 is about. So a stored value is trusted
 * whole and only a genuinely unusable one is replaced.
 */
export async function loadIdentity(storage: Storage): Promise<StoredIdentity> {
  const stored = storage.get<Partial<StoredIdentity>>(IDENTITY_KEY);
  if (stored?.service_id && stored.machine_id && stored.workspace_salt) {
    return stored as StoredIdentity;
  }

  const minted: StoredIdentity = {
    service_id: opaque(),
    machine_id: opaque(),
    workspace_salt: opaque(),
  };
  await storage.update(IDENTITY_KEY, minted);
  return minted;
}

/**
 * A new `machine_id`, keeping everything else.
 *
 * §6.1 calls the machine ID resettable, and that word only means anything if
 * resetting it actually severs the link — which it does here precisely because
 * the value is random rather than derived. The salt and the service ID are left
 * alone: this is "stop being recognisable as this machine", not "become a
 * different installation".
 */
export async function resetMachineId(storage: Storage): Promise<StoredIdentity> {
  const current = await loadIdentity(storage);
  const reset: StoredIdentity = { ...current, machine_id: opaque() };
  await storage.update(IDENTITY_KEY, reset);
  return reset;
}

/**
 * An opaque, salted ID for a workspace path.
 *
 * The path itself is never published — §6.1 says the raw path and name are
 * private by default, and a label, if the user ever enables one, is a separate
 * deliberately chosen field rather than this one decoded.
 *
 * Truncated to 32 hex characters: 128 bits, which is far past the point where
 * two workspaces on one machine could collide, and short enough to read in a log
 * without wrapping.
 */
export function workspaceId(salt: string, path: string | undefined): string | undefined {
  if (!path) return undefined;
  return createHash('sha256').update(salt).update('\0').update(path).digest('hex').slice(0, 32);
}

/**
 * Which editor this is, from the name it gives for itself.
 *
 * Matched loosely and case-insensitively because these are product names that
 * pick up suffixes — "Visual Studio Code - Insiders" is still VS Code. Anything
 * unrecognised is `other` rather than assumed to be VS Code: §6.1 lists `other`
 * as a real answer, and a fork silently reported as the thing it forked from is
 * the kind of wrong that only surfaces when someone is debugging something else.
 */
export function hostKind(appName: string | undefined): HostKind {
  const name = (appName ?? '').toLowerCase();
  if (name.includes('vscodium') || name.includes('codium')) return 'vscodium';
  if (name.includes('code-server') || name.includes('code server')) return 'code-server';
  if (name.includes('visual studio code') || name.includes('vs code')) return 'vscode';
  return 'other';
}

/** Everything the caller has to look up in `vscode` for us, gathered in one place. */
export interface HostFacts {
  readonly appName: string | undefined;
  readonly workspacePath: string | undefined;
  readonly buildVersion: string;
  readonly apiVersion: string;
  readonly protocolVersion: string;
}

/**
 * The published identity for this extension host.
 *
 * `instance_id` is minted here and nowhere else, and is never stored: §6.6 says
 * the same workspace opened twice is two instance lifetimes and must be
 * presented honestly, so persisting it would be the bug rather than an
 * optimisation.
 */
export function identityFor(stored: StoredIdentity, facts: HostFacts): Identity {
  return {
    service_type: SERVICE_TYPE,
    service_id: stored.service_id,
    instance_id: opaque(),
    machine_id: stored.machine_id,
    workspace_id: workspaceId(stored.workspace_salt, facts.workspacePath),
    host_kind: hostKind(facts.appName),
    build_version: facts.buildVersion,
    api_version: facts.apiVersion,
    protocol_version: facts.protocolVersion,
  };
}
