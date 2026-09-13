import test from 'node:test';
import assert from 'node:assert/strict';
import { confinementNote } from './confinement';

const BREW = `Error: Could not symlink bin/go
/opt/homebrew/bin is not writable.
You should change the ownership: sudo chown -R mathias /opt/homebrew`;

test('a confined command denied a write is told the sandbox did it', () => {
  // The live failure this exists for: Homebrew described a working install as broken,
  // and Clarvis passed on `sudo chown -R /opt/homebrew` as if it were the diagnosis.
  const note = confinementNote(true, 1, BREW);

  assert.ok(note);
  assert.match(note, /confined/);
  assert.match(note, /sudo/);
});

test('an ordinary failure gets no note', () => {
  // A note on every failure teaches the model to blame the sandbox for its own bugs.
  assert.equal(confinementNote(true, 1, 'FAIL src/app.test.ts — expected 2, got 3'), undefined);
});

test('nothing is said when the command was not confined', () => {
  // Unconfined, the tool's diagnosis is the real one and should be relayed.
  assert.equal(confinementNote(false, 1, BREW), undefined);
});

test('a command that worked is left alone', () => {
  assert.equal(confinementNote(true, 0, BREW), undefined);
});

test('a killed command with a denial still gets the note', () => {
  // No exit code means killed or timed out, which is not success.
  assert.ok(confinementNote(true, undefined, 'mkdir: /usr/local/lib: Operation not permitted'));
});

test('a DNS failure with network denied gets the network note, not the write one', () => {
  const note = confinementNote(true, 6, 'curl: (6) Could not resolve host: api.example.com', false);

  assert.match(note ?? '', /no network by default|get none by default/);
  assert.doesNotMatch(note ?? '', /sudo.*chown/);
});

test('a connection refusal with network denied gets the note', () => {
  const note = confinementNote(true, 7, 'curl: (7) Failed to connect to api.example.com port 443: Connection refused', false);

  assert.ok(note);
});

test('the same failure with network allowed gets no note — it is a real outage', () => {
  assert.equal(
    confinementNote(true, 6, 'curl: (6) Could not resolve host: api.example.com', true),
    undefined
  );
});

test('a server refused its port gets the port note, not the write note', () => {
  // Found live, 13 September 2026, verbatim tail: "Operation not permitted" is also what a
  // denied write says, and the write note would have blamed access to the workspace.
  const python = [
    '  File "/Users/me/.pyenv/versions/3.11.15/lib/python3.11/socketserver.py", line 472, in server_bind',
    '    self.socket.bind(self.server_address)',
    'PermissionError: [Errno 1] Operation not permitted',
  ].join('\n');

  for (const output of [
    python,
    'Error: listen EPERM: operation not permitted 127.0.0.1:3000',
    'listen tcp 127.0.0.1:8080: bind: operation not permitted',
  ]) {
    const note = confinementNote(true, 1, output, false) ?? '';
    assert.match(note, /nothing it starts can listen on a port/, output);
    assert.match(note, /in-process/, output);
    assert.doesNotMatch(note, /writes are limited/, output);
  }
});

test('with network allowed, a bind failure is not blamed on the missing network', () => {
  // Those commands can listen, so a refusal there is something else.
  const note = confinementNote(true, 1, 'listen tcp 127.0.0.1:8080: bind: operation not permitted', true) ?? '';

  assert.doesNotMatch(note, /listen on a port/);
});

test('network note tells the model not to blame the network and not to route around it', () => {
  const note = confinementNote(true, 7, 'connection refused', false) ?? '';

  assert.match(note, /not.*real outage/);
  assert.match(note, /say so and stop/);
});
