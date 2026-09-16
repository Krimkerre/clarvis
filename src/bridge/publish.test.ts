import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Activity } from './activity';
import { EventStream } from './events';
import { publishActivity } from './publish';

/**
 * What a dashboard would actually see. Driven through the real `Activity` rather
 * than by handing `eventFor` synthetic transitions, because half of what could
 * be wrong here is which transitions `Activity` produces at all.
 */
function watched() {
  const activity = new Activity(() => 5_000);
  const events = new EventStream(() => 0);
  const stop = publishActivity(activity, events);
  return {
    activity,
    events,
    stop,
    names: () => events.since(0).map((event) => event.name),
    last: () => events.since(0).at(-1),
  };
}

// ── Runs ────────────────────────────────────────────────────────────────────

test('a run that finishes is started then completed', () => {
  const it = watched();

  it.activity.startRun();
  it.activity.finish();

  assert.deepEqual(it.names(), ['clarvis.agent.started', 'clarvis.agent.completed']);
});

test('a run that fails is reported as failed, with no reason', () => {
  const it = watched();

  it.activity.startRun();
  it.activity.fail();

  assert.equal(it.last()?.name, 'clarvis.agent.failed');
  assert.equal('reason' in (it.last()?.data ?? {}), false);
  assert.equal('error' in (it.last()?.data ?? {}), false);
});

test('a run that was stopped is cancelled, not failed', () => {
  // The user pressing Stop got what they asked for. Reporting it as a failure
  // would put a red row on the dashboard for a working feature.
  const it = watched();

  it.activity.startRun();
  it.activity.stopping();
  it.activity.fail();

  assert.equal(it.last()?.name, 'clarvis.agent.cancelled');
});

test('stopping on its own publishes nothing', () => {
  // §6.4 has no `stopping` name: a stop that is still being honoured has not
  // cancelled anything yet, and the `cancelled` event belongs at the end.
  const it = watched();
  it.activity.startRun();

  it.activity.stopping();

  assert.deepEqual(it.names(), ['clarvis.agent.started']);
});

test('each step is published with the count so far', () => {
  const it = watched();
  it.activity.startRun();

  it.activity.noteStep();
  it.activity.noteStep();

  assert.deepEqual(it.names().slice(1), ['clarvis.agent.step', 'clarvis.agent.step']);
  assert.equal(it.last()?.data.steps_taken, 2);
});

test('a step outside a run publishes nothing', () => {
  const it = watched();

  it.activity.noteStep();

  assert.deepEqual(it.names(), []);
});

// ── Chat ────────────────────────────────────────────────────────────────────

test('a published turn names its trace and its session at both ends', () => {
  // What NERVIS joins on (runbook §4.3): the start and the completion must both
  // carry the trace and the session the turn's model requests carry.
  const it = watched();

  it.activity.startChat('trace-9', 'session-9');
  it.activity.finish();

  assert.deepEqual(
    it.events.since(0).map((event) => [event.name, event.trace_id, event.session_id]),
    [
      ['clarvis.chat.started', 'trace-9', 'session-9'],
      ['clarvis.chat.completed', 'trace-9', 'session-9'],
    ]
  );
});

test('a chat turn is chat, not agent', () => {
  // §6.4 lists them separately because one edits files and the other does not.
  const it = watched();

  it.activity.startChat();
  it.activity.finish();

  assert.deepEqual(it.names(), ['clarvis.chat.started', 'clarvis.chat.completed']);
});

test('a stopped chat turn is chat.cancelled', () => {
  // The transition that made `kind` necessary: by the time `idle` is reached
  // through `stopping`, nothing in the state remembers which it was.
  const it = watched();

  it.activity.startChat();
  it.activity.stopping();
  it.activity.fail();

  assert.equal(it.last()?.name, 'clarvis.chat.cancelled');
});

test('a chat turn that fails is chat.failed', () => {
  const it = watched();

  it.activity.startChat();
  it.activity.fail();

  assert.equal(it.last()?.name, 'clarvis.chat.failed');
});

// ── Gates ───────────────────────────────────────────────────────────────────

test('a gate is announced as a category, never as its question', () => {
  const it = watched();
  it.activity.startRun();

  it.activity.awaitApproval('sensitive_read');

  assert.equal(it.last()?.name, 'clarvis.gate.requested');
  assert.equal(it.last()?.data.awaiting, 'sensitive_read');
});

test('a resolved gate does not say which way it went', () => {
  // §6.4 forbids approval details, and whether the user said yes is the most
  // detailed thing there is about a gate.
  const it = watched();
  it.activity.startRun();
  it.activity.awaitApproval('command');

  it.activity.resolveApproval();

  assert.equal(it.last()?.name, 'clarvis.gate.resolved');
  assert.deepEqual(Object.keys(it.last()?.data ?? {}), ['activity_id']);
});

test('resolving a gate does not look like the run starting again', () => {
  // `agent_running` reached from `waiting_for_approval` is a gate closing, and a
  // listener given only the destination would call it a second run.
  const it = watched();
  it.activity.startRun();
  it.activity.awaitApproval('command');

  it.activity.resolveApproval();

  assert.equal(it.names().filter((name) => name === 'clarvis.agent.started').length, 1);
});

test('a gate opened and closed between two polls still leaves a trace', () => {
  // The reason this is an observer rather than a poll: the state is identical
  // before and after, and this is the one thing §6.7 says NERVIS may be shown.
  const it = watched();
  it.activity.startRun();
  const before = it.activity.snapshot();

  it.activity.awaitApproval('command');
  it.activity.resolveApproval();

  assert.deepEqual(it.activity.snapshot().state, before.state);
  assert.deepEqual(it.names().slice(1), ['clarvis.gate.requested', 'clarvis.gate.resolved']);
});

