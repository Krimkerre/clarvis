import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecentFiles } from './recentFiles';
import { foldOutcome, activeFailure, parseRecord, FAILURE_TTL_MS } from './lastFailure';
import { buildBriefingLines } from './briefingLines';
import type { Outcome } from '../watch/BusyTracker';

function outcome(overrides: Partial<Outcome> = {}): Outcome {
  return { id: 'a', source: 'task', label: 'npm test', exitCode: 1, durationMs: 5000, ...overrides };
}

// ---------------------------------------------------------------- recent files

test('lists most recently saved first', () => {
  const files = new RecentFiles();
  files.record('a.ts');
  files.record('b.ts');

  assert.deepEqual(files.list(), ['b.ts', 'a.ts']);
});

test('caps at capacity, dropping the oldest', () => {
  const files = new RecentFiles(3);
  ['a', 'b', 'c', 'd'].forEach((f) => files.record(f));

  assert.deepEqual(files.list(), ['d', 'c', 'b']);
});

test('re-saving a file moves it up instead of duplicating it', () => {
  // Saving one file repeatedly while debugging must not erase the memory of the others.
  const files = new RecentFiles(3);
  ['a', 'b', 'c'].forEach((f) => files.record(f));
  files.record('a');

  assert.deepEqual(files.list(), ['a', 'c', 'b']);
});

// ---------------------------------------------------------------- last failure

test('records a failure', () => {
  const next = foldOutcome(undefined, outcome({ exitCode: 1 }), 1000);

  assert.equal(next?.label, 'npm test');
  assert.equal(next?.exitCode, 1);
});

test('a later failure replaces an earlier one', () => {
  const first = foldOutcome(undefined, outcome({ label: 'npm test' }), 1000);
  const second = foldOutcome(first, outcome({ label: 'npm run build' }), 2000);

  assert.equal(second?.label, 'npm run build');
});

test('success on the same job clears the record', () => {
  // The dropped thread is no longer dropped.
  const failed = foldOutcome(undefined, outcome({ label: 'npm test', exitCode: 1 }), 1000);
  const fixed = foldOutcome(failed, outcome({ label: 'npm test', exitCode: 0 }), 2000);

  assert.equal(fixed, undefined);
});

test('success on a different job leaves the record alone', () => {
  // Lint passing says nothing about the test suite still being red.
  const failed = foldOutcome(undefined, outcome({ label: 'npm test', exitCode: 1 }), 1000);
  const unrelated = foldOutcome(failed, outcome({ label: 'npm run lint', exitCode: 0 }), 2000);

  assert.equal(unrelated?.label, 'npm test');
});

test('a cancelled job counts as unfinished, not as success', () => {
  const next = foldOutcome(undefined, outcome({ exitCode: undefined }), 1000);

  assert.equal(next?.label, 'npm test');
  assert.equal(next?.exitCode, undefined);
});

test('a failure older than the TTL is no longer reported', () => {
  const record = { label: 'npm test', exitCode: 1, at: 0 };

  assert.ok(activeFailure(record, FAILURE_TTL_MS - 1));
  assert.equal(activeFailure(record, FAILURE_TTL_MS + 1), undefined);
});

test('malformed persisted state is treated as absent', () => {
  // workspaceState survives crashes and version changes; it isn't automatically trusted.
  assert.equal(parseRecord(undefined), undefined);
  assert.equal(parseRecord('a string'), undefined);
  assert.equal(parseRecord({ label: 'x' }), undefined, 'missing timestamp');
  assert.equal(parseRecord({ at: 1 }), undefined, 'missing label');
  assert.ok(parseRecord({ label: 'npm test', at: 1, exitCode: 1 }));
});

// ---------------------------------------------------------------- lines

test('omits lines it has no facts for', () => {
  const lines = buildBriefingLines({ recentFiles: [] });

  assert.deepEqual(lines, [], 'a fresh window with no history says nothing at all');
});

/** Every phrasing, so a test covers all the wording rather than a lucky one. */
const VARIANTS = [0, 1, 2];

