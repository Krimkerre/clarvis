import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../test/fakes/relayContract';
import { adoptionDecision, judgeLock, onFindingALock, sameStart, THRESHOLD_SECONDS, type Verdict } from './lockRule';

/**
 * Every table in `lock-rule-cases.json`, one test per case, exactly as RAVIS runs the same file.
 *
 * Nothing here is restated from the design: the inputs and the expected answers are read from the
 * shared file, so the day RAVIS changes a case (and the hash check makes Clarvis copy it), these
 * tests hold Clarvis to the new one.
 */

const cases = fixture('lock-rule-cases.json');

test("the threshold is the shared rule's", () => {
  assert.equal(THRESHOLD_SECONDS, cases.rule.threshold_seconds);
});

for (const entry of cases.verdict_cases) {
  test(`verdict: ${entry.name} → ${entry.expected}`, () => {
    assert.equal(judgeLock(entry.lock, entry.probe, entry.observer_awake_seconds), entry.expected);
  });
}

for (const entry of cases.adoption_cases) {
  test(`restart adoption: ${entry.name} → ${entry.expected.action}`, () => {
    assert.deepEqual(adoptionDecision({ file: entry.file, create_race_lost: entry.create_race_lost }), entry.expected);
  });
}

/** The case file writes outcomes as sentences; this maps each one's opening to the decision it names. */
const OUTCOMES: Record<string, string> = {
  attach: 'attach',
  reconcile: 'reconcile',
  refuse: 'refuse',
  'take over with a confirmation naming the window and its age': 'take_over_with_confirmation',
};

for (const entry of cases.on_finding_a_lock) {
  test(`on finding a lock: ${entry.holder}, ${entry.verdict}${entry.waiting_on_you ? ', waiting on you' : ''} → ${entry.outcome.split(':')[0]}`, () => {
    const expected = OUTCOMES[entry.outcome.split(':')[0]];
    assert.ok(expected, `an outcome this test doesn't know: ${entry.outcome}`);

    // "any" means every verdict; a case that doesn't mention waiting holds either way.
    const verdicts: Verdict[] = entry.verdict === 'any' ? ['alive', 'unresponsive', 'gone'] : [entry.verdict];
    const waiting: boolean[] = entry.waiting_on_you === undefined ? [false, true] : [entry.waiting_on_you];
    for (const verdict of verdicts) {
      for (const waitingOnYou of waiting) {
        assert.equal(onFindingALock(entry.holder, verdict, waitingOnYou), expected, `${verdict}, waiting ${waitingOnYou}`);
      }
    }
  });
}

test("start times compare with ps's padding and trailing spaces ignored, and nothing else", () => {
  // ps pads a one-digit day with a second space and ends the line with spaces.
  assert.equal(sameStart('Sat Sep  5 09:10:36 2026    ', 'Sat Sep 5 09:10:36 2026'), true);
  assert.equal(sameStart('Sun Sep 13 05:10:02 2026', 'Sun Sep 13 05:10:03 2026'), false);
  assert.equal(sameStart('Sun Sep 13 05:10:02 2026', 'zo 13 sep 05:10:02 2026'), false);
});

test('a probe that found the pid running but no start time is not trusted as the same process', () => {
  // processProbe never produces this; if something else did, the rule's literal reading holds.
  const lock = { pid: 48123, pid_start: 'Sun Sep 13 05:10:02 2026', heartbeat_age_seconds: 3 };
  assert.equal(judgeLock(lock, { pid_running: true, lstart: null }, 600), 'gone');
});
