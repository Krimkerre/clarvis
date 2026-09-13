import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * RAVIS's Codex contract fixtures, copied here byte for byte (plan.md M15).
 *
 * `ECOSYSTEM_RUNBOOK.md` §2.2 makes RAVIS the owner of the fixtures both products build the Codex
 * engine against. This repository keeps a copy in `src/test/fixtures/` instead of reading RAVIS's
 * checkout, because a clean clone of Clarvis has no sibling to read — and a copy is only safe while
 * something proves it is still the same. `codex-contract.sha256` is that proof: the manifest RAVIS
 * writes beside its originals, copied along with them.
 *
 * Nothing here tests Codex behaviour, because none is built. `FakeRavisRelay` (M15's C1) will be
 * built from these files, so the day they drift is the day the fake starts agreeing with a contract
 * RAVIS no longer keeps — which is what the third test is for.
 */

const root = findRepoRoot(__dirname);
const fixtures = path.join(root, 'src', 'test', 'fixtures');
const manifestName = 'codex-contract.sha256';
/** RAVIS's originals, where the NERVIS-ecosystem checkout sits beside this one, as it does here. */
const ravisFixtures = path.join(root, '..', 'NERVIS-ecosystem', 'ravis', 'tests', 'fixtures');

test('every copied contract fixture matches the manifest it was copied with', () => {
  const manifest = readManifest(fixtures);

  assert.deepEqual([...manifest.keys()].sort(), contractFiles(fixtures));
  for (const [name, digest] of manifest) {
    assert.equal(sha256(path.join(fixtures, name)), digest, `${name} differs from its manifest line`);
  }
});

test('every copied contract fixture parses as JSON', () => {
  for (const name of contractFiles(fixtures)) {
    const text = fs.readFileSync(path.join(fixtures, name), 'utf8');

    assert.doesNotThrow(() => JSON.parse(text), name);
  }
});

test(
  "the copy is still RAVIS's: the same manifest, and RAVIS's own files still match it",
  { skip: fs.existsSync(ravisFixtures) ? false : 'no NERVIS-ecosystem checkout beside this one' },
  () => {
    const ours = fs.readFileSync(path.join(fixtures, manifestName), 'utf8');
    const theirs = fs.readFileSync(path.join(ravisFixtures, manifestName), 'utf8');

    assert.equal(ours, theirs, 'RAVIS changed its contract fixtures: copy them again, manifest included');
    for (const [name, digest] of readManifest(ravisFixtures)) {
      assert.equal(sha256(path.join(ravisFixtures, name)), digest, `RAVIS's ${name} changed without its manifest line`);
    }
  }
);

/** `<sha256>  <path>` lines — the format `shasum -a 256 -c` reads — keyed by path. */
function readManifest(dir: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of fs.readFileSync(path.join(dir, manifestName), 'utf8').split('\n')) {
    if (line === '') continue;
    const separator = line.indexOf('  ');
    entries.set(line.slice(separator + 2), line.slice(0, separator));
  }
  return entries;
}

/** The files the manifest must cover: the relay folder's JSON and the lock rule's cases. */
function contractFiles(dir: string): string[] {
  const relay = fs
    .readdirSync(path.join(dir, 'relay-contract'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => `relay-contract/${name}`);
  return [...relay, 'lock-rule-cases.json'].sort();
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function findRepoRoot(start: string): string {
  let current = start;
  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('no package.json above ' + start);
    current = parent;
  }
}
