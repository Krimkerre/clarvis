import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeBlocker,
  ANOTHER_WAY,
  blockerLine,
  blockerRecord,
  BLOCKER_TTL_MS,
  clearsBlocker,
  explainMissing,
  INSTALL_HERE,
  INSTALL_MYSELF,
  missingDependency,
  missingOptions,
  missingOutcome,
  STOP_HERE,
} from './missingDependency';

/** The traceback from the 11 September run, where the whole thing started. */
const TKINTER = [
  'Traceback (most recent call last):',
  '  File "src/main.py", line 1, in <module>',
  '    import tkinter as tk',
  '  File "/Users/mathias/.pyenv/versions/3.11.15/lib/python3.11/tkinter/__init__.py", line 38, in <module>',
  '    import _tkinter # If this fails your Python may not be configured for Tk',
  "ModuleNotFoundError: No module named '_tkinter'",
].join('\n');

test('the missing tkinter that started this is recognised as part of Python, not a package', () => {
  // Found live, 11 September 2026: this line was read past, and the run tried to reinstall
  // the machine's Python instead of asking.
  const missing = missingDependency(TKINTER, 1);

  assert.ok(missing);
  assert.equal(missing.name, 'tkinter');
  assert.equal(missing.kind, 'system-part');
  assert.equal(missing.projectInstallable, false);
  assert.equal(missing.evidence, "ModuleNotFoundError: No module named '_tkinter'");
  assert.deepEqual(missingOptions(missing), [INSTALL_MYSELF, ANOTHER_WAY, STOP_HERE]);
});

test('an ordinary Python package can go into the project', () => {
  const plain = missingDependency("ModuleNotFoundError: No module named 'requests'", 1);
  const dotted = missingDependency("ModuleNotFoundError: No module named 'yaml.loader'", 1);

  assert.equal(plain?.name, 'requests');
  assert.equal(plain?.kind, 'package');
  assert.equal(dotted?.name, 'yaml');
  assert.deepEqual(missingOptions(plain!), [INSTALL_HERE, INSTALL_MYSELF, ANOTHER_WAY, STOP_HERE]);
});

test('a Node package is missing; a relative import is the code, not the machine', () => {
  assert.equal(missingDependency("Error: Cannot find module 'express'", 1)?.name, 'express');
  assert.equal(missingDependency("Error: Cannot find module './util'", 1), undefined);
});

test('every shell says "no such program" its own way, and each is heard', () => {
  const cases: [string, string][] = [
    ['zsh: command not found: cargo', 'cargo'],
    ['bash: go: command not found', 'go'],
    ['/bin/sh: line 1: rustc: command not found', 'rustc'],
    ['sh: 1: node: not found', 'node'],
    ["env: 'python': No such file or directory", 'python'],
  ];
  for (const [output, name] of cases) {
    const missing = missingDependency(output, 127);
    assert.equal(missing?.name, name, output);
    assert.equal(missing?.kind, 'program', output);
  }
});

test('system libraries, headers and Apple developer tools are parts of the machine', () => {
  assert.equal(missingDependency('fatal error: openssl/ssl.h: No such file or directory', 1)?.kind, 'system-part');
  assert.equal(missingDependency("fatal error: 'zlib.h' file not found", 1)?.name, 'zlib.h');
  assert.equal(
    missingDependency('ImportError: dlopen(x.so, 2): Library not loaded: /opt/homebrew/opt/libpq/lib/libpq.5.dylib', 1)?.name,
    'libpq.5.dylib'
  );
  assert.equal(
    missingDependency('xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)', 1)?.name,
    'Xcode Command Line Tools'
  );
});

test('nothing is missing when the command succeeded, was killed, or failed for another reason', () => {
  // A test suite that exercises an import error prints the same words and passes.
  assert.equal(missingDependency(TKINTER, 0), undefined);
  assert.equal(missingDependency(TKINTER, undefined), undefined);
  assert.equal(missingDependency('AssertionError: expected 3, got 2', 1), undefined);
});

test('installing it yourself or stopping ends the run, and nothing is ticked', () => {
  // A run that carried on without the dependency is the run that ticked steps whose
  // checks never ran.
  const missing = missingDependency(TKINTER, 1)!;

  const myself = missingOutcome(missing, INSTALL_MYSELF);
  assert.equal(myself.decision, 'install-myself');
  assert.match(myself.halt ?? '', /Nothing was ticked off/);
  assert.ok(myself.halt?.endsWith('?'), 'the halt should end on a question so "yes" carries on');

  for (const answer of [STOP_HERE, undefined]) {
    const stopped = missingOutcome(missing, answer);
    assert.equal(stopped.decision, 'stop', String(answer));
    assert.ok(stopped.halt, String(answer));
  }
});

test('finding another way goes on, forbidden to install, change the machine, or tick', () => {
  const outcome = missingOutcome(missingDependency(TKINTER, 1)!, ANOTHER_WAY);

  assert.equal(outcome.halt, undefined);
  assert.match(outcome.toldTheModel, /Do not install/);
  assert.match(outcome.toldTheModel, /do not change how this computer is set up/);
  assert.match(outcome.toldTheModel, /do not edit the plan or tick any step/);
});

test('installing into the project is only an answer where that is possible', () => {
  const tkinter = missingDependency(TKINTER, 1)!;
  const requests = missingDependency("No module named 'requests'", 1)!;

  assert.equal(missingOutcome(requests, INSTALL_HERE).decision, 'install-here');
  assert.equal(missingOutcome(requests, INSTALL_HERE).halt, undefined);
  assert.equal(missingOutcome(tkinter, INSTALL_HERE).decision, 'stop');
});

test('the question names what is missing, where it was found, and what it said', () => {
  const text = explainMissing('python3 src/main.py', missingDependency(TKINTER, 1)!);

  assert.match(text, /Missing:  tkinter/);
  assert.match(text, /Found while running:  python3 src\/main\.py/);
  assert.match(text, /No module named '_tkinter'/);
});

test('the remembered record is read back while recent, and settled when the command works', () => {
  const now = 1_000_000;
  const record = blockerRecord('python3 src/main.py', missingDependency(TKINTER, 1)!, 'install-myself', now);

  assert.deepEqual(activeBlocker(record, now + 1000), record);
  assert.equal(activeBlocker(record, now + BLOCKER_TTL_MS + 1), undefined);
  assert.equal(activeBlocker({ name: 'tkinter' }, now), undefined);
  assert.equal(activeBlocker('nonsense', now), undefined);

  assert.equal(clearsBlocker(record, 'python3 src/main.py', 0), true);
  assert.equal(clearsBlocker(record, 'python3 src/main.py', 1), false);
  assert.equal(clearsBlocker(record, 'npm test', 0), false);
  assert.equal(clearsBlocker(undefined, 'python3 src/main.py', 0), false);

  // "tkinter ships with Python and needs no installing" was said after this was found.
  const line = blockerLine(record, '5m ago');
  assert.match(line, /Missing on this computer: tkinter/);
  assert.match(line, /they will install it themselves/);
});
