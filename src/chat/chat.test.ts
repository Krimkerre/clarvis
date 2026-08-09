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

import { chatAction } from './chatCommands';

test('slash commands open the thing they name', () => {
  assert.equal(chatAction('/help'), 'help');
  assert.equal(chatAction('/voice'), 'chooseVoice');
  assert.equal(chatAction('/engine'), 'chooseEngine');
  assert.equal(chatAction('/mute'), 'toggleMute');
  assert.equal(chatAction('/history'), 'showHistory');
  assert.equal(chatAction('/settings'), 'openSettings');
});

test('plain requests open things too', () => {
  assert.equal(chatAction('change the voice'), 'chooseVoice');
  assert.equal(chatAction('switch to a different engine'), 'chooseEngine');
  assert.equal(chatAction('open the settings'), 'openSettings');
  assert.equal(chatAction('shut up'), 'toggleMute');
  assert.equal(chatAction('show me previous conversations'), 'showHistory');
});

test('questions are answered, not hijacked into a dialog', () => {
  // The failure worth preventing: "what voice are you using?" popping a picker.
  // Being too eager is worse than being too shy — a missed request just gets a
  // normal answer, whereas a hijacked question looks like a bug.
  assert.equal(chatAction('what voice are you using?'), null);
  assert.equal(chatAction('which model is this?'), null);
  assert.equal(chatAction('is the engine any good?'), null);
  assert.equal(chatAction('why did the build fail?'), null);
});

test('a slash command must be the whole message', () => {
  // Otherwise talking *about* a command triggers it.
  assert.equal(chatAction('what does /voice do?'), null);
});

test('narrower intents win over broader ones', () => {
  // "engine" contains no voice words, but "voice engine" does — and the engine
  // picker is the one being asked for.
  assert.equal(chatAction('change the voice engine'), 'chooseEngine');
  assert.equal(chatAction('remove my api key'), 'clearKey');
  assert.equal(chatAction('set my api key'), 'setKey');
});

test('bare help is understood without a verb', () => {
  // "help me" deliberately no longer counts — see the assistance test below. This
  // expectation changed on purpose when the two meanings were separated.
  assert.equal(chatAction('help'), 'help');
  assert.equal(chatAction('help me'), null);
});

test('asking for the manual opens it, however it is phrased', () => {
  // The reported miss: this needed an imperative verb and fell through to the model.
  // Opening docs is harmless and instantly closable, so it earns a lower bar than
  // actions that change settings.
  for (const question of [
    'do you have a help page?',
    'is there a manual?',
    'where are the docs?',
    'got any documentation?',
    'show me the user guide',
    'help',
    'help?',
  ]) {
    assert.equal(chatAction(question), 'help', question);
  }
});

test('"help me" is a request for assistance, not for documentation', () => {
  // The most natural thing to type at an assistant. Answering it with a docs page
  // would be useless and faintly smug.
  for (const question of [
    'help me fix the build',
    'help me understand this error',
    'can you help with the failing test',
    'help us debug this',
  ]) {
    assert.equal(chatAction(question), null, question);
  }
});

test('talking about the help command does not invoke it', () => {
  assert.equal(chatAction('what does /help do?'), null);
});

import { routeFor, isEscalation } from './routing';

test('a job goes to the agent', () => {
  for (const message of [
    'fix the failing test in src/watch',
    'add a comment to README.md',
    'rename BusyTracker to JobTracker',
    'refactor the voice service',
    'make it stop double-notifying',
    'get the tests passing',
  ]) {
    assert.equal(routeFor(message).route, 'agent', message);
  }
});

test('a question is answered even when it contains a work verb', () => {
  // "How do I fix this?" wants an explanation; "fix this" wants a fix. Missing that
  // distinction is the likeliest way this router starts editing files mid-conversation.
  for (const message of [
    'how do I fix the failing test?',
    'what would you change about this file',
    'why did the build fail?',
    'should I rename this class',
    'can you explain what BusyTracker does',
    'is it worth refactoring the voice service',
  ]) {
    assert.equal(routeFor(message).route, 'answer', message);
  }
});

test('a question mark always wins', () => {
  // The clearest signal a person can give, and they mean it.
  assert.equal(routeFor('fix the failing test?').route, 'answer');
});

test('thinking out loud is not an instruction', () => {
  for (const message of [
    'I was thinking of renaming this module',
    'we should probably add tests here',
    'what if we split this file',
  ]) {
    assert.equal(routeFor(message).route, 'answer', message);
  }
});

test('ambiguity resolves toward answering', () => {
  // The two mistakes are not equal: a question wrongly routed to the agent starts
  // editing a codebase nobody asked it to touch.
  for (const message of ['the tests', 'hmm', 'BusyTracker', 'that thing from yesterday']) {
    assert.equal(routeFor(message).route, 'answer', message);
  }
});

test('every decision carries a reason worth showing', () => {
  // The route is announced before work starts, so the user can stop a wrong one.
  assert.ok(routeFor('fix the test').because.length > 10);
  assert.ok(routeFor('why did it fail?').because.length > 10);
});

test('escalation needs something to escalate', () => {
  // Rule 3: a pattern hit is an observation. Replying to it is what makes it a
  // request — the same words with nothing preceding them are not.
  assert.equal(isEscalation('go on then', true), true);
  assert.equal(isEscalation('fix it', true), true);
  assert.equal(isEscalation('go on then', false), false);
  assert.equal(isEscalation('what did you mean', true), false);
});
