import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Activity, toolEnding, whileAwaiting, type NoteChange } from './activity';
import { checkKind, checkResult } from './checks';

/**
 * M14's read-only seam. These tests exist in the fast suite precisely because
 * nothing else that knows Clarvis's state does: `Busy` reaches `vscode` through
 * `ButlerViewProvider`, and no test here imports `vscode`. That gap is how
 * `Busy.start('run')` stayed dead code — every call site passed `'reply'`, so
 * two suppressions that read the flag were silently off.
 */

const held = (start = 1_000) => {
  let now = start;
  return { clock: () => now, advance: (ms: number) => (now += ms) };
};

test('a fresh Activity is idle and claims nothing else', () => {
  const snapshot = new Activity(held().clock).snapshot();

  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.activity_id, undefined);
  assert.equal(snapshot.steps_taken, undefined, 'no run has taken a step');
  assert.equal(snapshot.awaiting, undefined);
});

test('a chat turn and an agent run are different states', () => {
  // §6.3 lists them separately because one edits files and the other does not.
  const chat = new Activity(held().clock);
  chat.startChat();
  const run = new Activity(held().clock);
  run.startRun();

  assert.equal(chat.snapshot().state, 'chatting');
  assert.equal(run.snapshot().state, 'agent_running');
});

test('steps are counted, and only during a run', () => {
  const activity = new Activity(held().clock);

  activity.noteStep();
  assert.equal(activity.snapshot().steps_taken, undefined, 'no run is in flight');

  activity.startRun();
  activity.noteStep();
  activity.noteStep();

  assert.equal(activity.snapshot().steps_taken, 2);
});

test('there is no total to invent', () => {
  // §6.3: "Never invent a duration, step total, branch, task or model route."
  // The absence of the field is the guarantee — a `steps_total` would be filled
  // with a guess by the first person who wanted a progress bar.
  const activity = new Activity(held().clock);
  activity.startRun();

  assert.ok(!('steps_total' in activity.snapshot()));
});

test('elapsed time is measured from the clock, not estimated', () => {
  const time = held();
  const activity = new Activity(time.clock);
  activity.startRun();

  time.advance(2_500);

  assert.equal(activity.snapshot().elapsed_ms, 2_500);
});

test('elapsed time restarts with the state, not with the process', () => {
  const time = held();
  const activity = new Activity(time.clock);
  activity.startRun();
  time.advance(5_000);

  activity.finish();
  time.advance(100);

  assert.equal(activity.snapshot().elapsed_ms, 100, 'idle began 100ms ago, not 5.1s');
});

// ── The gate: the one state §6.7 exists to permit ───────────────────────────

test('a gate is reported as a category and never as its question', () => {
  const activity = new Activity(held().clock);
  activity.startRun();

  activity.awaitApproval('command');
  const snapshot = activity.snapshot();

  assert.equal(snapshot.state, 'waiting_for_approval');
  assert.equal(snapshot.awaiting, 'command');
  // Nothing on the snapshot can carry the command string: the type has no field
  // for it, which is the point.
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    ['activity_id', 'awaiting', 'elapsed_ms', 'state', 'steps_taken'].sort()
  );
});

test('resolving a gate returns to the run it interrupted', () => {
  // Reporting `idle` after a gate inside a run would say the run had ended.
  const activity = new Activity(held().clock);
  activity.startRun();
  activity.awaitApproval('sensitive_read');

  activity.resolveApproval();

  assert.equal(activity.snapshot().state, 'agent_running');
});

test('resolving a gate raised outside a run returns to idle', () => {
  const activity = new Activity(held().clock);
  activity.awaitApproval('other');

  activity.resolveApproval();

  assert.equal(activity.snapshot().state, 'idle');
});

test('a second gate does not lose the state to return to', () => {
  const activity = new Activity(held().clock);
  activity.startRun();
  activity.awaitApproval('command');
  activity.awaitApproval('step');

  activity.resolveApproval();

  assert.equal(activity.snapshot().state, 'agent_running', 'the run was forgotten');
});

test('resolving when nothing was pending changes nothing', () => {
  const activity = new Activity(held().clock);
  activity.startRun();

  activity.resolveApproval();

  assert.equal(activity.snapshot().state, 'agent_running');
});