/** The whole briefing as one string — line positions shift with the opener. */
function briefing(facts: Parameters<typeof buildBriefingLines>[0], variant: number): string {
  return buildBriefingLines(facts, () => variant).join(' ');
}

test('reports branch and dirty count, with correct pluralisation', () => {
  for (const v of VARIANTS) {
    assert.match(briefing({ git: { branch: 'main', dirtyCount: 1 }, recentFiles: [] }, v), /1 file\b/);
    assert.match(briefing({ git: { branch: 'main', dirtyCount: 3 }, recentFiles: [] }, v), /3 files\b/);
    assert.match(briefing({ git: { branch: 'main', dirtyCount: 0 }, recentFiles: [] }, v), /clean|tidy/);
  }
});

test('shows file names, not full paths', () => {
  for (const v of VARIANTS) {
    const text = briefing({ recentFiles: ['/a/b/checkout.ts', '/a/b/cart.ts'] }, v);

    assert.match(text, /checkout\.ts/);
    assert.ok(!text.includes('/a/b/'), 'paths are noise in a one-line summary');
  }
});

test('every briefing opens in character, in all phrasings', () => {
  // The opener is what stops this reading like a status bar, so it must exist for
  // every combination of facts — not only the ones that happen to be tested below.
  for (const v of VARIANTS) {
    assert.match(briefing({ recentFiles: ['a.ts'] }, v), /^(You|Welcome|There you are|Morning|Ah)/);
    assert.match(
      briefing({ failure: { label: 'npm test', exitCode: 1, at: 0 }, recentFiles: [] }, v),
      /^(You|Welcome|Ah)/
    );
  }
});

test('the opener matches the mood of the facts', () => {
  // Greeting someone cheerfully over a red build is the exact thing that makes a
  // character feel like a template.
  for (const v of VARIANTS) {
    const red = buildBriefingLines(
      { failure: { label: 'npm test', exitCode: 1, at: 0 }, recentFiles: [] },
      () => v
    )[0];

    assert.doesNotMatch(red, /nothing exploded|all quiet|roughly where you left it/i);
  }
});

test('an opener alone is never a briefing', () => {
  // §4.3: silence when there is nothing to report. An opener on its own is a chatbot
  // saying hello, which is precisely what that rule exists to prevent.
  assert.deepEqual(buildBriefingLines({ recentFiles: [] }), []);
});

test('when facts outnumber the space, the least useful line is dropped', () => {
  // Four facts plus an opener exceeds the cap. What you were editing is pleasant
  // context; a red build and a recurring error are why this feature exists.
  const lines = buildBriefingLines(
    {
      failure: { label: 'npm test', exitCode: 1, at: 0 },
      patternHint: 'That ECONNREFUSED again.',
      git: { branch: 'main', dirtyCount: 2 },
      recentFiles: ['/a/b/checkout.ts'],
    },
    () => 0
  );

  assert.equal(lines.length, 4);
  assert.match(lines.join(' '), /npm test/);
  assert.match(lines.join(' '), /ECONNREFUSED/);
  assert.ok(!lines.join(' ').includes('checkout.ts'), 'recent files is the first to go');
});

test('distinguishes a failed job from an unfinished one', () => {
  for (const v of VARIANTS) {
    const failed = briefing({ failure: { label: 'npm test', exitCode: 1, at: 0 }, recentFiles: [] }, v);
    const cancelled = briefing(
      { failure: { label: 'npm test', exitCode: undefined, at: 0 }, recentFiles: [] },
      v
    );

    assert.notEqual(failed, cancelled, 'calling a cancelled job "red" would be a lie');
    // No phrasing of the cancelled case may imply it failed — it never finished.
    assert.doesNotMatch(cancelled, /red|failed|failing/i);
  }
});