// ── Payloads ────────────────────────────────────────────────────────────────

test('every payload is primitives, and nothing else', () => {
  const it = watched();
  it.activity.startRun();
  it.activity.noteStep();
  it.activity.awaitApproval('command');
  it.activity.resolveApproval();
  it.activity.finish();

  for (const event of it.events.since(0)) {
    for (const [key, value] of Object.entries(event.data)) {
      assert.ok(
        ['string', 'number', 'boolean'].includes(typeof value),
        `${event.name}.${key} is a ${typeof value}`
      );
    }
  }
});

test('the activity id is opaque and cannot be chosen by a caller', () => {
  // §6.3 calls it an opaque ID, and the only way that stays true is for nobody
  // to be able to pass one: a caller-supplied id is the single free-form string
  // in a payload that is otherwise incapable of carrying a command or a path.
  const it = watched();

  it.activity.startRun();

  assert.match(String(it.last()?.data.activity_id), /^[0-9a-f]{16}$/);
});

test('two runs get different ids', () => {
  const it = watched();

  it.activity.startRun();
  const first = it.last()?.data.activity_id;
  it.activity.finish();
  it.activity.startRun();

  assert.notEqual(it.last()?.data.activity_id, first);
});

test('the id is not a count of how many runs this window has had', () => {
  // A zero-padded counter passes every check above — same shape, always
  // different — while publishing a fact nobody asked to publish. Two things
  // separate it from randomness, and both are needed: a counter kept per
  // `Activity` gives two fresh windows the same first id, and a counter kept at
  // module scope gives ids that only ever ascend.
  const first = watched();
  const second = watched();
  first.activity.startRun();
  second.activity.startRun();

  assert.notEqual(
    first.last()?.data.activity_id,
    second.last()?.data.activity_id,
    'a per-instance counter would give both windows the same first id'
  );

  const ids: number[] = [];
  for (let run = 0; run < 8; run += 1) {
    first.activity.finish();
    first.activity.startRun();
    ids.push(parseInt(String(first.last()?.data.activity_id), 16));
  }
  // Eight random values happen to arrive in ascending order once in 40,320 runs,
  // which is a rate this suite will not notice and a module-scoped counter fails
  // every time.
  assert.ok(
    ids.some((value, at) => at > 0 && value < ids[at - 1]),
    'every id was larger than the last, which is what a counter does'
  );
});

test('a completion carries the measured elapsed time and no invented total', () => {
  const it = watched();
  it.activity.startRun();

  it.activity.finish();

  assert.equal(typeof it.last()?.data.elapsed_ms, 'number');
  assert.equal('steps_total' in (it.last()?.data ?? {}), false);
});

// ── Detaching ───────────────────────────────────────────────────────────────

test('detaching stops the publishing', () => {
  const it = watched();

  it.stop();
  it.activity.startRun();

  assert.deepEqual(it.names(), []);
});

test('a redundant finish publishes nothing', () => {
  // `Busy.finish` is called from a `finally` that can run twice, and a second
  // `clarvis.agent.completed` would make a dashboard count two runs.
  const it = watched();
  it.activity.startRun();
  it.activity.finish();

  it.activity.finish();

  assert.equal(it.names().filter((name) => name === 'clarvis.agent.completed').length, 1);
});

// ── Hostile fixtures ────────────────────────────────────────────────────────

test('nothing a run does can put a command, a path or a secret in a payload', () => {
  // §6.4's forbidden list — source, terminal output, prompt and response text,
  // command strings, file contents, raw paths, secrets, approval details — is
  // entirely made of things that arrive as strings. This drives every transition
  // there is and checks that the only strings that come out are ones this file
  // chose: a state, a category, and an opaque id.
  const it = watched();

  it.activity.startRun();
  it.activity.noteStep();
  it.activity.awaitApproval('command');
  it.activity.resolveApproval();
  it.activity.awaitApproval('sensitive_read');
  it.activity.resolveApproval();
  it.activity.stopping();
  it.activity.fail();
  it.activity.startChat();
  it.activity.fail();

  const allowed = new Set(['activity_id', 'awaiting', 'steps_taken', 'elapsed_ms']);
  for (const event of it.events.since(0)) {
    for (const [key, value] of Object.entries(event.data)) {
      assert.ok(allowed.has(key), `${event.name} carries an unexpected field: ${key}`);
      if (key === 'activity_id') assert.match(String(value), /^[0-9a-f]{16}$/);
      if (key === 'awaiting') assert.match(String(value), /^(command|sensitive_read|step|other)$/);
      if (key !== 'activity_id' && key !== 'awaiting') assert.equal(typeof value, 'number');
    }
  }
});

test('the event names are the ones §6.4 lists', () => {
  // A typo here would publish a family nothing consumes, and it would look like
  // silence rather than like a mistake.
  const it = watched();
  it.activity.startRun();
  it.activity.noteStep();
  it.activity.awaitApproval('step');
  it.activity.resolveApproval();
  it.activity.finish();
  it.activity.startChat();
  it.activity.stopping();
  it.activity.fail();

  assert.deepEqual(it.names(), [
    'clarvis.agent.started',
    'clarvis.agent.step',
    'clarvis.gate.requested',
    'clarvis.gate.resolved',
    'clarvis.agent.completed',
    'clarvis.chat.started',
    'clarvis.chat.cancelled',
  ]);
});
