import test from 'node:test';
import assert from 'node:assert/strict';
import { clearsTheFile, decideHandoff } from './nervisOffer';
import { NervisTask } from '../planning/nervisHandoff';

const edited: NervisTask = { task: 'Add the retry, but only for 5xx', askedOn: '2026-09-05 09:00 UTC' };

test('yes runs what is on disk now, not what was offered', () => {
  // The offer says the task can be edited first. That is only true if the thing that
  // runs is the file as it stands at the moment of yes — running the copy captured when
  // the window opened would make the invitation to edit it a lie.
  assert.equal(decideHandoff('yes', edited), 'run');
});

test('yes to a task that has since gone is not a run', () => {
  // Deleted by hand, or picked up in another window, between the question and the
  // answer. Starting the remembered copy would run a document its author withdrew.
  assert.equal(decideHandoff('yes', undefined), 'withdrawn');
});

test('no forgets it, so the same task is not offered at every window', () => {
  assert.equal(decideHandoff('no', edited), 'forget');
});

test('a message about something else leaves the file alone', () => {
  // `offerAnswer` treats this as the common case — an offer appears while somebody was
  // already typing. Nobody answered, so nothing is thrown away.
  assert.equal(decideHandoff('unrelated', edited), 'left-alone');
});

test('only an ending removes the file', () => {
  // The two that must not delete: a withdrawn file, where there is nothing to delete,
  // and an unanswered offer, where it is not ours to throw away.
  assert.equal(clearsTheFile('run'), true);
  assert.equal(clearsTheFile('forget'), true);
  assert.equal(clearsTheFile('withdrawn'), false);
  assert.equal(clearsTheFile('left-alone'), false);
});
