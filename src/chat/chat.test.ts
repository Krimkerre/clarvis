import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendTurn, MAX_TURNS, Turn } from './thread';
import { localAnswer, WorkspaceFacts } from './localAnswer';

const NOW = 1_700_000_000_000;

function turn(text: string): Turn {
  return { speaker: 'user', text, at: NOW };
}

test('the thread cap drops the oldest turns, not the newest', () => {
  // The failure mode worth guarding: a cap that slices the wrong end silently
  // discards the conversation you are currently having.
  let thread: Turn[] = [];
  for (let i = 0; i < MAX_TURNS + 5; i++) thread = appendTurn(thread, turn(`q${i}`));

  assert.equal(thread.length, MAX_TURNS);
  assert.equal(thread[0].text, 'q5');
  assert.equal(thread[thread.length - 1].text, `q${MAX_TURNS + 4}`);
});

function facts(overrides: Partial<WorkspaceFacts> = {}): WorkspaceFacts {
  return { now: NOW, running: [], recentFiles: [], patterns: [], ...overrides };
}

test('local answers cover the five question types without a model', () => {
  const state = facts({
    lastFailure: { label: 'npm test', exitCode: 1, at: NOW - 5 * 60_000 },
    lastOutcome: { label: 'npm run build', exitCode: 0, durationMs: 4200 },
    git: { branch: 'm8-chat-agent', dirtyCount: 3 },
    recentFiles: ['src/chat/localAnswer.ts'],
    patterns: [{ sample: 'ECONNREFUSED', occurrences: [1, 2, 3], resolvedBy: 'docker compose up' }],
  });

  assert.match(localAnswer('is the build still broken?', state)!.text, /npm test/);
  assert.match(localAnswer('what branch am I on?', state)!.text, /m8-chat-agent/);
  assert.match(localAnswer('how long did that take?', state)!.text, /4\.2s/);
  assert.match(localAnswer('have we seen this before?', state)!.text, /docker compose up/);
  assert.match(localAnswer('catch me up', state)!.text, /m8-chat-agent/);
});

test('an unmatched question returns null rather than guessing', () => {
  // null is what routes the question to a model. A confident wrong local answer
  // would pre-empt the only path that could actually answer it.
  assert.equal(localAnswer('write me a regex for email addresses', facts()), null);
  assert.equal(localAnswer('why is the sky blue', facts()), null);
});

test('local answers hold up when there is nothing to report', () => {
  // A fresh workspace has no git, no history and no failures — every branch must
  // still produce a sentence rather than "undefined" or a crash.
  const empty = facts();

  assert.match(localAnswer('what is broken?', empty)!.text, /Nothing is failing/);
  assert.match(localAnswer('what branch am I on?', empty)!.text, /no git repository/i);
  assert.match(localAnswer('how long did it take?', empty)!.text, /Nothing has finished/);
  assert.match(localAnswer('seen this before?', empty)!.text, /new/);
  assert.match(localAnswer('catch me up', empty)!.text, /only just met/);
});

test('a resolved-by note is only claimed when one was actually recorded', () => {
  // §4.2: the fix is a guess and is always labelled as one. Inventing a fix that
  // was never observed is the one thing pattern memory must not do.
  const unfixed = facts({ patterns: [{ sample: 'ETIMEDOUT', occurrences: [1, 2] }] });

  assert.match(localAnswer('seen this before?', unfixed)!.text, /never actually fixed it/);
});

import { archiveSession, parseHistory, describeSession, MAX_SESSIONS } from './history';

test('an empty session is never filed', () => {
  // Opening a window and asking nothing must not push a real session out of the cap.
  const history = archiveSession([], { startedAt: NOW, turns: [] });

  assert.deepEqual(history, []);
});

test('sessions are filed newest first and capped', () => {
  let history = archiveSession([], { startedAt: 1, turns: [turn('oldest')] });
  for (let i = 2; i <= MAX_SESSIONS + 3; i++) {
    history = archiveSession(history, { startedAt: i, turns: [turn(`q${i}`)] });
  }

  assert.equal(history.length, MAX_SESSIONS);
  assert.equal(history[0].startedAt, MAX_SESSIONS + 3); // newest kept
  assert.ok(!history.some((session) => session.startedAt === 1)); // oldest dropped
});

test('a corrupted archive degrades to the sessions that survive', () => {
  // Stored state outlives the build that wrote it. Fewer sessions is recoverable;
  // a panel that throws on open is not.
  const parsed = parseHistory([
    { startedAt: NOW, turns: [turn('kept'), { speaker: 'ghost', text: 'x', at: 1 }] },
    { startedAt: 'not a number', turns: [] },
    null,
  ]);

  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].turns, [turn('kept')]);
  assert.deepEqual(parseHistory('nonsense'), []);
});

test('a session is labelled by the first thing asked', () => {
  // A timestamp does not tell you which conversation this was; the question does.
  const { label } = describeSession({
    startedAt: NOW,
    turns: [{ speaker: 'clarvis', text: 'A briefing.', at: NOW }, turn('why is the build red?')],
  });

  assert.equal(label, 'why is the build red?');
});
