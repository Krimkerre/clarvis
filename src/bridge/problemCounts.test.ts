import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProblemWatch, countProblems, type Pacing, type ProblemCounts } from './problemCounts';

/** `clarvis.diagnostic.changed`: counts only, and paced so typing cannot flood the hub. */

test('problems are counted by severity, and files with any', () => {
  const counts = countProblems([
    ['/w/a.ts', [{ severity: 0 }, { severity: 0 }, { severity: 1 }]],
    ['/w/b.ts', [{ severity: 2 }, { severity: 3 }]],
    ['/w/c.ts', []],
  ]);
  assert.deepEqual(counts, { errors: 2, warnings: 1, information: 1, hints: 1, files: 2 });
  assert.ok(!JSON.stringify(counts).includes('/w/'), 'no file travels');
});

/** Timers the test fires by hand, and a clock it moves. */
function paced() {
  let clock = 0;
  const timers: { run: () => void; at: number; id: number }[] = [];
  let next = 1;
  const pacing: Pacing = {
    settleMs: 2_000,
    gapMs: 30_000,
    now: () => clock,
    schedule: (run, ms) => { const id = next++; timers.push({ run, at: clock + ms, id }); return id; },
    cancel: (id) => { const at = timers.findIndex((t) => t.id === id); if (at >= 0) timers.splice(at, 1); },
  };
  return {
    pacing,
    timers,
    /** Move the clock to the next timer and run it. */
    fire: () => { const timer = timers.shift(); if (timer) { clock = timer.at; timer.run(); } },
    advance: (ms: number) => { clock += ms; },
    /** Run every timer that is due by now, as the event loop would. */
    runDue: () => {
      for (const timer of timers.filter((t) => t.at <= clock)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
  };
}

const counts = (errors: number): ProblemCounts => ({ errors, warnings: 0, information: 0, hints: 0, files: errors ? 1 : 0 });

test('the counts are said at the start, then only once the editor settles, and only when they change', () => {
  const time = paced();
  let now = counts(0);
  const told: ProblemCounts[] = [];
  const watch = new ProblemWatch(() => now, (c) => told.push(c), time.pacing);

  watch.start();
  assert.deepEqual(told, [counts(0)]);

  // Typing: three changes in quick succession leave one timer.
  now = counts(1);
  watch.changed();
  time.advance(100);
  watch.changed();
  time.advance(100);
  watch.changed();
  assert.equal(time.timers.length, 1);

  // The gap from the first telling is still running, so the timer waits for it.
  assert.equal(time.timers[0].at, 30_000);
  time.fire();
  assert.deepEqual(told, [counts(0), counts(1)]);

  // A change that ends where it began is not news.
  watch.changed();
  time.fire();
  assert.equal(told.length, 2);
});

test('after a quiet spell a change waits only for the editor to settle', () => {
  const time = paced();
  let now = counts(0);
  const told: ProblemCounts[] = [];
  const watch = new ProblemWatch(() => now, (c) => told.push(c), time.pacing);
  watch.start();
  time.advance(60_000);

  now = counts(3);
  watch.changed();
  assert.equal(time.timers[0].at, 62_000);
  time.fire();
  assert.deepEqual(told.at(-1), counts(3));
});

test('at most two a minute, however the counts move', () => {
  const time = paced();
  let errors = 0;
  const told: ProblemCounts[] = [];
  const watch = new ProblemWatch(() => counts(errors), (c) => told.push(c), time.pacing);
  watch.start();
  // A change every three seconds — slow enough to settle each time — for a minute.
  for (let at = 0; at <= 60_000; at += 3_000) {
    errors += 1;
    watch.changed();
    time.advance(3_000);
    time.runDue();
  }
  assert.equal(told.length, 3, 'the start, then one change at 30 s and one at 60 s');
});

test('a disposed watch tells nothing more', () => {
  const time = paced();
  let now = counts(0);
  const told: ProblemCounts[] = [];
  const watch = new ProblemWatch(() => now, (c) => told.push(c), time.pacing);
  watch.start();
  now = counts(5);
  watch.changed();
  watch.dispose();
  assert.equal(time.timers.length, 0);
});
