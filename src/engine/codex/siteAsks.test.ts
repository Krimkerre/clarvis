import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../test/fakes/relayContract';
import type { RequestView } from '../relay/relayTypes';
import { carryOnText, joinHosts, preTaskAsk, preTaskChoice, SITE_LINES, SiteGroupCard, siteAskFrom } from './siteAsks';

/**
 * Asking about sites a Codex task needs, in the words the owner chose on 14 September 2026: the card for a group of
 * blocked hosts, the line while Codex reconnects, the text that carries the task on, and the ask before a task starts.
 */

const ask = (requestId: string, host: string, protocol: string | null = 'https') => ({ requestId, host, protocol });

test('hosts are listed the way a sentence says them', () => {
  assert.equal(joinHosts([]), '');
  assert.equal(joinHosts(['a.com']), 'a.com');
  assert.equal(joinHosts(['a.com', 'b.org']), 'a.com and b.org');
  assert.equal(joinHosts(['a.com', 'b.org', 'c.net']), 'a.com, b.org and c.net');
});

test('the carry-on text says what the owner allowed and what stays blocked, then to carry on', () => {
  assert.equal(carryOnText(['a.com'], ['b.org']), 'The owner allowed a.com; b.org stays blocked. Carry on where you stopped.');
  assert.equal(
    carryOnText(['a.com', 'c.net'], ['b.org', 'd.io']),
    'The owner allowed a.com and c.net; b.org and d.io stay blocked. Carry on where you stopped.'
  );
  assert.equal(carryOnText(['a.com', 'b.org'], []), 'The owner allowed a.com and b.org. Carry on where you stopped.');
  assert.equal(carryOnText([], ['b.org']), 'The owner kept b.org blocked. Carry on where you stopped.');
});

test('a group card offers Allow and Keep blocked for each host, plus Allow all while more than one is open', () => {
  const card = new SiteGroupCard([ask('rq_1', 'a.com'), ask('rq_2', 'b.org')]);
  const view = card.view();

  assert.equal(view.line, 'Codex was blocked from reaching a.com and b.org.');
  assert.deepEqual(view.detail, [SITE_LINES.allowedMeansEveryTask]);
  assert.deepEqual(
    view.options.map((option) => option.label),
    ['Allow a.com', 'Keep a.com blocked', 'Allow b.org', 'Keep b.org blocked', 'Allow all']
  );
  assert.deepEqual(card.read('Allow all'), [
    { requestId: 'rq_1', decision: 'allow_site' },
    { requestId: 'rq_2', decision: 'allow_site' },
  ]);
  assert.deepEqual(card.read('keep b.org blocked'), [{ requestId: 'rq_2', decision: 'keep_blocked' }], 'any case');
  assert.deepEqual(card.read('2'), [{ requestId: 'rq_1', decision: 'keep_blocked' }], 'by number');
  assert.equal(card.read('use a mirror instead'), undefined, 'anything else decides nothing');
});

test('the card is drawn again for the hosts still open, and is complete once every host is decided', () => {
  const card = new SiteGroupCard([ask('rq_1', 'a.com'), ask('rq_2', 'b.org')]);
  card.record('rq_1', 'allow_site');

  assert.equal(card.complete, false);
  const left = card.view();
  assert.equal(left.line, 'Codex was blocked from reaching b.org (https).', 'one host says how the command wanted to reach it');
  assert.deepEqual(left.options.map((option) => option.label), ['Allow b.org', 'Keep b.org blocked'], 'no Allow all for one host');

  card.record('rq_2', 'keep_blocked');
  card.record('rq_not_in_this_group', 'allow_site');
  assert.equal(card.complete, true);
  assert.deepEqual([card.allowed, card.kept], [['a.com'], ['b.org']]);
  assert.equal(carryOnText(card.allowed, card.kept), 'The owner allowed a.com; b.org stays blocked. Carry on where you stopped.');
});

test("the contract's site request becomes an ask, and the reconnecting line is the owner's words", () => {
  const site = (fixture('agent-sessions.json').request_view_examples as RequestView[]).find((request) => request.kind === 'site') as RequestView;

  assert.deepEqual(siteAskFrom(site), { requestId: site.id, host: 'pypi.org', protocol: 'https' });
  assert.deepEqual(siteAskFrom({ ...site, payload: { host: 'pypi.org', protocol: null } })?.protocol, null);
  assert.equal(siteAskFrom({ ...site, payload: {} }), undefined);
  assert.equal(new SiteGroupCard([ask('rq_1', 'pypi.org', null)]).view().line, 'Codex was blocked from reaching pypi.org.');
  assert.equal(SITE_LINES.reconnecting, 'Reconnecting Codex so newly allowed sites work (up to a minute)…');
});

test('the ask before a task names its hosts and offers the three ways on; nothing else starts or cancels', () => {
  const two = preTaskAsk(['a.com', 'b.org']);
  assert.equal(two.line, 'This task may need a.com and b.org. Allow them before Codex starts?');
  assert.deepEqual(two.options.map((option) => option.label), ['Allow and start', 'Start without them', 'Cancel']);

  const one = preTaskAsk(['a.com']);
  assert.equal(one.line, 'This task may need a.com. Allow it before Codex starts?');
  assert.deepEqual(one.options.map((option) => option.label), ['Allow and start', 'Start without it', 'Cancel']);

  assert.equal(preTaskChoice('Allow and start'), 'allow_and_start');
  assert.equal(preTaskChoice('start without them'), 'start_without');
  assert.equal(preTaskChoice('Start without it'), 'start_without');
  assert.equal(preTaskChoice('Cancel'), 'cancel');
  assert.equal(preTaskChoice(undefined), undefined, 'a Stop starts nothing');
  assert.equal(preTaskChoice('sure'), undefined);
});