// ── Ending ──────────────────────────────────────────────────────────────────

test('stopping is its own state, distinct from idle', () => {
  const activity = new Activity(held().clock);
  activity.startRun();

  activity.stopping();

  assert.equal(activity.snapshot().state, 'stopping');
});

test('finishing clears the run it was describing', () => {
  const activity = new Activity(held().clock);
  activity.startRun();
  activity.noteStep();

  activity.finish();
  const snapshot = activity.snapshot();

  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.activity_id, undefined);
  assert.equal(snapshot.steps_taken, undefined);
});

test('a failure carries no reason', () => {
  // A failure reason is composed from a command, a path or a model response, and
  // §6.4 forbids every one of those leaving the machine.
  const activity = new Activity(held().clock);
  activity.startRun();

  activity.fail();
  const snapshot = activity.snapshot();

  assert.equal(snapshot.state, 'failed');
  assert.ok(!('reason' in snapshot));
  assert.ok(!('error' in snapshot));
});

test('a snapshot is a copy, so a reader cannot write back through it', () => {
  const activity = new Activity(held().clock);
  activity.startRun();

  const first = activity.snapshot();
  activity.noteStep();

  assert.equal(first.steps_taken, 0, 'the earlier snapshot moved');
  assert.equal(activity.snapshot().steps_taken, 1);
});

test('a snapshot holds only primitives', () => {
  // The boundary that keeps a live controller — or an ExtensionContext, whose
  // .secrets is the credential store — out of a status payload.
  const activity = new Activity(held().clock);
  activity.startRun();
  activity.awaitApproval('command');

  for (const [key, value] of Object.entries(activity.snapshot())) {
    assert.ok(
      value === undefined || ['string', 'number', 'boolean'].includes(typeof value),
      `${key} is a ${typeof value}, so something structured got through`
    );
  }
});

// ── whileAwaiting ────────────────────────────────────────────────────────────

test('a gate shows as waiting only for as long as it is open', async () => {
  const activity = new Activity(held().clock);
  activity.startRun();
  let seen: string | undefined;

  await whileAwaiting(activity, 'command', () => {
    seen = activity.snapshot().state;
  });

  assert.equal(seen, 'waiting_for_approval');
  assert.equal(activity.snapshot().state, 'agent_running');
});

test('a gate that throws still clears the wait', () => {
  // The whole reason this wrapper exists. A modal that rejects — a disposed window,
  // a cancelled host — would otherwise leave the run reading `waiting_for_approval`
  // forever, which is a run that looks stuck on a question nobody was asked.
  const activity = new Activity(held().clock);
  activity.startRun();

  return assert.rejects(
    () => whileAwaiting(activity, 'command', () => Promise.reject(new Error('window went away'))),
    /window went away/
  ).then(() => {
    assert.equal(activity.snapshot().state, 'agent_running');
  });
});

test('a gate with nowhere to report still runs and still returns', async () => {
  // A runner that answers to nobody is a real case, so `undefined` is a supported
  // argument rather than an accident to guard against at each call site.
  assert.equal(await whileAwaiting(undefined, 'command', () => 'approved'), 'approved');
});

test('a synchronous answer is passed straight through', async () => {
  // `approveStep` returns immediately in Auto and Unattended.
  const activity = new Activity(held().clock);
  activity.startRun();

  assert.equal(await whileAwaiting(activity, 'step', () => true), true);
  assert.equal(activity.snapshot().state, 'agent_running');
});

test('a chat turn names one trace from start to finish', () => {
  // Observed live: `clarvis.chat.started` arrived at NERVIS with no trace and
  // `clarvis.chat.completed` with one, because the tool-capable path let the
  // AgentRunner mint its own after the activity had already published. A span
  // with only one end is not a span.
  const activity = new Activity(() => 0);
  const seen: { to: string; traceId: string }[] = [];
  activity.observe((change) => seen.push({ to: change.to, traceId: change.traceId }));

  activity.startChat('trace-one');
  activity.finish();

  assert.deepEqual(
    seen.map((change) => change.traceId),
    ['trace-one', 'trace-one']
  );
});

