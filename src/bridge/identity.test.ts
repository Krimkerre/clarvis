import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  IDENTITY_KEY,
  hostKind,
  identityFor,
  loadIdentity,
  resetMachineId,
  workspaceId,
  type StoredIdentity,
  type Storage,
} from './identity';

/** A `globalState` that remembers, and counts how often it was written to. */
const memory = (initial?: unknown): Storage & { writes: number; value: unknown } => {
  const store = { value: initial, writes: 0 } as { value: unknown; writes: number };
  return {
    ...store,
    get<T>(key: string): T | undefined {
      return key === IDENTITY_KEY ? (this.value as T | undefined) : undefined;
    },
    update(key: string, value: unknown) {
      if (key !== IDENTITY_KEY) return;
      this.value = value;
      this.writes += 1;
    },
  } as Storage & { writes: number; value: unknown };
};

const facts = {
  appName: 'Visual Studio Code',
  workspacePath: '/home/someone/work/clarvis',
  buildVersion: '0.0.1',
  apiVersion: '1',
  protocolVersion: '1',
};

// ── The stored half ─────────────────────────────────────────────────────────

test('a first run mints all three values and stores them once', async () => {
  const storage = memory();

  const stored = await loadIdentity(storage);

  assert.ok(stored.service_id && stored.machine_id && stored.workspace_salt);
  assert.equal(storage.writes, 1);
});

test('the three values are different from each other', async () => {
  // A single value used for all three would make the salt public: `machine_id` is
  // published, and a salt anybody has is not a salt.
  const { service_id, machine_id, workspace_salt } = await loadIdentity(memory());

  assert.equal(new Set([service_id, machine_id, workspace_salt]).size, 3);
});

test('a second run returns the same identity and writes nothing', async () => {
  const storage = memory();
  const first = await loadIdentity(storage);

  const second = await loadIdentity(storage);

  assert.deepEqual(second, first);
  assert.equal(storage.writes, 1, 'rewriting on every read would churn globalState');
});

test('two installations get different identities', async () => {
  const one = await loadIdentity(memory());
  const two = await loadIdentity(memory());

  assert.notEqual(one.service_id, two.service_id);
  assert.notEqual(one.machine_id, two.machine_id);
});

test('a half-written identity is replaced rather than completed', async () => {
  // Trusting the fields that survived would produce an identity whose parts came
  // from different mintings, which is harder to reason about than a fresh one.
  const storage = memory({ service_id: 'kept?', machine_id: '' });

  const stored = await loadIdentity(storage);

  assert.ok(stored.workspace_salt);
  assert.notEqual(stored.service_id, 'kept?');
});

test('nothing here is derived from the machine', async () => {
  // §6.1 rules out hardware derivation in as many words, and the check that it
  // holds is that two loads in the same process — same host, same everything —
  // agree on nothing.
  const one = await loadIdentity(memory());
  const two = await loadIdentity(memory());

  assert.equal([one.service_id, one.machine_id, one.workspace_salt]
    .filter((value) => [two.service_id, two.machine_id, two.workspace_salt].includes(value))
    .length, 0);
});

// ── Reset ───────────────────────────────────────────────────────────────────

test('resetting the machine ID changes it and keeps the rest', async () => {
  const storage = memory();
  const before = await loadIdentity(storage);

  const after = await resetMachineId(storage);

  assert.notEqual(after.machine_id, before.machine_id);
  assert.equal(after.service_id, before.service_id, 'still the same installation');
  assert.equal(after.workspace_salt, before.workspace_salt);
});

test('a reset survives the next load', async () => {
  const storage = memory();
  await loadIdentity(storage);

  const after = await resetMachineId(storage);

  assert.deepEqual(await loadIdentity(storage), after);
});

test('workspace IDs are unaffected by a machine reset', async () => {
  // The salt is untouched on purpose: a reset means "stop being recognisable as
  // this machine", not "renumber every workspace on it".
  const storage = memory();
  const before = await loadIdentity(storage);
  const id = workspaceId(before.workspace_salt, '/w');

  const after = await resetMachineId(storage);

  assert.equal(workspaceId(after.workspace_salt, '/w'), id);
});

// ── Workspace IDs ───────────────────────────────────────────────────────────

test('the same path under the same salt is the same ID', () => {
  assert.equal(workspaceId('salt', '/a/b'), workspaceId('salt', '/a/b'));
});

test('different paths under one salt are different IDs', () => {
  assert.notEqual(workspaceId('salt', '/a/b'), workspaceId('salt', '/a/c'));
});

test('the same path under different salts is a different ID', () => {
  // The point of the salt. Without it, a hash of a path is a shared identifier —
  // the same repository at the same location on two machines would collide, and
  // an opaque local key would quietly become a way to recognise a project
  // across installations.
  assert.notEqual(workspaceId('salt-one', '/a/b'), workspaceId('salt-two', '/a/b'));
});

