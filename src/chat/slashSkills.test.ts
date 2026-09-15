import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SkillsLookup } from '../agent/tools/skillTools';
import { RelayClient } from '../engine/relay/relayClient';
import { fakeHttp, FakeRavisRelay } from '../test/fakes/FakeRavisRelay';
import { SKILLS_LIST_ROUTE } from '../test/fakes/relayContract';
import { REFRESH_WHILE_TYPING_MS, SlashSkills, type SlashListMessage } from './slashSkills';

/**
 * The skills behind the chat box's suggestions pop-up (the owner's decisions, 15 Sep 2026), against `FakeRavisRelay`,
 * whose list is RAVIS's `skills.json`: the built-in commands at once and the skills once read; a read when the panel
 * opens, when the window regains focus and when the settings change, and while typing `/` at most once a minute; a read
 * under way waited for; and the list a command is checked against as it is sent, read fresh every time.
 */

interface Slash {
  fake: FakeRavisRelay;
  slash: SlashSkills;
  posts: SlashListMessage[];
  logs: string[];
  advance(ms: number): void;
  reads(): number;
}

async function withSlash(run: (context: Slash) => Promise<void>, lookupFor?: (fake: FakeRavisRelay) => SkillsLookup): Promise<void> {
  const fake = await FakeRavisRelay.start();
  try {
    fake.skills();
    const lookup: SkillsLookup = lookupFor?.(fake) ?? { kind: 'ready', source: new RelayClient(fakeHttp(fake)) };
    const posts: SlashListMessage[] = [];
    const logs: string[] = [];
    let now = 1_000_000;
    const slash = new SlashSkills({ lookup: () => lookup, post: (message) => posts.push(message), log: (line) => logs.push(line), now: () => now });
    await run({
      fake,
      slash,
      posts,
      logs,
      advance: (ms) => void (now += ms),
      reads: () => fake.seen.filter((seen) => seen.path === '/api/v1/skills/models').length,
    });
    assert.deepEqual(fake.violations, [], 'every request and answer matched the fixtures');
  } finally {
    await fake.close();
  }
}

const skillLabels = (message: SlashListMessage | undefined) => (message?.rows ?? []).filter((row) => row.kind === 'skill').map((row) => row.label);
const commandLabels = (message: SlashListMessage | undefined) => (message?.rows ?? []).filter((row) => row.kind === 'command').map((row) => row.label);

test('opening the panel posts the built-in commands at once, then the skills once RAVIS has listed them', () =>
  withSlash(async ({ slash, posts, reads }) => {
    await slash.refresh('opened');

    assert.equal(posts.length, 2);
    assert.deepEqual(skillLabels(posts[0]), [], 'nothing read yet');
    assert.ok(commandLabels(posts[0]).includes('/help') && commandLabels(posts[0]).includes('/skill'));
    assert.deepEqual(skillLabels(posts[1]), ['/nervis-notes', '/graphify']);
    assert.equal(reads(), 1);
  }));

test('typing / reads the skills at most once a minute; opening the panel, focus and a settings change always read', () =>
  withSlash(async ({ slash, advance, reads }) => {
    assert.equal(REFRESH_WHILE_TYPING_MS, 60_000);

    await slash.refresh('typing');
    assert.equal(reads(), 1, 'the first time typing asks, it reads');
    await slash.refresh('typing');
    advance(REFRESH_WHILE_TYPING_MS - 1);
    await slash.refresh('typing');
    assert.equal(reads(), 1, 'not again within the minute');
    advance(1);
    await slash.refresh('typing');
    assert.equal(reads(), 2, 'a minute on, it reads again');

    await slash.refresh('opened');
    await slash.refresh('focused');
    await slash.refresh('settings');
    assert.equal(reads(), 5);
    await slash.refresh('typing');
    assert.equal(reads(), 5, 'the minute counts from the last read, whatever asked for it');
  }));

test('a read already under way is waited for, not repeated', () =>
  withSlash(async ({ fake, slash, posts, reads }) => {
    fake.delayResponses(SKILLS_LIST_ROUTE, 150);

    await Promise.all([slash.refresh('opened'), slash.refresh('focused'), slash.refresh('typing')]);

    assert.equal(reads(), 1);
    assert.deepEqual(skillLabels(posts[posts.length - 1]), ['/nervis-notes', '/graphify']);
  }));

test('a command as it is sent reads RAVIS every time, even straight after the pop-up did, so a skill switched off since stays off', () =>
  withSlash(async ({ fake, slash, posts, reads }) => {
    await slash.refresh('opened');
    fake.skills().on.delete('personal/graphify');

    const list = await slash.listNow();

    assert.deepEqual(list.kind === 'listed' ? list.skills.map((skill) => skill.id) : list, ['nervis/nervis-notes']);
    assert.equal(reads(), 2);
    assert.deepEqual(skillLabels(posts[posts.length - 1]), ['/nervis-notes'], 'and the pop-up drops it too');
    await slash.listNow();
    assert.equal(reads(), 3, 'never throttled');
  }));

test("a list that can't be read keeps the pop-up's last skills, says so in the log, and tells a command it failed", () =>
  withSlash(async ({ fake, slash, posts, logs }) => {
    await slash.refresh('opened');
    await fake.stopListening();

    await slash.refresh('focused');
    const list = await slash.listNow();

    assert.deepEqual(skillLabels(posts[posts.length - 1]), ['/nervis-notes', '/graphify']);
    assert.match(logs[0] ?? '', /^slash: skills not listed — RAVIS didn't answer/);
    assert.equal(list.kind, 'failed');
    await fake.listenAgain();
  }));

test('with a coding model that doesn’t go through RAVIS there are no skills, and RAVIS is never asked', () =>
  withSlash(
    async ({ slash, posts, reads }) => {
      await slash.refresh('opened');
      assert.deepEqual(await slash.listNow(), { kind: 'not_used' });
      assert.deepEqual(skillLabels(posts[posts.length - 1]), []);
      assert.equal(reads(), 0);
    },
    () => ({ kind: 'not_used' })
  ));
