import { capabilities, MODES, canEdit, modeSpec } from './modes';
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

test('a polite request is a request, question mark and all', () => {
  // Found live: "can you fix my code?" hit the trailing-? rule and was answered — a
  // list of what was wrong, and a note that files could not be written in Chat mode,
  // for a message whose entire point was to have it fixed.
  for (const message of ['can you fix my code?', 'could you fix this?', 'can you refactor this file?']) {
    assert.equal(routeFor(message).route, 'agent', message);
  }
});

test('a genuine opinion question survives the polite-request check', () => {
  // "would you" was tried in the same list and broke this: "what would you change" is
  // asking for an opinion, and every instance of "would you X" in ordinary phrasing is
  // closer to that than to a request. Left out for exactly this sentence.
  assert.equal(routeFor('what would you change about this file').route, 'answer');
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

test('the everyday verbs for asking for work all route to the agent', () => {
  // "make a new branch called testing3" was answered rather than done: the verb list
  // was written from the verbs I thought of, and `make` was not among them.
  for (const message of [
    'make a new branch called testing3',
    'make me a helper function',
    'build a parser for this format',
    'generate the types from the schema',
    'set up eslint',
    'move BusyTracker into src/watch',
    'revert the last change to README',
  ]) {
    assert.equal(routeFor(message).route, 'agent', message);
  }
});

test('the same verbs in a question still get answered', () => {
  // Widening the verb list must not start turning questions into work.
  for (const message of [
    'how do I make a new branch?',
    'what would you build here',
    'should we set up eslint',
    'can you generate types from a schema',
  ]) {
    assert.equal(routeFor(message).route, 'answer', message);
  }
});

import { localAnswer as localAnswerFor } from './localAnswer';

test('a job mentioning a watched keyword is not swallowed by the local answer', () => {
  // The bug: "make a new branch called testing3" contains "branch", so the local
  // matcher answered with the current branch name and the request never reached the
  // agent at all — no routing line in the log, nothing done.
  const facts = { now: NOW, running: [], recentFiles: [], patterns: [], git: { branch: 'main', dirtyCount: 0 } };

  // The local matcher still answers it in isolation...
  assert.ok(localAnswerFor('make a new branch called testing3', facts));
  // ...which is why routing has to be consulted first.
  assert.equal(routeFor('make a new branch called testing3').route, 'agent');
});

test('questions containing work keywords still reach the local answer', () => {
  // The reordering must not send genuine questions to the agent.
  for (const message of ['what branch am I on?', 'which branch is this', 'have we seen this error before?']) {
    assert.equal(routeFor(message).route, 'answer', message);
  }
});


test('the facts block carries what Clarvis watched, for the model to phrase', () => {
  // The division of labour: local state knows the truth about this project, the model
  // knows how to say it. Handing the facts over gets both in one request, with no tool
  // call — asking a model to run gitStatus to answer "what branch am I on?" spends two
  // round trips learning something already in memory.
  const block = factsBlock(
    facts({
      git: { branch: 'm8-chat-agent', dirtyCount: 3 },
      lastFailure: { label: 'npm test', exitCode: 1, at: NOW - 5 * 60_000 },
      recentFiles: ['src/chat/ChatService.ts'],
      patterns: [{ sample: 'ECONNREFUSED', occurrences: [1, 2, 3], resolvedBy: 'docker compose up' }],
    })
  );

  assert.match(block, /m8-chat-agent/);
  assert.match(block, /3 uncommitted/);
  assert.match(block, /npm test/);
  assert.match(block, /ChatService\.ts/);
  assert.match(block, /ECONNREFUSED/);
  assert.match(block, /docker compose up/);
});

test('absent facts are omitted, not reported as absent', () => {
  // A model handed "lastFailure: none" writes a sentence about there being no
  // failures, which is noise nobody asked for.
  const block = factsBlock(facts({ git: { branch: 'main', dirtyCount: 0 } }));

  assert.ok(!/failing/i.test(block), block);
  assert.ok(!/recently edited/i.test(block), block);
  assert.match(block, /working tree clean/);
});

test('a tree with files never committed is not called clean', () => {
  // Found live, 11 September 2026: "working tree clean, plus 3 untracked file(s)" became
  // "the working tree is clean", about a project none of whose files had been committed.
  const block = factsBlock(facts({ git: { branch: 'master', dirtyCount: 0, untrackedCount: 3 } }));

  assert.ok(!/clean/.test(block), block);
  assert.match(block, /3 file\(s\) never committed/);
});

test('the files at the top of the project are named', () => {
  // "There is no plan.md", said in a folder holding one, because nothing listed the files.
  const block = factsBlock(facts({ files: ['plan.md', 'timer.py'] }));

  assert.match(block, /plan\.md, timer\.py/);
});

test('a project with nothing observed yields no block at all', () => {
  // An empty heading followed by nothing would still cost tokens and say nothing.
  assert.equal(factsBlock(facts()), '');
});

test('the block tells the model not to go beyond it', () => {
  // Facts plus a free hand is how a model invents a branch name that sounds right.
  assert.match(factsBlock(facts({ git: { branch: 'main', dirtyCount: 0 } })), /do not invent/i);
});

import { branchFromRequest } from './chatCommands';

test('a named branch is switched to directly, without a picker', () => {
  assert.equal(branchFromRequest('switch to testing3'), 'testing3');
  assert.equal(branchFromRequest('checkout main'), 'main');
  assert.equal(branchFromRequest('check out feature/login'), 'feature/login');
});

test('no name means the picker, rather than a guess', () => {
  // "switch branch" is a request *for* the list; guessing which one would be worse
  // than asking.
  assert.equal(branchFromRequest('switch branch'), undefined);
  assert.equal(branchFromRequest('check out the branch'), undefined);
  assert.equal(branchFromRequest('switch to it'), undefined);
});

test('a sentence is not mistaken for a branch name', () => {
  // A greedy match would try to check out "yesterday".
  assert.equal(branchFromRequest('switch to the branch I was on yesterday'), undefined);
});

test('switching branches is not confused with switching voice or engine', () => {
  // Those intents are listed first precisely so "switch to a different engine" never
  // reaches git.
  assert.equal(chatAction('switch to a different engine'), 'chooseEngine');
  assert.equal(chatAction('change the voice'), 'chooseVoice');
  assert.equal(chatAction('switch to testing3'), 'switchBranch');
});

import { isDoItNow } from './routing';

test('edit and change route to the agent', () => {
  // Missing from the first list, so "edit the comment in plan.md" was answered by the
  // read-only path explaining that it cannot edit things — which reads as a refusal
  // rather than a misunderstanding.
  for (const message of [
    'edit the wubbadubbalublub comment in plan.md to dubbawubbalublub',
    'change the port to 8080 in config.ts',
    'tweak the timeout in app.js',
    'rewrite the readme intro',
    'correct the typo in app.js',
  ]) {
    assert.equal(routeFor(message).route, 'agent', message);
  }
});

test('"do it" is recognised as a request to act on what was just said', () => {
  // The recovery for a routing miss: four characters instead of a rephrase.
  for (const message of ['do it', 'go on then', 'just do it', 'please do', 'fix it', 'make it so']) {
    assert.equal(isDoItNow(message), true, message);
  }
});

test('"do it" does not fire on ordinary conversation', () => {
  // "yes" alone is far too common to hand to an agent.
  for (const message of ['yes', 'why do it that way', 'what does it do', 'ok']) {
    assert.equal(isDoItNow(message), false, message);
  }
});

import { needsClassification, parseIntent, intentPrompt } from './routing';
import { factsBlock } from './localAnswer';

test('only a fall-through is worth asking the model about', () => {
  // A question with a question mark needs no second opinion, and paying for one on
  // every message would be absurd.
  assert.equal(needsClassification('why did the build fail?'), false);
  assert.equal(needsClassification('what does BusyTracker do'), false);
  assert.equal(needsClassification('fix the failing test'), false, 'a matched verb needs no help');
  assert.equal(needsClassification('we should maybe rename this'), false, 'hedging is already handled');

  // The case that has been wrong twice: an unlisted verb, no question signal.
  assert.equal(needsClassification('swap the port over to 8080'), true);
  assert.equal(needsClassification('stick a comment at the top of app.js'), true);
});

test('fragments are conversation, not instructions', () => {
  // "hmm", "ok", "thanks" should never cost a classification request.
  assert.equal(needsClassification('hmm'), false);
  assert.equal(needsClassification('ok thanks'), false);
  assert.equal(needsClassification(''), false);
});

test('the classifier reply is parsed strictly', () => {
  assert.equal(parseIntent('WORK'), 'agent');
  assert.equal(parseIntent(' question \n'), 'answer');
  assert.equal(parseIntent('WORK.'), 'agent');
});

test('anything but the two words leaves the deterministic route alone', () => {
  // A classifier that cannot follow a one-word instruction is not one to trust with
  // "should I edit their files".
  assert.equal(parseIntent('I think this is asking for work to be done'), undefined);
  assert.equal(parseIntent('Sure! WORK'), undefined);
  assert.equal(parseIntent(''), undefined);
  assert.equal(parseIntent(undefined), undefined);
});

test('the prompt tells it to answer QUESTION when unsure', () => {
  // Ambiguity resolving toward answering is the whole safety property, and it has to
  // survive being delegated to a model.
  assert.match(intentPrompt('do the thing'), /could be either, answer QUESTION/);
});

test('"change to the milestone branch" is a checkout, not an agent task', () => {
  // Seen live: it ran a whole agent task to do one deterministic thing, and the
  // cleanup then switched the user back, silently undoing the request.
  assert.equal(chatAction('change to the milestone branch'), 'switchBranch');
  assert.equal(branchFromRequest('change to the milestone branch'), 'milestone');
  assert.equal(branchFromRequest('move to testing'), 'testing');
  assert.equal(branchFromRequest('change to milestone/1'), 'milestone/1');
});

test('changing a setting is still not a branch switch', () => {
  // "change to a different voice" must never reach git.
  assert.equal(chatAction('change to a different voice'), 'chooseVoice');
  assert.equal(chatAction('change the model'), 'chooseModel');
});

test('an old failure is not reported in thousands of minutes', () => {
  // "failing for 4186 minutes" is true, useless, and reads as a broken tool. The facts
  // are the one part of what he says that must never sound wrong.
  const base = {
    now: Date.now(),
    running: [],
    recentFiles: [],
    patterns: [],
  };

  const recent = factsBlock({
    ...base,
    lastFailure: { label: 'build', exitCode: 1, at: base.now - 12 * 60_000 },
  } as never);
  const old = factsBlock({
    ...base,
    lastFailure: { label: 'build', exitCode: 1, at: base.now - 70 * 60 * 60_000 },
  } as never);

  assert.match(recent, /12m ago/);
  assert.match(old, /3d ago/);
  assert.doesNotMatch(old, /\d{4}m ago/);
});

test('he is told what he can do, not only what this turn allows', () => {
  // Found live, twice in one session: "I cannot run tests, execute code, attach a
  // debugger. I cannot fix anything", and then "I do not do that. I read and I
  // remark." He writes files, runs commands and builds whole projects; only the turn
  // was read-only.
  const brief = capabilities('chat');

  assert.match(brief, /run commands and tests/);
  assert.match(brief, /build it milestone/);
});

test('a read-only mode is named as a setting, with where the work happens', () => {
  const brief = capabilities('chat');

  assert.match(brief, /Chat only/);
  assert.match(brief, /Auto/);
  assert.match(brief, /setting they chose and can change/);
});

test('an editing mode is not told it cannot edit', () => {
  const brief = capabilities('auto');

  assert.match(brief, /allows all of it/);
  assert.doesNotMatch(brief, /nothing gets changed/);
});

test('the modes that can work are read off MODES rather than listed by hand', () => {
  // A hand-written list is a copy, and a copy drifts the first time a mode changes.
  const named = capabilities('chat');

  for (const spec of MODES.filter((mode) => mode.canEdit)) assert.match(named, new RegExp(spec.label));
  for (const spec of MODES.filter((mode) => !mode.canEdit && mode.id !== 'chat')) {
    assert.doesNotMatch(named, new RegExp(`${spec.label} is where`));
  }
});

test('"anything wrong in here?" is answered about the open file, not the last build', () => {
  // "broken" and "wrong" both used to land on the failure answer, which talks about the
  // last red build — a different question, answered confidently.
  const facts = {
    now: Date.now(),
    running: [],
    recentFiles: [],
    patterns: [],
    activeFile: 'nanocode.py',
    openProblems: {
      file: 'nanocode.py',
      items: [{ line: 19, message: 'unterminated string literal', severity: 'error' as const }],
      more: 0,
    },
    lastFailure: { label: 'npm test', exitCode: 1, at: Date.now() },
  };

  const reply = localAnswer('anything wrong in here?', facts);

  assert.match(reply!.text, /line 19/);
  assert.doesNotMatch(reply!.text, /npm test/);
});

test('asked about a clean file, he says so rather than saying nothing', () => {
  const reply = localAnswer('anything wrong in here?', {
    now: Date.now(),
    running: [],
    recentFiles: [],
    patterns: [],
    activeFile: 'nanocode.py',
  });

  assert.match(reply!.text, /Nothing in nanocode\.py/);
});

test('the open file problems reach the model too, not just the counts', () => {
  // The model path wins whenever a key exists, so detail that only reached the no-key
  // fallback would never be seen by the person who has one.
  const block = factsBlock({
    now: Date.now(),
    running: [],
    recentFiles: [],
    patterns: [],
    problems: { errors: 1, warnings: 0, worstFile: 'nanocode.py' },
    openProblems: {
      file: 'nanocode.py',
      items: [{ line: 19, message: 'unterminated string literal', severity: 'error' as const }],
      more: 0,
    },
  });

  assert.match(block, /line 19: unterminated string literal/);
});

test('a read-only mode is named in the offer, and it is the mode returned to', () => {
  // The wording has to say which mode is being borrowed *from*, because "back to Chat
  // only" and "back to Plan only" are different promises and only one of them is true.
  for (const mode of ['chat', 'plan'] as const) {
    assert.equal(canEdit(mode), false, mode);
    assert.ok(modeSpec(mode).label.length > 0, mode);
  }

  // And the modes that can already edit must never see the offer at all.
  for (const mode of ['agent', 'auto', 'unattended'] as const) {
    assert.equal(canEdit(mode), true, mode);
  }
});

test('"why did you" is answered from the last run\'s recorded narration, not guessed', () => {
  // Review item A. Grounded in what was actually recorded, not "generic model
  // hindsight" — the review's own phrase for the thing this must not be.
  const lastRun = {
    intent: 'fix the failing test',
    startedAt: 0,
    steps: [
      {
        step: 1,
        narration: 'The test wants a trailing slash stripped before comparing.',
        action: 'applyEdit: src/app.ts',
        file: 'src/app.ts',
        declined: false,
      },
    ],
    filesChanged: ['src/app.ts'],
    result: 'Fixed it.',
  };

  const reply = localAnswer('why did you edit app.ts?', { ...baseFacts(), lastRun });

  assert.match(reply!.text, /trailing slash/);
  assert.match(reply!.text, /applyEdit: src\/app\.ts/);
});

test('"why did you" with no matching step says so, rather than guessing at one', () => {
  const lastRun = {
    intent: 'fix the failing test',
    startedAt: 0,
    steps: [{ step: 1, narration: 'x', action: 'applyEdit: src/app.ts', file: 'src/app.ts', declined: false }],
    filesChanged: ['src/app.ts'],
    result: 'Fixed it.',
  };

  const reply = localAnswer('why did you touch package.json?', { ...baseFacts(), lastRun });

  assert.match(reply!.text, /can't tell which step/);
});

test('"why did you" with no run at all says so plainly', () => {
  const reply = localAnswer('why did you do that?', baseFacts());

  assert.match(reply!.text, /haven't done anything yet/);
});

test('"what did the last run do" gives the short version: intent, files, result', () => {
  const lastRun = {
    intent: 'fix the failing test',
    startedAt: 0,
    steps: [],
    filesChanged: ['src/app.ts'],
    result: 'Fixed it.',
  };

  const reply = localAnswer('what did the last run do?', { ...baseFacts(), lastRun });

  assert.match(reply!.text, /fix the failing test/);
  assert.match(reply!.text, /src\/app\.ts/);
  assert.match(reply!.text, /Fixed it\./);
});

test('the last run reaches the model path too, not just the local one', () => {
  // Without this the model answered "why" from general conversation memory — the
  // generic hindsight the review said not to build on — even with the real narration
  // sitting in workspaceState.
  const lastRun = {
    intent: 'fix the failing test',
    startedAt: 0,
    steps: [
      { step: 1, narration: 'Trailing slash was the mismatch.', action: 'applyEdit: src/app.ts', declined: false },
    ],
    filesChanged: ['src/app.ts'],
    result: 'Fixed it.',
  };

  const block = factsBlock({ ...baseFacts(), lastRun });

  assert.match(block, /fix the failing test/);
  assert.match(block, /Trailing slash was the mismatch/);
});

function baseFacts(): WorkspaceFacts {
  return { now: Date.now(), running: [], recentFiles: [], patterns: [] };
}
