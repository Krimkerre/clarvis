import test from 'node:test';
import assert from 'node:assert/strict';
import { LAUNCHER_CREDENTIAL_ENV, launcherCredential } from './ravisCredential';

const env = { [LAUNCHER_CREDENTIAL_ENV]: 'token-from-the-launcher' };

test("the launcher's credential goes to this machine's RAVIS, for a RAVIS model", () => {
  // Measured 11 September 2026: unnamed, Clarvis shared RAVIS's sixty requests a minute
  // with the NERVIS dashboard, which used about twenty-four of them on its own.
  assert.equal(launcherCredential(env, 'http://127.0.0.1:8731', 'ravis/clarvis-agent'), 'token-from-the-launcher');
  assert.equal(launcherCredential(env, 'http://localhost:8731', 'ravis/clarvis-chat'), 'token-from-the-launcher');
});

test('it is never sent to another host, for another model, or when the launcher set nothing', () => {
  assert.equal(launcherCredential(env, 'https://openrouter.ai/api', 'ravis/clarvis-agent'), undefined);
  assert.equal(launcherCredential(env, 'http://192.168.1.20:8731', 'ravis/clarvis-agent'), undefined);
  assert.equal(launcherCredential(env, 'http://127.0.0.1:1234', 'qwen2.5-coder-7b-instruct'), undefined);
  assert.equal(launcherCredential({}, 'http://127.0.0.1:8731', 'ravis/clarvis-agent'), undefined);
  assert.equal(
    launcherCredential({ [LAUNCHER_CREDENTIAL_ENV]: '   ' }, 'http://127.0.0.1:8731', 'ravis/clarvis-agent'),
    undefined
  );
  assert.equal(launcherCredential(env, 'not a url', 'ravis/clarvis-agent'), undefined);
});
