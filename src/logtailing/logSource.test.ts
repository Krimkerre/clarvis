import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'path';
import { hostLogFor, startOffset, tailArguments } from './logSource';

/** M13's source and resume point, as laid out on disk on 19 September 2026. */

const DESKTOP = '/logs/20260919T085033/window1/exthost/Krimkerre.clarvis';
const SERVER = '/cs/logs/20260919T002305/exthost1/Krimkerre.clarvis';

test("the source is this window's extension-host log, on either host", () => {
  const on = (...files: string[]) => (file: string) => files.includes(file);

  assert.equal(hostLogFor(DESKTOP, on('/logs/20260919T085033/window1/exthost/exthost.log')),
    '/logs/20260919T085033/window1/exthost/exthost.log');
  assert.equal(hostLogFor(SERVER, on('/cs/logs/20260919T002305/exthost1/remoteexthost.log')),
    '/cs/logs/20260919T002305/exthost1/remoteexthost.log');
  assert.equal(hostLogFor(DESKTOP, on('/logs/20260919T085033/main.log')), undefined,
    "the main process's log is not the extension host's");
  assert.equal(path.dirname(hostLogFor(SERVER, () => true) ?? ''), path.dirname(SERVER),
    "never another window's folder");
});

test('a restart resumes where the copy stopped, and a new log starts at its beginning', () => {
  const source = '/logs/a/window1/exthost/exthost.log';
  assert.equal(startOffset({ source, offset: 500 }, source, 900), 500);
  assert.equal(startOffset({ source: '/logs/b/window1/exthost/exthost.log', offset: 500 }, source, 900), 0);
  assert.equal(startOffset({ source, offset: 500 }, source, 100), 0, 'a log that shrank was replaced');
  assert.equal(startOffset(undefined, source, 900), 0);
});

test("tail is asked for the bytes after the offset, counted from 1", () => {
  assert.deepEqual(tailArguments('/x/exthost.log', 0), ['-c', '+1', '-f', '/x/exthost.log']);
  assert.deepEqual(tailArguments('/x/exthost.log', 500), ['-c', '+501', '-f', '/x/exthost.log']);
});
