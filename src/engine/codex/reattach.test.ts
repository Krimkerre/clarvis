import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleNamed } from '../../test/fakes/relayContract';
import type { SessionSummary } from '../relay/relayTypes';
import type { TokenRead } from '../relay/tokenStore';
import { reattachStep } from './reattach';

/** Which Codex task a window picks back up when it opens on the project. */

const listed = (exampleNamed('GET /api/v1/agent-sessions', "the workspace's sessions").response.body as { items: SessionSummary[] }).items[0];

function summary(patch: Partial<SessionSummary>): SessionSummary {
  return { ...listed, ...patch };
}

const found: TokenRead = { kind: 'found', entry: { token: 'ast_x', taskId: 't', savedAt: '2026-09-13T01:12:00Z' } };

test("the contract's listed session, waiting on the owner, is followed when this Mac holds its token", () => {
  assert.deepEqual(reattachStep([listed], () => found), { kind: 'follow', session: listed });
});

test('a missing token offers Reconnect; an unsafe token file is named and left alone', () => {
  assert.deepEqual(reattachStep([listed], () => ({ kind: 'missing' })), { kind: 'reconnect', session: listed });
  assert.deepEqual(reattachStep([listed], () => ({ kind: 'refused', reason: 'symlink' })), {
    kind: 'unsafe_token',
    session: listed,
    reason: 'symlink',
  });
});

test('settled, ended and failed sessions have nothing to follow', () => {
  for (const state of ['idle', 'ended', 'failed'] as const) {
    assert.deepEqual(reattachStep([summary({ state, waiting_on_you: false })], () => found), { kind: 'nothing' }, state);
  }
  assert.deepEqual(reattachStep([], () => found), { kind: 'nothing' });
});

test('a waiting question comes first, then work to save, then the most recently active', () => {
  const running = summary({ id: 'as_running', state: 'running', waiting_on_you: false, updated_at: '2026-09-13T03:00:00Z' });
  const toSave = summary({ id: 'as_to_save', state: 'completed_needs_review', waiting_on_you: false, updated_at: '2026-09-13T01:00:00Z' });
  const waiting = summary({ id: 'as_waiting', state: 'waiting_on_you', waiting_on_you: true, updated_at: '2026-09-13T00:30:00Z' });
  const pick = (sessions: SessionSummary[]) => {
    const step = reattachStep(sessions, () => found);
    return step.kind === 'follow' ? step.session.id : step.kind;
  };

  assert.equal(pick([running, toSave, waiting]), 'as_waiting');
  assert.equal(pick([running, toSave]), 'as_to_save');
  assert.equal(pick([summary({ id: 'as_old', state: 'running', waiting_on_you: false, updated_at: '2026-09-13T01:00:00Z' }), running]), 'as_running');
});
