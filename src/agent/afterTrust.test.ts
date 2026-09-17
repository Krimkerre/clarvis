import assert from 'node:assert/strict';
import { test } from 'node:test';
import { whenTrusted, type TrustSource } from './afterTrust';

function source(trusted: boolean) {
  const listeners = new Set<() => void>();
  const it: TrustSource & { grant(): void; listening(): number } = {
    trusted: () => trusted,
    onGrant: (listener) => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
    grant: () => {
      trusted = true;
      for (const listener of [...listeners]) listener();
    },
    listening: () => listeners.size,
  };
  return it;
}

test('a trusted folder starts at once and waits for nothing', () => {
  const trust = source(true);
  let started = 0;
  whenTrusted(trust, () => started++);
  assert.equal(started, 1);
  assert.equal(trust.listening(), 0);
});

test('a folder trusted after the window opened starts then, once, and stops listening', () => {
  // Attended session, 17 Sep 2026: the Bridge stayed off after the owner trusted the folder.
  const trust = source(false);
  let started = 0;
  whenTrusted(trust, () => started++);
  assert.equal(started, 0, 'nothing runs in Restricted Mode');

  trust.grant();
  trust.grant();

  assert.equal(started, 1);
  assert.equal(trust.listening(), 0);
});

test('a window closed before trust was granted never starts', () => {
  const trust = source(false);
  let started = 0;
  whenTrusted(trust, () => started++).dispose();
  trust.grant();
  assert.equal(started, 0);
});
