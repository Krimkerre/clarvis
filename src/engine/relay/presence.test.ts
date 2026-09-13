import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../test/fakes/relayContract';
import { PANEL_PING_MS, PINGS_LOST_AFTER_MS, PRESENCE_EVERY_MS, PresenceTracker, type PresenceAction } from './presence';

/**
 * Why this matters (design §3.5.4, review AH2): code-server keeps a closed tab's extension host alive
 * for three hours. If a live extension host counted as "attached", nobody would ever be told a task
 * was waiting with no editor open.
 */

/** Drives a tracker second by second, pinging at the given moments, and records what it asked for. */
function drive(pings: number[], until: number): [number, string][] {
  const tracker = new PresenceTracker();
  const seen: [number, string][] = [];
  const record = (now: number, actions: PresenceAction[]) => {
    for (const action of actions) seen.push([now, action.kind === 'post' ? `post ${action.panelConnected}` : action.kind]);
  };
  for (let now = 0; now <= until; now += 1_000) {
    if (pings.includes(now)) record(now, tracker.ping(now));
    record(now, tracker.tick(now));
  }
  return seen;
}

test("the timings are the contract's", () => {
  const attachment = fixture('event-stream.json').attachment;

  assert.equal(PANEL_PING_MS, attachment.panel_ping_seconds * 1000);
  assert.equal(PRESENCE_EVERY_MS, attachment.presence_every_seconds * 1000);
  assert.equal(PINGS_LOST_AFTER_MS, attachment.pings_lost_after_seconds * 1000);
  assert.ok(PRESENCE_EVERY_MS < attachment.attached_while_presence_younger_than_seconds * 1000);
});

test('a panel that pings is reported present at once, and again every 20 s', () => {
  const pings = [0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000];

  assert.deepEqual(drive(pings, 60_000), [
    [0, 'post true'],
    [0, 'open_stream'],
    [20_000, 'post true'],
    [40_000, 'post true'],
    [60_000, 'post true'],
  ]);
});

test('a closed tab stops counting as attached 25 s after its last ping, though its extension host lives on', () => {
  assert.deepEqual(drive([0, 10_000], 80_000), [
    [0, 'post true'],
    [0, 'open_stream'],
    [20_000, 'post true'],
    [35_000, 'post false'],
    [35_000, 'close_stream'],
  ]);
});

test('pings that come back post presence at once and reopen the stream, with no reactivation (F-A8)', () => {
  assert.deepEqual(drive([0, 10_000, 50_000], 55_000), [
    [0, 'post true'],
    [0, 'open_stream'],
    [20_000, 'post true'],
    [35_000, 'post false'],
    [35_000, 'close_stream'],
    [50_000, 'post true'],
    [50_000, 'open_stream'],
  ]);
});

test('nothing is posted before the panel has ever pinged', () => {
  assert.deepEqual(drive([], 60_000), []);
});
