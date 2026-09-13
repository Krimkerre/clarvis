import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../test/fakes/relayContract';
import { CodexLedger } from './ledger';

/**
 * What Codex did, in the shapes the chat, the progress bar and the run record already read — and each
 * thing recorded once, however often RAVIS hands it over.
 */

const items = fixture('event-stream.json').normalised_items as Record<string, Record<string, unknown>>;

test("the contract's three items become a message, a command and a changed file", () => {
  const ledger = new CodexLedger();

  assert.deepEqual(ledger.record(items.agentMessage), [{ kind: 'text', text: 'STEP: 2. Add the --utc flag\n' }]);
  assert.deepEqual(ledger.record(items.commandExecution), [
    { kind: 'tool', text: 'Codex ran python3 -m pytest -q', detail: 'runCommand: python3 -m pytest -q → exit 0' },
  ]);
  assert.deepEqual(ledger.record(items.fileChange), [
    { kind: 'tool', text: 'Codex added hello.py', detail: 'writeFile: hello.py', toChat: true },
  ]);

  assert.deepEqual(ledger.files, ['hello.py']);
  assert.equal(ledger.lastMessage, 'STEP: 2. Add the --utc flag');
  assert.deepEqual(ledger.checks, [{ command: 'python3 -m pytest -q', exitCode: 0, outputTail: '3 passed in 0.41s' }]);
});

test('the same item handed over again adds nothing: no second chat line, no second record', () => {
  const ledger = new CodexLedger();
  for (const item of [items.agentMessage, items.commandExecution, items.fileChange]) ledger.record(item);

  // A reconnect that overlaps, a replay after an expired cursor, RAVIS re-sending after a restart.
  for (const item of [items.agentMessage, items.commandExecution, items.fileChange]) {
    assert.deepEqual(ledger.record(structuredClone(item)), [], String(item.type));
  }
  assert.deepEqual(ledger.files, ['hello.py']);
  assert.equal(ledger.checks.length, 1);
});

test('each kind of change is recorded as the run ledger reads it, and a rename covers both paths', () => {
  const ledger = new CodexLedger();
  const events = ledger.record({
    type: 'fileChange',
    id: 'call_fc_2',
    status: 'completed',
    changes: [
      { path: 'src/app.py', change: 'update', added: 12, removed: 3 },
      { path: 'old.py', change: 'delete', added: 0, removed: 9 },
      { path: 'a.py', change: 'rename', moved_to: 'b.py', added: 0, removed: 0 },
    ],
  });

  assert.deepEqual(
    events.map((event) => event.detail),
    ['applyEdit: src/app.py', 'deleteFile: old.py', 'applyEdit: b.py']
  );
  assert.deepEqual(ledger.files, ['src/app.py', 'old.py', 'a.py', 'b.py']);
});

test('a second change to a path in another item is recorded; the same path in the same item is not', () => {
  const ledger = new CodexLedger();
  const update = (id: string) => ({ type: 'fileChange', id, status: 'completed', changes: [{ path: 'app.py', change: 'update' }] });

  assert.equal(ledger.record(update('call_1')).length, 1);
  assert.equal(ledger.record(update('call_1')).length, 0);
  assert.equal(ledger.record(update('call_2')).length, 1, 'a later edit of the same file is its own step');
  assert.deepEqual(ledger.files, ['app.py']);
});

test('only changes that happened are recorded, and anything unrecognised is passed over', () => {
  const ledger = new CodexLedger();

  assert.deepEqual(ledger.record({ ...items.fileChange, id: 'call_declined', status: 'declined' }), []);
  assert.deepEqual(ledger.record({ type: 'reasoning', id: 'r1', text: 'thinking' }), []);
  assert.deepEqual(ledger.record({ type: 'agentMessage', text: 'no id' }), []);
  assert.deepEqual(ledger.record(null), []);
  assert.deepEqual(ledger.record({ type: 'agentMessage', id: 'empty', text: '   ' }), []);
  assert.deepEqual(ledger.files, []);
});

test('a command whose exit code is unknown says so rather than inventing one', () => {
  const ledger = new CodexLedger();
  const [event] = ledger.record({ type: 'commandExecution', id: 'c9', command: 'npm test', exit_code: null });
  assert.equal(event.detail, 'runCommand: npm test → exit unknown');
});

test('a command or file change that started and never finished is under way — for a switch to list as uncertain — until it completes', () => {
  const ledger = new CodexLedger();

  ledger.started({ ...items.commandExecution, exit_code: null });
  ledger.started({ type: 'fileChange', id: 'call_fc_9', status: 'inProgress', changes: [{ path: 'app.py', change: 'update' }] });
  ledger.started(items.agentMessage);
  assert.deepEqual(ledger.unfinished, [
    { kind: 'command', summary: 'python3 -m pytest -q' },
    { kind: 'fileChange', summary: 'app.py' },
  ]);

  ledger.record(items.commandExecution);
  ledger.started(items.commandExecution); // a replay of its start, after it finished
  assert.deepEqual(ledger.unfinished, [{ kind: 'fileChange', summary: 'app.py' }]);
});
