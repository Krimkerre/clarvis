import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleNamed } from '../../test/fakes/relayContract';
import { codexReadiness } from './codexReadiness';
import type { CodexState } from './relayTypes';

/**
 * Whether Codex may start, read from `GET /api/v1/codex` before a branch or a session exists. Every
 * example is RAVIS's own fixture; the edits below change one field each.
 */

const ROUTE = 'GET /api/v1/codex';
const state = (name: string) => exampleNamed(ROUTE, name).response.body as CodexState;
const SIGNED_IN = 'signed in, three projects busy, read by a named caller';

test('signed in, tested, file rules proven and the process running: Codex may start', () => {
  assert.equal(codexReadiness(state(SIGNED_IN)), undefined);
});

test("each of RAVIS's refusing states becomes its own failure, with RAVIS's reason", () => {
  assert.deepEqual(codexReadiness(state('allowance used up')), {
    kind: 'quota_exhausted',
    reason: "The ChatGPT plan's allowance is used up until 04:30.",
  });
  assert.deepEqual(codexReadiness(state('signed out')), { kind: 'signed_out', expired: false, reason: 'Codex is signed out.' });
  assert.deepEqual(codexReadiness(state('paused for re-testing: the installed binary is neither tested nor accepted')), {
    kind: 'untested_version',
    fileRulesUnproven: false,
    reason: 'Codex changed (now 0.155.0) and needs re-testing before new work.',
  });
});

test('signed in is not enough: an untested verdict, unproven file rules or a stopped process each refuse', () => {
  const base = state(SIGNED_IN);
  const withRuntime = (runtime: Partial<CodexState['runtime']>): CodexState => ({ ...base, runtime: { ...base.runtime, ...runtime } });

  assert.equal(codexReadiness(withRuntime({ verdict: 'untested' }))?.kind, 'untested_version');
  assert.equal(codexReadiness(withRuntime({ verdict: 'accepted' })), undefined, 'accepted may run');
  assert.deepEqual(codexReadiness(withRuntime({ strict_rules: 'unproven' })), {
    kind: 'untested_version',
    fileRulesUnproven: true,
    reason: 'strict_file_rules_unproven',
  });
  assert.deepEqual(codexReadiness(withRuntime({ process: { state: 'restarting' } })), { kind: 'codex_not_ready', state: 'runtime_down', reason: '' });
});