test('a chat turn names one session from start to finish', () => {
  const activity = new Activity(() => 0);
  const seen: string[] = [];
  activity.observe((change) => seen.push(change.sessionId));

  activity.startChat('trace-one', 'session-chat');
  activity.finish();

  assert.deepEqual(seen, ['session-chat', 'session-chat']);
});

test('a run whose session is named later still reaches the completion with it', () => {
  // The palette starts a run before the runner knows its role, so the session
  // arrives with `noteTrace`; and a later `noteTrace` without one must not wipe
  // a session a caller already gave.
  const activity = new Activity(() => 0);
  const seen: string[] = [];
  activity.observe((change) => seen.push(change.sessionId));

  activity.startRun();
  activity.noteTrace('trace-two', 'session-agent');
  activity.finish();
  activity.startChat('trace-three', 'session-chat');
  activity.noteTrace('trace-three');
  activity.finish();

  assert.deepEqual(seen, ['', 'session-agent', 'session-chat', 'session-chat']);
});

test('a run named after it started still reaches the completion', () => {
  // `noteTrace` exists because the palette route starts a run before the runner
  // has an id. The start event legitimately carries none there — what must not
  // happen is the completion carrying none either.
  const activity = new Activity(() => 0);
  const seen: string[] = [];
  activity.observe((change) => seen.push(change.traceId));

  activity.startRun();
  activity.noteTrace('trace-two');
  activity.finish();

  assert.deepEqual(seen, ['', 'trace-two']);
});

// ── Notes: what happens without changing the state (§6.4) ─────────────────

const MODEL = {
  kind: 'model', phase: 'requested', role: 'chat', provider: 'custom', model: 'm',
  requestId: 'r', traceId: 'own-trace', sessionId: 'own-session',
} as const;

test('a tool call is filed under the operation in flight, a model request under its own ids', () => {
  const activity = new Activity(() => 0);
  const heard: NoteChange[] = [];
  activity.observeNotes((change) => heard.push(change));
  activity.startRun('run-trace', 'run-session');

  activity.note({ kind: 'tool', phase: 'started', tool: 'readFile' });
  activity.note(MODEL);
  activity.note({ ...MODEL, traceId: '', sessionId: '' });
  activity.note({ kind: 'problems', errors: 1, warnings: 0, information: 0, hints: 0, files: 1 });

  assert.deepEqual(heard.map((c) => [c.note.kind, c.traceId, c.sessionId]), [
    ['tool', 'run-trace', 'run-session'],
    ['model', 'own-trace', 'own-session'],
    // A title asked for during a run is not the run's request.
    ['model', '', ''],
    ['problems', '', ''],
  ]);
});

test('a note changes nothing a status reader sees, and publishes no state change', () => {
  const activity = new Activity(() => 0);
  const changes: string[] = [];
  activity.observe((change) => changes.push(change.to));
  activity.startChat();
  const before = activity.snapshot();

  activity.note({ kind: 'tool', phase: 'completed', tool: 'search' });

  assert.deepEqual(activity.snapshot(), before);
  assert.deepEqual(changes, ['chatting']);
});

test('a note observer that throws is dropped, and the caller never hears of it', () => {
  const activity = new Activity(() => 0);
  let calls = 0;
  activity.observeNotes(() => {
    calls += 1;
    throw new Error('broken consumer');
  });
  const heard: NoteChange[] = [];
  activity.observeNotes((change) => heard.push(change));

  assert.doesNotThrow(() => activity.note(MODEL));
  activity.note(MODEL);

  assert.equal(calls, 1);
  assert.equal(heard.length, 2);
});

test('every gate opened is counted, so a tool call can tell whether it asked one', async () => {
  const activity = new Activity(() => 0);
  assert.equal(activity.gatesOpened, 0);
  activity.startRun();
  await whileAwaiting(activity, 'command', () => undefined);
  await whileAwaiting(activity, 'sensitive_read', () => undefined);
  assert.equal(activity.gatesOpened, 2);
});

test('a tool call that asked the user never ends as failed, so its ending cannot say what they answered', () => {
  // A refused sensitive read comes back as an error. Published as `failed` straight
  // after `clarvis.gate.resolved`, it would say the user said no.
  assert.equal(toolEnding(true, true), 'completed');
  assert.equal(toolEnding(false, true), 'completed');
  assert.equal(toolEnding(true, false), 'failed');
  assert.equal(toolEnding(false, false), 'completed');
  assert.equal(toolEnding(undefined, false), 'completed');
});