test('caps at four lines', () => {
  const lines = buildBriefingLines({
    git: { branch: 'main', dirtyCount: 2 },
    failure: { label: 'npm test', exitCode: 1, at: 0 },
    recentFiles: ['a.ts', 'b.ts'],
    patternHint: 'Seen this three times this week.',
  });

  assert.equal(lines.length, 4);
});

test('restores a previous session, still newest-first and capped', () => {
  // The briefing reads this before anything has been saved this session, so the
  // restored list is the entire point.
  const files = new RecentFiles(3, ['b.ts', 'a.ts']);
  files.record('c.ts');

  assert.deepEqual(files.list(), ['c.ts', 'b.ts', 'a.ts']);
});

test('restoring more than capacity truncates', () => {
  const files = new RecentFiles(2, ['a', 'b', 'c', 'd']);

  assert.deepEqual(files.list(), ['a', 'b']);
});

import { briefingPrompt } from './briefingLines';

test('the briefing prompt carries the facts and the rules', () => {
  // Same division as chat: this module knows what happened, the model knows how to
  // say it. The §4.3 rules are repeated rather than left to inference.
  const prompt = briefingPrompt({
    git: { branch: 'main', dirtyCount: 2 },
    failure: { label: 'npm test', exitCode: 1, at: 0 },
    recentFiles: ['/a/b/checkout.ts'],
    patternHint: 'That ECONNREFUSED again.',
  })!;

  assert.match(prompt, /main/);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /checkout\.ts/);
  assert.match(prompt, /ECONNREFUSED/);
  assert.match(prompt, /four short sentences/);
  assert.match(prompt, /never cheerful about a failure/);
});

test('the closed-list rule sits with the facts, and names what is not known', () => {
  // Found live: the rule lived in the system prompt as "no facts beyond what appears
  // above" while the facts arrived in the user turn — plainly false as written, and
  // discarded along with everything attached to it. The briefing then invented a
  // failing `npm run build`, a branch called main, and "47 passing tests and 3
  // failing ones, all in the auth module", in a workspace with neither tests nor git.
  const prompt = briefingPrompt({ recentFiles: ['/a/b/settings.json'] })!;

  assert.match(prompt, /That list is complete/);
  assert.match(prompt, /whether any test/);
  assert.match(prompt, /a number you invented/);
  // The rule has to come after the facts it closes off, or it describes an empty list.
  assert.ok(prompt.indexOf('That list is complete') > prompt.indexOf('settings.json'));
});

test('nothing observed means no prompt, so silence stays silence', () => {
  // A model asked to brief on an empty list will always find something to say, and
  // §4.3 is explicit that a fresh window with nothing to report says nothing.
  assert.equal(briefingPrompt({ recentFiles: [] }), undefined);
});

test('an unfinished job is not described as a failure in the prompt', () => {
  // The same distinction the written lines make: no exit code means it never
  // finished, and calling that "failed" would be a lie the model would repeat.
  const prompt = briefingPrompt({ failure: { label: 'npm test', exitCode: undefined, at: 0 }, recentFiles: [] })!;

  assert.match(prompt, /still running/);
  assert.ok(!/failed with exit/.test(prompt), prompt);
});

import { isWorthRemembering } from './recentFiles';

test("git's own scratch files are not the user's work", () => {
  // Seen in a real session: committing through the Source Control view saves
  // COMMIT_EDITMSG, and the briefing reported "last edits were to plan.md, README.md,
  // and a commit message".
  assert.equal(isWorthRemembering('/p/.git/COMMIT_EDITMSG'), false);
  assert.equal(isWorthRemembering('/p/.git/MERGE_MSG'), false);
  assert.equal(isWorthRemembering('/p/.git/rebase-merge/done'), false);
  assert.equal(isWorthRemembering('/p/node_modules/x/index.js'), false);
});

test('ordinary files are still remembered', () => {
  assert.equal(isWorthRemembering('/p/src/app.ts'), true);
  assert.equal(isWorthRemembering('/p/README.md'), true);
  // A file that merely mentions git in its name is the user's, not git's.
  assert.equal(isWorthRemembering('/p/src/gitStatus.ts'), true);
});
