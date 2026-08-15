import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, normalizeError } from './fingerprint';
import { recordOccurrence, recordResolution, topPattern, parseState, emptyState, WINDOW_MS, THRESHOLD, patternHitLine } from './patterns';
import { beginPending, noteOutcome } from './resolution';
import { forgetMatching } from './patterns';

// ---------------------------------------------------------------- fingerprint

test('the same error at different paths and line numbers is one pattern', () => {
  const a = 'ERR: cannot find module at /Users/ann/proj/src/app.ts:12:4';
  const b = 'ERR: cannot find module at /home/bob/work/src/app.ts:98:1';

  assert.equal(fingerprint(a), fingerprint(b));
});

test('timestamps, hashes and durations do not split a pattern', () => {
  const a = 'build failed 2026-01-02T03:04:05Z sha a1b2c3d4e5f6 in 1200ms';
  const b = 'build failed 2026-08-09T22:11:00Z sha 9f8e7d6c5b4a in 340ms';

  assert.equal(fingerprint(a), fingerprint(b));
});

test('genuinely different errors do not collide', () => {
  // The costly direction: a false match produces a confidently wrong suggestion.
  assert.notEqual(
    fingerprint('cannot find module "left-pad"'),
    fingerprint('type number is not assignable to string')
  );
});

test('normalisation keeps the words that identify the error', () => {
  const normalized = normalizeError('TypeError: x is not a function at /a/b.ts:3:9');

  assert.match(normalized, /TypeError/);
  assert.match(normalized, /not a function/);
});

// ---------------------------------------------------------------- counting

const KEY = 'k';

function occur(state = emptyState(), times: number, now: number) {
  let s = state;
  let last;
  for (let i = 0; i < times; i++) {
    last = recordOccurrence(s, KEY, 'boom', now);
    s = last.state;
  }
  return { state: s, last: last! };
}

test('stays silent below the threshold', () => {
  const { last } = occur(emptyState(), THRESHOLD - 1, 1000);

  assert.equal(last.shouldSurface, false);
});

test('surfaces exactly on the threshold occurrence', () => {
  const { last } = occur(emptyState(), THRESHOLD, 1000);

  assert.equal(last.shouldSurface, true);
});

test('does not surface again on every later occurrence', () => {
  // A permanently broken build must not repeat the same remark on every run.
  const { last } = occur(emptyState(), THRESHOLD + 2, 1000);

  assert.equal(last.shouldSurface, false);
});

test('occurrences outside the window do not accumulate', () => {
  const now = 1_000_000_000;
  let state = recordOccurrence(emptyState(), KEY, 'boom', now - WINDOW_MS - 1).state;
  state = recordOccurrence(state, KEY, 'boom', now - WINDOW_MS - 2).state;

  // Two stale hits plus one fresh: still the first within the window, so silence.
  const result = recordOccurrence(state, KEY, 'boom', now);

  assert.equal(result.pattern.occurrences.length, 1);
  assert.equal(result.shouldSurface, false);
});

test('a stored fix survives further occurrences', () => {
  let state = occur(emptyState(), 1, 1000).state;
  state = recordResolution(state, KEY, 'pnpm store prune');
  const next = recordOccurrence(state, KEY, 'boom', 2000);

  assert.equal(next.pattern.resolvedBy, 'pnpm store prune');
});

test('one-off errors are not offered to the briefing', () => {
  const state = occur(emptyState(), 1, 1000).state;

  assert.equal(topPattern(state, 1000), undefined, 'seen once is not a pattern');
});

test('the briefing gets the most repeated pattern', () => {
  let state = emptyState();
  state = recordOccurrence(state, 'rare', 'a', 1000).state;
  state = recordOccurrence(state, 'rare', 'a', 1001).state;
  for (let i = 0; i < 5; i++) state = recordOccurrence(state, 'common', 'b', 1000 + i).state;

  assert.equal(topPattern(state, 1005)?.key, 'common');
});

test('a corrupt store starts empty rather than throwing', () => {
  assert.deepEqual(parseState(undefined), emptyState());
  assert.deepEqual(parseState('garbage'), emptyState());
  assert.deepEqual(parseState({ version: 99, patterns: {} }), emptyState());
  assert.deepEqual(parseState({ version: 1, patterns: { k: { sample: 5 } } }), emptyState());
});

// ---------------------------------------------------------------- fix attribution

test('an unrelated success is not credited as the fix', () => {
  // The case M5's build notes got wrong: "the next successful command" is almost
  // never the fix, because you run `git status` and three other innocent things first.
  let pending = beginPending(KEY, 'npm test');
  pending = noteOutcome(pending, 'git status', true).pending!;
  pending = noteOutcome(pending, 'ls', true).pending!;

  const result = noteOutcome(pending, 'npm run lint', true);

  assert.equal(result.resolvedBy, undefined, 'nothing is confirmed until npm test passes');
});

