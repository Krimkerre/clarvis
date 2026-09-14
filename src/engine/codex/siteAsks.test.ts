import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleNamed, fixture } from '../../test/fakes/relayContract';
import type { RequestView } from '../relay/relayTypes';
import {
  carryOnText,
  joinHosts,
  MOST_SITES,
  preTaskAsk,
  preTaskChoice,
  refusedSites,
  SITE_LINES,
  SiteGroupCard,
  siteAskFrom,
  siteDecisionsLine,
  sitesAllowedLine,
  sitesNotAddedLine,
  sitesNotAllowedLine,
  sitesRefusedLine,
  type SiteDecision,
} from './siteAsks';
import { BRIEF } from './siteScan';

/**
 * Asking about sites a Codex task needs, in the words the owner chose on 14 September 2026: the card for a group of
 * blocked hosts, the lines while Codex reconnects, the text that carries the task on, and the ask before a task starts.
 */

const BOTH: SiteDecision[] = ['allow_site', 'keep_blocked'];
const ask = (requestId: string, host: string, protocol: string | null = 'https', offers: SiteDecision[] = BOTH) => ({ requestId, host, protocol, offers });

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

test('the deciding window says the same to the owner, and that Codex carries on', () => {
  assert.equal(siteDecisionsLine(['a.com'], ['b.org']), 'Allowed a.com; b.org stays blocked. Codex carries on where it stopped.');
  assert.equal(siteDecisionsLine(['a.com', 'b.org'], []), 'Allowed a.com and b.org. Codex carries on where it stopped.');
  assert.equal(siteDecisionsLine([], ['a.com', 'b.org']), 'a.com and b.org stay blocked. Codex carries on where it stopped.');
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

test('a host that opens later joins the card once, and only the decisions RAVIS offers are buttons', () => {
  const card = new SiteGroupCard([ask('rq_1', 'a.com')]);
  assert.equal(card.add(ask('rq_2', 'b.org')), true);
  assert.equal(card.add(ask('rq_2', 'b.org')), false, 'a replay adds nothing');
  assert.equal(card.view().line, 'Codex was blocked from reaching a.com and b.org.');

  const narrowed = new SiteGroupCard([ask('rq_1', 'a.com', 'https', ['keep_blocked']), ask('rq_2', 'b.org'), ask('rq_3', 'c.net')]);
  assert.deepEqual(
    narrowed.view().options.map((option) => option.label),
    ['Keep a.com blocked', 'Allow b.org', 'Keep b.org blocked', 'Allow c.net', 'Keep c.net blocked', 'Allow all']
  );
  assert.deepEqual(
    narrowed.read('Allow all'),
    [
      { requestId: 'rq_2', decision: 'allow_site' },
      { requestId: 'rq_3', decision: 'allow_site' },
    ],
    'Allow all allows only what RAVIS offers to allow'
  );
  const oneAllowable = new SiteGroupCard([ask('rq_1', 'a.com', 'https', ['keep_blocked']), ask('rq_2', 'b.org')]);
  assert.deepEqual(oneAllowable.view().options.map((option) => option.label), ['Keep a.com blocked', 'Allow b.org', 'Keep b.org blocked']);
});

test("the contract's site request becomes an ask with RAVIS's decisions, and the lines are the owner's words", () => {
  const site = (fixture('agent-sessions.json').request_view_examples as RequestView[]).find((request) => request.kind === 'site') as RequestView;

  assert.deepEqual(siteAskFrom(site), { requestId: site.id, host: 'pypi.org', protocol: 'https', offers: BOTH });
  assert.deepEqual(siteAskFrom({ ...site, allowed_decisions: ['keep_blocked', 'once'] })?.offers, ['keep_blocked']);
  assert.deepEqual(siteAskFrom({ ...site, payload: { host: 'pypi.org', protocol: null } })?.protocol, null);
  assert.equal(siteAskFrom({ ...site, payload: {} }), undefined);
  assert.equal(new SiteGroupCard([ask('rq_1', 'pypi.org', null)]).view().line, 'Codex was blocked from reaching pypi.org.');
  assert.equal(SITE_LINES.reconnecting, 'Reconnecting Codex so newly allowed sites work (up to a minute)…');
  assert.equal(SITE_LINES.reopenIncomplete, "Codex didn't reconnect within two minutes, so a site allowed just now may still be blocked in this task.");
});

test('the ask before a task names its hosts and where each was found, and offers the three ways on', () => {
  const two = preTaskAsk([
    { host: 'a.com', foundIn: ['.npmrc'] },
    { host: 'b.org', foundIn: ['requirements.txt', BRIEF] },
  ]);
  assert.equal(two.line, 'This task may need a.com and b.org. Allow them before Codex starts?');
  assert.deepEqual(two.detail, ['a.com: found in .npmrc', 'b.org: found in requirements.txt and the task']);
  assert.deepEqual(two.options.map((option) => option.label), ['Allow and start', 'Start without them', 'Cancel']);

  const one = preTaskAsk([{ host: 'a.com', foundIn: [BRIEF] }]);
  assert.equal(one.line, 'This task may need a.com. Allow it before Codex starts?');
  assert.deepEqual(one.options.map((option) => option.label), ['Allow and start', 'Start without it', 'Cancel']);

  assert.equal(preTaskChoice(two, 'Allow and start'), 'allow_and_start');
  assert.equal(preTaskChoice(two, 'start without them'), 'start_without');
  assert.equal(preTaskChoice(one, 'Start without it'), 'start_without');
  assert.equal(preTaskChoice(two, '3'), 'cancel', 'by number');
  assert.equal(preTaskChoice(two, undefined), undefined, 'a Stop chooses nothing');
  assert.equal(preTaskChoice(two, 'sure'), undefined);
  assert.equal(preTaskChoice(one, 'Start without them'), undefined, 'only the buttons this ask has');
});

test('once allowing failed, the ask says why first and offers only Start without and Cancel', () => {
  const again = preTaskAsk([{ host: 'a.com', foundIn: ['.npmrc'] }], false, sitesNotAddedLine(['a.com']));
  assert.equal(again.line, "Codex didn't add a.com, so it stays blocked. Start Codex without a.com?");
  assert.deepEqual(again.options.map((option) => option.label), ['Start without it', 'Cancel']);
  assert.equal(preTaskChoice(again, 'Allow and start'), undefined);
  assert.equal(preTaskChoice(again, '1'), 'start_without');
});

test("what allowing sites before a start says, in the terms of RAVIS's refusal", () => {
  assert.equal(MOST_SITES, 20);
  assert.equal(sitesAllowedLine(['a.com', 'b.org']), "Allowed a.com and b.org for Codex's commands, in this task and every later one.");
  const { body } = exampleNamed('POST /api/v1/codex/sites', 'a host RAVIS never allows: nothing is written').response as {
    body: { error: { details: Record<string, unknown> } };
  };
  const refused = refusedSites(body.error.details);
  assert.deepEqual(refused, [
    { host: '*.hf.co', reason: 'wildcard' },
    { host: '192.168.1.20', reason: 'ip_address' },
    { host: 'https://example.com/data', reason: 'not_a_host_name' },
  ]);
  assert.equal(
    sitesRefusedLine(refused),
    "RAVIS allows only exact public host names, so nothing was added: *.hf.co (a wildcard), 192.168.1.20 (an IP address) and https://example.com/data (not a plain host name) can't be allowed."
  );
  assert.equal(sitesRefusedLine([{ host: 'printer.local', reason: 'local_name' }]).includes('printer.local (a name on this Mac or its network)'), true);
  assert.deepEqual(refusedSites({}), []);
  assert.equal(sitesNotAddedLine(['a.com', 'b.org']), "Codex didn't add a.com and b.org, so they stay blocked.");
  assert.equal(sitesNotAllowedLine(['a.com']), "a.com couldn't be allowed right now, so it stays blocked.");
});