test('the path is not recoverable from the ID', () => {
  const id = workspaceId('salt', '/home/someone/secret-project') ?? '';

  assert.doesNotMatch(id, /home|someone|secret|project|\//);
  assert.match(id, /^[0-9a-f]{32}$/);
});

test('no folder open means no workspace ID at all', () => {
  // Absent, not empty. §6.3: unknown values stay unknown, and an empty string is
  // a value that reads as one.
  assert.equal(workspaceId('salt', undefined), undefined);
  assert.equal(workspaceId('salt', ''), undefined);
});

// ── Host kind ───────────────────────────────────────────────────────────────

test('the editors §6.1 names are recognised', () => {
  assert.equal(hostKind('Visual Studio Code'), 'vscode');
  assert.equal(hostKind('Visual Studio Code - Insiders'), 'vscode');
  assert.equal(hostKind('VSCodium'), 'vscodium');
  assert.equal(hostKind('code-server'), 'code-server');
});

test('VSCodium is not reported as VS Code', () => {
  // It calls itself "VSCodium", which contains neither "visual studio code" nor
  // anything else that would trip the VS Code branch — but the ordering is what
  // guarantees that, so it is worth a test rather than a reading.
  assert.notEqual(hostKind('VSCodium'), 'vscode');
});

test('an unknown editor is other, not a guess', () => {
  assert.equal(hostKind('Some Fork 2.0'), 'other');
  assert.equal(hostKind(undefined), 'other');
  assert.equal(hostKind(''), 'other');
});

// ── The published identity ──────────────────────────────────────────────────

test('a published identity carries what §6.1 lists and nothing else', () => {
  const stored: StoredIdentity = { service_id: 's', machine_id: 'm', workspace_salt: 'salt' };

  const identity = identityFor(stored, facts);

  assert.deepEqual(Object.keys(identity).sort(), [
    'api_version', 'build_version', 'host_kind', 'instance_id', 'machine_id',
    'protocol_version', 'service_id', 'service_type', 'workspace_id',
  ]);
  assert.equal(identity.service_type, 'clarvis');
});

test('the salt is never published', () => {
  // It is in the object this is built from, one spread away from leaking.
  const stored: StoredIdentity = { service_id: 's', machine_id: 'm', workspace_salt: 'SALT' };

  const identity = identityFor(stored, facts);

  assert.ok(!Object.values(identity).includes('SALT'));
  assert.ok(!('workspace_salt' in identity));
});

test('the workspace path is never published', () => {
  const stored: StoredIdentity = { service_id: 's', machine_id: 'm', workspace_salt: 'salt' };
  // Deliberately nothing like `clarvis` in it: the first draft searched for that
  // and matched `service_type`, which is the constant string `clarvis` and always
  // will be — a test that fails on the thing it is supposed to allow.
  const path = '/home/quintell/private-repo';

  const identity = identityFor(stored, { ...facts, workspacePath: path });

  for (const value of Object.values(identity)) {
    assert.doesNotMatch(String(value ?? ''), /quintell|private|repo|\//);
  }
});

test('each extension host is a new instance, even for the same workspace', () => {
  // §6.6: the same workspace opened twice is two instance lifetimes and is
  // presented honestly. Persisting instance_id would look like a tidy-up and
  // would be exactly that bug.
  const stored: StoredIdentity = { service_id: 's', machine_id: 'm', workspace_salt: 'salt' };

  const first = identityFor(stored, facts);
  const second = identityFor(stored, facts);

  assert.notEqual(first.instance_id, second.instance_id);
  assert.equal(first.workspace_id, second.workspace_id, 'same workspace, still');
  assert.equal(first.service_id, second.service_id, 'same installation, still');
});

test('two windows on different workspaces differ only where they should', () => {
  const stored: StoredIdentity = { service_id: 's', machine_id: 'm', workspace_salt: 'salt' };

  const one = identityFor(stored, { ...facts, workspacePath: '/one' });
  const two = identityFor(stored, { ...facts, workspacePath: '/two' });

  assert.notEqual(one.workspace_id, two.workspace_id);
  assert.notEqual(one.instance_id, two.instance_id);
  assert.equal(one.machine_id, two.machine_id);
});

// ── The one address that has to be right ────────────────────────────────────

test('the default NERVIS address matches the one the manifest offers', () => {
  // Two copies of a port, in a `.ts` fallback and a `.json` default, is exactly
  // the pair that drifts — and the failure is silent: a Bridge pointed at the
  // wrong port simply never registers, and the dashboard reports Clarvis as
  // offline for a reason three files away from what it shows. The first draft
  // had 8711 here, taken from the runbook's port table, which is stale relative
  // to NERVIS's own DEFAULT_PORT of 8790.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(findRepoRoot(__dirname), 'package.json'), 'utf8')
  );
  const declared = manifest.contributes.configuration.properties['clarvis.bridge.nervisUrl'].default;
  const source = fs.readFileSync(
    path.join(findRepoRoot(__dirname), 'src', 'bridge', 'wire.ts'), 'utf8'
  );

  assert.equal(declared, 'http://127.0.0.1:8790');
  assert.ok(
    source.includes(`|| '${declared}'`),
    `wire.ts's fallback disagrees with the manifest default ${declared}`
  );
});

/** The repository root, found by walking up to the `package.json`. */
function findRepoRoot(start: string): string {
  let current = start;
  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('no package.json above ' + start);
    current = parent;
  }
}
