import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffOffer, MARKER, parseNervisTask } from './nervisHandoff';

/**
 * The parsing, which is where everything about a handoff can go wrong. The
 * caller only decides whether to offer what comes back.
 */

const WRITTEN = `${MARKER}
# Task from NERVIS

add a retry to the uploader when the API returns 429

---

_Handed over from NERVIS chat on 2026-09-02 10:15 UTC, conversation \`cv_ab12\`. You asked for this in conversation rather than in the editor, so read it before approving._
`;

test('a task NERVIS wrote is read back with its origin', () => {
  const task = parseNervisTask(WRITTEN);
  assert.equal(task?.task, 'add a retry to the uploader when the API returns 429');
  assert.equal(task?.askedOn, '2026-09-02 10:15 UTC');
  assert.equal(task?.conversation, 'cv_ab12');
});

test('a handoff is recognised by its content rather than its name', () => {
  // A file somebody wrote themselves and happened to name clarvis-task.md is
  // not a handoff, and treating it as one would tell them another program
  // authored their own words.
  assert.equal(parseNervisTask('# Task from NERVIS\n\nmine, actually'), undefined);
});

test('a marker with nothing under it is not a task', () => {
  assert.equal(parseNervisTask(`${MARKER}\n# Task from NERVIS\n\n\n---\n`), undefined);
});

test('a handoff with no conversation stops at the timestamp', () => {
  // The case the fixtures missed on both sides. Without a conversation there is
  // no comma after the stamp, and a greedy read ran on into the sentence — the
  // offer then told the person the task "came from NERVIS on 2026-09-01 22:21
  // UTC. You asked for this in conversation rather than in the editor".
  const alone = `${MARKER}
# Task from NERVIS

fix the export bug

---

_Handed over from NERVIS chat on 2026-09-01 22:21 UTC. You asked for this in conversation rather than in the editor, so read it before approving._
`;
  const task = parseNervisTask(alone);
  assert.equal(task?.askedOn, '2026-09-01 22:21 UTC');
  assert.equal(task?.conversation, undefined);
});

test('a hand-edited file that lost its footer still reads', () => {
  // The other half of "a person can edit this": a parser that refused would
  // make the file unusable the first time anybody tidied it.
  const tidied = `${MARKER}\n# Task from NERVIS\n\nfix the export bug\n`;
  assert.equal(parseNervisTask(tidied)?.task, 'fix the export bug');
  assert.equal(parseNervisTask(tidied)?.askedOn, '');
});

test('the offer leads with where the task came from', () => {
  // Not a footnote: the origin is what changes how the rest should be read, and
  // the person approving is the only one who can apply that.
  const offer = handoffOffer({ task: 'do the thing', askedOn: '2026-09-02', conversation: 'cv_1' });
  assert.ok(offer.startsWith('This came from NERVIS'));
  assert.match(offer, /Nothing has run/);
  assert.match(offer, /you can edit it first/);
});
