import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Busy, type RunState } from './Busy';
import { Activity } from '../bridge/activity';
import type { ButlerViewProvider } from '../panels/ButlerViewProvider';
import * as fs from 'fs';
import * as path from 'path';

/**
 * `Busy` had no tests, and that is not an oversight anyone chose — it takes a
 * `ButlerViewProvider`, so it looked like a thing only the host suite could
 * reach. It is not: the import is type-only and TypeScript erases it, so the
 * compiled module requires nothing at all. The cost of nobody noticing was
 * `Busy.start('run')` sitting dead for the life of the feature.
 */

/** Everything `Busy` actually uses of the panel, and the posts it made. */
const fakePanel = () => {
  const posts: { type: string; busy?: boolean }[] = [];
  const panel = { post: (message: { type: string; busy?: boolean }) => posts.push(message) };
  return { posts, panel: panel as unknown as ButlerViewProvider };
};

const busyWith = (activity = new Activity(() => 0)) => {
  const { posts, panel } = fakePanel();
  const shared: RunState = { running: false, activity };
  return { busy: new Busy(panel, shared), shared, posts, activity };
};

// ── The regression that started this ─────────────────────────────────────────

test("a run says it is a run, and 'reply' does not", () => {
  // The bug: every call site passed `'reply'`, so `shared.running` was never set,
  // `isRunning` was permanently false, and the two suppressions that read it —
  // WatchPresenter's build outcome and ChatService's single "Stopped." — were
  // both silently off. Nothing failed, because nothing looked.
  const run = busyWith();
  run.busy.start('run');
  const reply = busyWith();
  reply.busy.start('reply');

  assert.equal(run.busy.isRunning, true);
  assert.equal(run.shared.running, true, 'the flag the quips and the watcher read');
  assert.equal(reply.busy.isRunning, false);
  assert.equal(reply.shared.running, false);
});

test('the kind reaches the reported state as well as the flag', () => {
  const run = busyWith();
  run.busy.start('run');
  const reply = busyWith();
  reply.busy.start('reply');

  assert.equal(run.activity.snapshot().state, 'agent_running');
  assert.equal(reply.activity.snapshot().state, 'chatting');
});

// ── Ending ───────────────────────────────────────────────────────────────────

test('finishing a run clears the shared flag and the state', () => {
  const { busy, shared, activity } = busyWith();
  busy.start('run');

  busy.finish();

  assert.equal(shared.running, false);
  assert.equal(busy.isBusy, false);
  assert.equal(activity.snapshot().state, 'idle');
});

test('finishing twice is harmless', () => {
  // The contract the doc comment claims, now checked: `finish` is called from a
  // `finally` that can run twice.
  const { busy, shared } = busyWith();
  busy.start('run');

  busy.finish();
  busy.finish();

  assert.equal(shared.running, false);
  assert.equal(busy.isBusy, false);
});

test('a run that threw is reported as failed, not as finished', () => {
  const { busy, activity } = busyWith();
  busy.start('run');

  busy.finish('failed');

  assert.equal(activity.snapshot().state, 'failed');
});

test('an ordinary finish defaults to success rather than guessing failure', () => {
  const { busy, activity } = busyWith();
  busy.start('reply');

  busy.finish();

  assert.equal(activity.snapshot().state, 'idle');
});

// ── Stop ─────────────────────────────────────────────────────────────────────

test('stop aborts the work in flight', () => {
  const { busy } = busyWith();
  const controller = busy.start('run');

  busy.stop();

  assert.equal(controller.signal.aborted, true);
});

test('a stopped run ends quietly, not as a failure', () => {
  // The abort surfaces to `RunSession` as a thrown error, so its `finally` reports
  // `'failed'` — correctly, since from there a stop and a crash are the same
  // thing. Only `Busy` knows a stop was asked for, so only `Busy` can be right.
  const { busy, activity } = busyWith();
  busy.start('run');

  busy.stop();
  busy.finish('failed');

  assert.equal(activity.snapshot().state, 'idle', 'the user got what they asked for');
});

test('pressing stop with nothing running reports nothing', () => {
  // A state nothing ever leaves: no work means no `finally` to clear it.
  const { busy, activity } = busyWith();

  busy.stop();

  assert.equal(activity.snapshot().state, 'idle');
});

test('the state says stopping while the abort is being honoured', () => {
  const { busy, activity } = busyWith();
  busy.start('run');

  busy.stop();

  assert.equal(activity.snapshot().state, 'stopping');
});

// ── The announcement ─────────────────────────────────────────────────────────

test('only the first stop of a piece of work is worth a sentence', () => {
  const { busy } = busyWith();
  busy.start('run');

  assert.equal(busy.claimAnnouncement(), true);
  assert.equal(busy.claimAnnouncement(), false);
  assert.equal(busy.claimAnnouncement(), false);
});

test('the next piece of work may be announced again', () => {
  const { busy } = busyWith();
  busy.start('run');
  busy.claimAnnouncement();

  busy.finish();
  busy.start('reply');

  assert.equal(busy.claimAnnouncement(), true);
});

// ── The panel ────────────────────────────────────────────────────────────────

test('the panel is told to show and hide the button', () => {
  const { busy, posts } = busyWith();

  busy.start('run');
  busy.finish();

  assert.deepEqual(posts, [
    { type: 'busy', busy: true },
    { type: 'busy', busy: false },
  ]);
});

test('starting again aborts what came before', () => {
  // A fresh controller each time, so Stop aborts this turn and not every future one.
  const { busy } = busyWith();
  const first = busy.start('reply');

  const second = busy.start('reply');

  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
});

// ── The call sites ───────────────────────────────────────────────────────────

/**
 * Everything above tests that `Busy` honours the kind it is given. The bug was
 * that nobody ever gave it `'run'` — so it lived at the call site, where the fast
 * suite cannot reach: `RunSession` imports `vscode`.
 *
 * So this guard reads the source, in the shape `src/meta/suite.test.ts` already
 * uses for the same reason: a failure that reads as coverage gets a check that
 * looks at the thing itself. It is deliberately narrow — one grep, one claim —
 * because a source-scanning test that tries to be clever goes stale faster than
 * the code it guards.
 */
test('something, somewhere, actually starts a run', () => {
  const root = findRepoRoot(__dirname);
  const sources = listSources(path.join(root, 'src'));
  const starts = sources.flatMap((file) => [
    ...fs.readFileSync(file, 'utf8').matchAll(/busy\.start\('(reply|run)'\)/g),
  ].map((match) => ({ file: path.relative(root, file), kind: match[1] })));

  assert.ok(starts.length > 0, 'no call site was found at all — has the API been renamed?');
  assert.ok(
    starts.some((start) => start.kind === 'run'),
    `every call site passes 'reply', so isRunning is dead again: ${JSON.stringify(starts)}`
  );
});

/** The repository root, found by walking up to the `package.json`. */
function findRepoRoot(start: string): string {
  let current = start;
  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('no package.json above ' + start);
    current = parent;
  }
}

/**
 * Every non-test `.ts` under a directory.
 *
 * **The exclusion is the whole guard.** The first draft included test files, and
 * the tests above call `busy.start('run')` — so the check passed while the real
 * call site was mutated back to `'reply'`. A guard satisfied by its own file is
 * the failure it was written to catch, one level up.
 */
function listSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}