test('a NERVIS task spans many operations and names none of them', () => {
  const activity = new Activity(() => 0);
  const heard: NoteChange[] = [];
  activity.observeNotes((change) => heard.push(change));
  activity.startRun('run-trace', 'run-session');
  activity.note({ kind: 'task', phase: 'started', taskId: 'nt_0123456789abcdef', stage: 'building' });
  assert.deepEqual([heard[0].traceId, heard[0].sessionId], ['', '']);
});

// ── What the status reports beside the state (§6.3) ─────────────────────────

test('nothing is reported until it is known', () => {
  assert.deepEqual(new Activity(() => 0).statusFacts(), {});
});

test('the status keeps the latest problem counts, request and task, heard or not', () => {
  const activity = new Activity(() => 0);
  // No note observer: the Bridge may attach later, and the status still knows.
  activity.note({ kind: 'problems', errors: 1, warnings: 4, information: 2, hints: 0, files: 3 });
  activity.note({ ...MODEL, requestId: 'r1', phase: 'requested' });
  let facts = activity.statusFacts();
  assert.deepEqual(
    [facts.diagnostics_errors, facts.diagnostics_warnings, facts.diagnostics_information, facts.diagnostics_hints, facts.diagnostics_files],
    [1, 4, 2, 0, 3]
  );
  assert.deepEqual([facts.last_request_id, facts.last_request_model, facts.last_request_provider], ['r1', 'm', 'custom']);
  assert.equal(facts.last_request_result, undefined, 'still in flight');

  activity.note({ ...MODEL, requestId: 'r1', phase: 'completed', result: 'answered' });
  activity.note({ kind: 'task', phase: 'started', taskId: 'nt_0123456789abcdef', stage: 'planning' });
  facts = activity.statusFacts();
  assert.equal(facts.last_request_result, 'answered');
  assert.deepEqual([facts.task_id, facts.task_stage], ['nt_0123456789abcdef', 'planning']);

  activity.note({ ...MODEL, requestId: 'r2', phase: 'requested' });
  assert.deepEqual(
    [activity.statusFacts().last_request_id, activity.statusFacts().last_request_result],
    ['r2', undefined],
    'a new request in flight has no result yet, whatever the last one ended as'
  );
  activity.note({ kind: 'task', phase: 'completed', taskId: 'nt_0123456789abcdef', outcome: 'built' });
  facts = activity.statusFacts();
  assert.equal('task_id' in facts && facts.task_id !== undefined, false, 'a finished task is no longer current');
  assert.equal(facts.task_stage, undefined);
});

test('a tool call changes nothing the status reports', () => {
  const activity = new Activity(() => 0);
  activity.note({ kind: 'tool', phase: 'completed', tool: 'readFile' });
  assert.deepEqual(activity.statusFacts(), {});
});

test('the last build and the last test are kept apart, each with when it ended', () => {
  const activity = new Activity(() => 0);
  activity.recordCheck('build', 'passed', '2026-09-16T10:00:00Z');
  activity.recordCheck('test', 'failed', '2026-09-16T10:05:00Z');
  activity.recordCheck('build', 'unknown', '2026-09-16T10:09:00Z');
  const facts = activity.statusFacts();
  assert.deepEqual(
    [facts.build_result, facts.build_finished_at, facts.test_result, facts.test_finished_at],
    ['unknown', '2026-09-16T10:09:00Z', 'failed', '2026-09-16T10:05:00Z']
  );
  assert.notEqual(activity.statusFacts(), activity.statusFacts(), 'a fresh object each time');
});

test("only VS Code's own Build and Test groups count, and no exit code is not a pass", () => {
  assert.equal(checkKind('build'), 'build');
  assert.equal(checkKind('test'), 'test');
  for (const other of [undefined, 'clean', 'rebuild', 'none', 'Build']) assert.equal(checkKind(other), undefined, String(other));
  assert.equal(checkResult(0), 'passed');
  assert.equal(checkResult(1), 'failed');
  assert.equal(checkResult(137), 'failed');
  assert.equal(checkResult(undefined), 'unknown');
});