test('the fix is credited only when the failing command goes green', () => {
  let pending = beginPending(KEY, 'npm test');
  pending = noteOutcome(pending, 'git status', true).pending!;
  pending = noteOutcome(pending, 'npm install', true).pending!;

  const result = noteOutcome(pending, 'npm test', true);

  assert.equal(result.resolvedBy, 'npm install', 'the last thing tried before it passed');
  assert.equal(result.pending, undefined, 'attribution closes');
});

test('a repeat failure discards the candidates that clearly did not work', () => {
  let pending = beginPending(KEY, 'npm test');
  pending = noteOutcome(pending, 'npm install', true).pending!;
  pending = noteOutcome(pending, 'npm test', false).pending!;

  assert.deepEqual(pending.candidates, [], 'npm install did not fix it; do not credit it later');

  pending = noteOutcome(pending, 'rm -rf node_modules && npm ci', true).pending!;
  const result = noteOutcome(pending, 'npm test', true);

  assert.equal(result.resolvedBy, 'rm -rf node_modules && npm ci');
});

test('failures of unrelated commands are not treated as fixes', () => {
  let pending = beginPending(KEY, 'npm test');
  pending = noteOutcome(pending, 'npm run build', false).pending!;

  const result = noteOutcome(pending, 'npm test', true);

  assert.equal(result.resolvedBy, undefined, 'a command that itself failed fixed nothing');
});

test('passing with nothing in between credits nothing', () => {
  // Flaky test that passes on retry — no fix happened, so claim none.
  const pending = beginPending(KEY, 'npm test');
  const result = noteOutcome(pending, 'npm test', true);

  assert.equal(result.resolvedBy, undefined);
});

test('forgetting a job drops what was remembered about it', () => {
  // Two stores answer different questions — "what broke last" and "what keeps breaking"
  // — and clearing only the first left him still opening with "seen probe-build-fail 4x
  // this week", which to the person who just asked him to drop it is the same subject
  // raised again.
  const state = {
    version: 1 as const,
    patterns: {
      a: { key: 'a', sample: 'probe-build-fail exited 1', occurrences: [1, 2], resolvedBy: undefined },
      b: { key: 'b', sample: 'TypeError: undefined is not a function', occurrences: [3], resolvedBy: undefined },
    },
  };

  const { state: next, removed } = forgetMatching(state, 'probe-build-fail');

  assert.equal(removed, 1);
  assert.deepEqual(Object.keys(next.patterns), ['b']);
});

test('forgetting nothing in particular changes nothing', () => {
  const state = { version: 1 as const, patterns: { a: { key: 'a', sample: 'x', occurrences: [1], resolvedBy: undefined } } };

  assert.equal(forgetMatching(state, '   ').removed, 0);
  assert.equal(forgetMatching(state, 'unrelated').removed, 0);
});

test('a pattern seen twice is not yet worth a briefing line', () => {
  // It used to surface at two, and a briefing opened with a TypeScript error recorded
  // twice while the editor was still loading its types — a phantom pattern presented as
  // the most notable thing about the project. §4.2 is three times in seven days.
  const now = Date.now();
  const twice = {
    version: 1 as const,
    patterns: { a: { key: 'a', sample: 'Type error', occurrences: [now - 1000, now], resolvedBy: undefined } },
  };

  assert.equal(topPattern(twice, now), undefined);

  const thrice = {
    version: 1 as const,
    patterns: {
      a: { key: 'a', sample: 'Type error', occurrences: [now - 2000, now - 1000, now], resolvedBy: undefined },
    },
  };

  assert.equal(topPattern(thrice, now)?.count, 3);
});

test('a pattern hit says what the error was and where it is', () => {
  // "That's 3 times this week. No fix on record yet." was the whole line — a count and
  // nothing else, so the only fact delivered was a number and the rewrite filled the
  // silence with whatever sounded plausible. Reported as too vague on first sight.
  const line = patternHitLine('Expected ":"', { file: 'nanocode.py', line: 24 });

  assert.match(line.text, /Expected ":"/);
  assert.match(line.text, /nanocode\.py line 24/);
  assert.match(line.text, /3 times this week/);
});

test('everything specific in it is protected from the rewrite', () => {
  // The parts that could send someone to the wrong line are the parts a paraphrase
  // must not touch.
  const line = patternHitLine('Expected ":"', { file: 'nanocode.py', line: 24 }, 'pnpm store prune');

  assert.ok(line.keep.includes('Expected ":"'));
  assert.ok(line.keep.includes('nanocode.py'));
  assert.ok(line.keep.includes('line 24'));
  assert.ok(line.keep.includes('pnpm store prune'));
});

test('an error with no file still names the error', () => {
  // Terminal failures have no line to point at, and a count on its own is what this
  // was fixing.
  const line = patternHitLine('ENOENT: no such file');

  assert.match(line.text, /ENOENT: no such file/);
  assert.doesNotMatch(line.text, /line \d/);
});

test('a remembered fix is offered as a record, never as a promise', () => {
  const line = patternHitLine('x', undefined, 'pnpm store prune');

  assert.match(line.text, /pnpm store prune/);
  assert.match(line.text, /make no promises/);
});
