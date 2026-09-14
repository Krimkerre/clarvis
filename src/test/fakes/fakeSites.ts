/**
 * FakeRavisRelay's allowed sites (plan.md M15, C2b+; R5, `codex-admin.json` → the sites routes): the list a window
 * reads before a task starts and adds the owner's hosts to, checked the way RAVIS checks them (`agent/sites.py`,
 * RAVIS bc1a103).
 *
 * **Still a labelled test double.** It writes no Codex configuration. Where RAVIS's rules name an answer the fixtures
 * give no example of — a `POST` answering `503 CODEX_RUNTIME_UNAVAILABLE` — it answers off-contract and says why.
 *
 * Test controls: `added` (the sites allowed so far), `unreadable` (Codex's list can't be read) and `notAdded` (Codex
 * doesn't take the next write); `posts` records what each `POST` asked for. Test support only.
 */

import { isIP } from 'net';
import { fixtureAnswer, withDetails, type FakeAnswer } from './fakeAnswers';
import { ALLOW_SITES_ROUTE, SITES_ROUTE, type FixtureRoute } from './relayContract';

/** At most this many hosts in one `POST` (`sites.py`'s `MOST_HOSTS`). */
const MOST_HOSTS = 20;
/** `sites.py`'s `HOST`: dotted labels ending in a name, lower-case. */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
/** `sites.py`'s `LOCAL_SUFFIXES`. */
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.lan'];

export class FakeSites {
  /** RAVIS's own list, as the fixtures show it. */
  readonly defaults: string[];
  /** The sites added so far, as Codex's list would hold them. */
  readonly added = new Set<string>();
  /** Each `POST`'s hosts, as they came. */
  readonly posts: unknown[] = [];
  /** RAVIS can't read Codex's list: a read answers 503, and so does a write whose hosts all pass. */
  unreadable = false;
  /** Codex doesn't take the next write: `409 SITE_NOT_ADDED` with this reason. */
  notAdded: string | undefined;

  constructor() {
    const listed = fixtureAnswer(SITES_ROUTE, 'the defaults and the sites the owner added').body as { defaults: string[] };
    this.defaults = [...listed.defaults];
  }

  /** The answer for a sites route, or undefined for any other route. */
  answer(route: FixtureRoute, body: unknown): FakeAnswer | undefined {
    if (route.key === SITES_ROUTE) return this.unreadable ? fixtureAnswer(SITES_ROUTE, "Codex isn't running") : this.view();
    return route.key === ALLOW_SITES_ROUTE ? this.allow(body) : undefined;
  }

  /** RAVIS's `allow`: 1 to 20 hosts, every one checked before anything; then Codex's list read, then one write. */
  private allow(body: unknown): FakeAnswer {
    const hosts = (body as { hosts?: unknown } | undefined)?.hosts;
    if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > MOST_HOSTS || !hosts.every((host) => typeof host === 'string')) {
      return fixtureAnswer(ALLOW_SITES_ROUTE, 'no hosts');
    }
    this.posts.push(hosts);
    const refused = (hosts as string[]).flatMap((host) => {
      const reason = siteRefusal(host);
      return reason ? [{ host, reason }] : [];
    });
    if (refused.length > 0) return withDetails(fixtureAnswer(ALLOW_SITES_ROUTE, 'a host RAVIS never allows: nothing is written'), { refused });
    if (this.unreadable) {
      const offContract = "codex-admin.json's POST rules name 503 CODEX_RUNTIME_UNAVAILABLE, but no example shows it";
      return { ...fixtureAnswer(SITES_ROUTE, "Codex isn't running"), offContract };
    }
    const sites = [...new Set((hosts as string[]).map(normalised))];
    if (this.notAdded !== undefined) {
      const reason = this.notAdded;
      this.notAdded = undefined;
      return withDetails(fixtureAnswer(ALLOW_SITES_ROUTE, "Codex didn't add them"), { hosts: sites, reason });
    }
    for (const site of sites) if (!this.defaults.includes(site)) this.added.add(site);
    return this.view();
  }

  private view(): FakeAnswer {
    return { status: 200, body: { defaults: [...this.defaults], added: [...this.added].sort() } };
  }
}

/** `sites.py`'s `site_refusal`: why a host can't be allowed, in `SITES_REFUSED`'s words; undefined for a plain public host. */
function siteRefusal(value: string): string | undefined {
  const host = normalised(value);
  if (host.includes('*')) return 'wildcard';
  if (isIP(host.replace(/^[[\]]+|[[\]]+$/g, '')) !== 0) return 'ip_address';
  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'local_name';
  return HOST.test(host) ? undefined : 'not_a_host_name';
}

/** `value.strip().lower().rstrip(".")`, near enough for a test double. */
function normalised(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}
