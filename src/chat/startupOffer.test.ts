import test from 'node:test';
import assert from 'node:assert/strict';
import { startupOffer, StartupState } from './startupOffer';

/**
 * Nothing waiting, nothing started, nothing declined — the state a fresh folder is in.
 * Each test names only what it is about, so what it is about stays readable.
 */
const nothing: StartupState = {
  nervisTaskWaiting: false,
  planExists: false,
  buildInProgress: false,
  interviewInProgress: false,
  planningDeclined: false,
};

const state = (some: Partial<StartupState>): StartupState => ({ ...nothing, ...some });

test('a build in progress wins, and needs the plan to exist', () => {
  // The bug this file was written for: the resume-build offer sat behind a guard that
  // returned when plan.md existed — and a build in progress always has one, so it never
  // ran. Milestones 1 to 3 finished, window reopened, nothing offered.
  assert.equal(startupOffer(state({ planExists: true, buildInProgress: true })), 'resume-build');
});

test('a plan nobody has started is not an invitation', () => {
  // Asking every window open whether to start a plan they approved and left is the
  // nagging §6 exists to prevent.
  assert.equal(startupOffer(state({ planExists: true })), 'nothing');
});

test('a half-finished interview is offered when there is no plan yet', () => {
  assert.equal(startupOffer(state({ interviewInProgress: true })), 'resume-interview');
});

test('a folder with nothing in it gets the offer planning exists for', () => {
  assert.equal(startupOffer(nothing), 'offer-planning');
});

test('a build beats an interview, whichever else is true', () => {
  // Both can be true: an interview that was replanned mid-build leaves a snapshot
  // behind. The build is the thing with committed work behind it.
  assert.equal(
    startupOffer(state({ planExists: true, buildInProgress: true, interviewInProgress: true })),
    'resume-build'
  );
});

// ── The NERVIS handoff (E-C8) ───────────────────────────────────────────────

test('a task handed over from NERVIS is offered first', () => {
  // The most specific and most recent thing anyone has asked for here: somebody typed
  // it into a chat and pressed a button minutes ago.
  assert.equal(startupOffer(state({ nervisTaskWaiting: true })), 'nervis-handoff');
});

test('the handoff beats every other offer, including a build in progress', () => {
  assert.equal(
    startupOffer(
      state({
        nervisTaskWaiting: true,
        planExists: true,
        buildInProgress: true,
        interviewInProgress: true,
      })
    ),
    'nervis-handoff'
  );
});

test('declining to plan this project does not decline a task handed over', () => {
  // The exemption used to be a line position and a comment — the handoff `if` sat above
  // the decline guard, and nothing could ask whether it still did. PLAN_OFFER_DECLINED
  // is an answer about planning *this project*, not about a task somebody just sent.
  assert.equal(
    startupOffer(state({ nervisTaskWaiting: true, planningDeclined: true })),
    'nervis-handoff'
  );
});

test('a decline silences everything else', () => {
  // Preserved behaviour, stated so a change to it has to be deliberate: the guard has
  // always run before this decision, so declining planning has always suppressed the
  // resume offers too.
  assert.equal(
    startupOffer(state({ planningDeclined: true, planExists: true, buildInProgress: true })),
    'nothing'
  );
  assert.equal(
    startupOffer(state({ planningDeclined: true, interviewInProgress: true })),
    'nothing'
  );
  assert.equal(startupOffer(state({ planningDeclined: true })), 'nothing');
});
