import test from 'node:test';
import assert from 'node:assert';
import { capKeyFor, withinCap } from './dailyCap';

// The only spend guard this product actually ships, and until 16 Aug it had no test of
// any kind — it lived inside a class importing `vscode`, which this suite cannot load.
// The two settings that were supposed to cap chat and agent spend were never built at
// all (see plan.md §7, M8h), so everything below is the whole of what stands between a
// runaway loop and a bill.

test('the cap is the number the user typed, not one fewer', () => {
  // 200 must permit the 200th request and refuse the 201st. Off-by-one here is invisible
  // in use and permanently wrong.
  assert.equal(withinCap(199, 200), true);
  assert.equal(withinCap(200, 200), false);
  assert.equal(withinCap(201, 200), false);
});

test('a fresh day allows the first request', () => {
  assert.equal(withinCap(0, 200), true);
});

test('a cap of zero means zero, not unlimited', () => {
  // The failure mode this exists to prevent: treating a falsy or nonsense cap as "no
  // limit configured, so spend freely". A spend guard must fail toward refusing.
  assert.equal(withinCap(0, 0), false);
});

test('a negative or non-numeric cap refuses rather than spends', () => {
  assert.equal(withinCap(0, -1), false);
  assert.equal(withinCap(0, Number.NaN), false);
});

test('an unreadable count is treated as spent, not as zero', () => {
  // `globalState.get` returns a default the caller chooses; if that ever becomes
  // something non-numeric, `used < cap` would silently pass. Guard the comparison from
  // this side too.
  assert.equal(withinCap(Number.NaN, 200), false);
});

test('each day gets its own counter key', () => {
  const monday = capKeyFor(new Date('2026-08-17T12:00:00Z'));
  const tuesday = capKeyFor(new Date('2026-08-18T12:00:00Z'));

  assert.notEqual(monday, tuesday);
  assert.equal(monday, 'clarvis.voice.requests.2026-08-17');
});

test('the same day produces the same key regardless of the time within it', () => {
  // The rollover has to come from the date alone — a key that varied by hour would reset
  // the cap constantly and guard nothing.
  const morning = capKeyFor(new Date('2026-08-17T00:00:01Z'));
  const night = capKeyFor(new Date('2026-08-17T23:59:59Z'));

  assert.equal(morning, night);
});

test('the day boundary is UTC — which is not the user’s midnight', () => {
  // **Documenting current behaviour, not endorsing it.** `toISOString()` is UTC, so in
  // CEST (UTC+2) the cap resets at 02:00 local, and a request made at 01:00 on Tuesday
  // still counts against Monday's allowance.
  //
  // Whether that is a defect depends on what the cap is for: as a *bill* guard, "a day"
  // is arbitrary and UTC is as good as anything. As a guard someone reasons about at
  // their own desk, it is wrong. The extraction that added this test deliberately did
  // not change it — see plan.md §7, M8h. This test exists so the decision is a decision
  // rather than an accident, and will fail loudly if anyone changes it by accident.
  const lateCestEvening = new Date('2026-08-17T23:30:00+02:00'); // 21:30 UTC, Monday
  const justAfterCestMidnight = new Date('2026-08-18T00:30:00+02:00'); // 22:30 UTC, Monday

  assert.equal(capKeyFor(lateCestEvening), 'clarvis.voice.requests.2026-08-17');
  assert.equal(
    capKeyFor(justAfterCestMidnight),
    'clarvis.voice.requests.2026-08-17',
    'a new local day still reads the previous UTC day’s counter'
  );
});
