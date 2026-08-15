import test from 'node:test';
import assert from 'node:assert/strict';
import { startupOffer } from './startupOffer';

test('a build in progress wins, and needs the plan to exist', () => {
  // The bug this file was written for: the resume-build offer sat behind a guard that
  // returned when plan.md existed — and a build in progress always has one, so it never
  // ran. Milestones 1 to 3 finished, window reopened, nothing offered.
  assert.equal(
    startupOffer({ planExists: true, buildInProgress: true, interviewInProgress: false }),
    'resume-build'
  );
});

test('a plan nobody has started is not an invitation', () => {
  // Asking every window open whether to start a plan they approved and left is the
  // nagging §6 exists to prevent.
  assert.equal(
    startupOffer({ planExists: true, buildInProgress: false, interviewInProgress: false }),
    'nothing'
  );
});

test('a half-finished interview is offered when there is no plan yet', () => {
  assert.equal(
    startupOffer({ planExists: false, buildInProgress: false, interviewInProgress: true }),
    'resume-interview'
  );
});

test('a folder with nothing in it gets the offer planning exists for', () => {
  assert.equal(
    startupOffer({ planExists: false, buildInProgress: false, interviewInProgress: false }),
    'offer-planning'
  );
});

test('a build beats an interview, whichever else is true', () => {
  // Both can be true: an interview that was replanned mid-build leaves a snapshot
  // behind. The build is the thing with committed work behind it.
  assert.equal(
    startupOffer({ planExists: true, buildInProgress: true, interviewInProgress: true }),
    'resume-build'
  );
});
