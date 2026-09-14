/**
 * Asking the owner about the sites a Codex task needs (plan.md M15, C2b+; the ecosystem's build notes, "Owner
 * decisions 14 Sep 2026 — allowing sites before and during a task").
 *
 * **Why sites are asked at all.** Codex's commands reach the internet only through RAVIS's list of allowed
 * sites: calibration proved that approving a command never opens the network on Codex 0.154.0, so a command
 * that needs a site not on the list fails with the proxy's fixed line, and RAVIS asks the owner about that
 * host. Allowing it adds exactly that host, for every Codex task from then on.
 *
 * **Two moments, one set of words** (the owner's two choices of four, 14 September 2026):
 * - **Before a task starts.** Clarvis looks through the project for the hosts it will likely need
 *   (`siteScan.ts`), drops the ones already allowed, and asks once: "This task may need a.com and b.org.
 *   Allow them before Codex starts?" — **Allow and start**, **Start without them**, **Cancel**. A site allowed
 *   before a task starts needs no pause, because Codex reads the list when it loads the task.
 * - **While a task runs.** A running task never sees a site added later; only reopening it does (calibration
 *   run `cal_5a1d6ecc33b4`: unsubscribed, unloaded after about 60 s, resumed). So RAVIS ends the turn, starts
 *   reopening at once, and asks about every host that turn was blocked from as one group. Clarvis shows the
 *   group as one card — each host with **Allow** or **Keep blocked**, plus **Allow all** — says it is
 *   reconnecting, and once every host is decided, carries the task on: "The owner allowed X; Y stays blocked.
 *   Carry on where you stopped."
 *
 * Until RAVIS groups site asks (its R5 contract), each site ask is a card of one host.
 *
 * Pure: words, buttons and the bookkeeping of a card. Posting the decisions and the turn is the runner's.
 */

import type { RequestView } from '../relay/relayTypes';

/** One blocked host RAVIS asked about: its request, the host, and how the command wanted to reach it. */
export interface SiteAsk {
  requestId: string;
  host: string;
  protocol: string | null;
}

export type SiteDecision = 'allow_site' | 'keep_blocked';

/** A button on a card, and which asks it decides: one host, or every host still open (**Allow all**). */
export interface CardOption {
  label: string;
  detail?: string;
  decides: { requestId: string; decision: SiteDecision }[];
}

export interface CardView {
  line: string;
  detail: string[];
  options: CardOption[];
  /** A few words for a spoken reminder, when nobody answers. */
  about: string;
}

export const SITE_LINES = {
  /** Said while RAVIS reopens the task, so the minute it takes isn't read as the task hanging. */
  reconnecting: 'Reconnecting Codex so newly allowed sites work (up to a minute)…',
  allowedMeansEveryTask: "Allowing a site lets Codex's commands reach it in every task from now on.",
} as const;

/** The site a `site` request names, or undefined when its payload has no host. */
export function siteAskFrom(request: RequestView): SiteAsk | undefined {
  const { host, protocol } = request.payload as { host?: unknown; protocol?: unknown };
  if (typeof host !== 'string' || host === '') return undefined;
  return { requestId: request.id, host, protocol: typeof protocol === 'string' ? protocol : null };
}

/** "a.com", "a.com and b.org", "a.com, b.org and c.net". */
export function joinHosts(hosts: readonly string[]): string {
  if (hosts.length <= 1) return hosts[0] ?? '';
  return `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1]}`;
}

/**
 * The turn that carries a task on once every host in its group is decided (the build notes' words): what the
 * owner allowed, what stays blocked, and to carry on. Codex was told to end its turn when blocked rather than
 * hunt for a way round, so it needs to hear both halves.
 */
export function carryOnText(allowed: readonly string[], kept: readonly string[]): string {
  const carryOn = 'Carry on where you stopped.';
  const stays = `${joinHosts(kept)} ${kept.length === 1 ? 'stays' : 'stay'} blocked`;
  if (allowed.length > 0 && kept.length > 0) return `The owner allowed ${joinHosts(allowed)}; ${stays}. ${carryOn}`;
  if (allowed.length > 0) return `The owner allowed ${joinHosts(allowed)}. ${carryOn}`;
  return `The owner kept ${joinHosts(kept)} blocked. ${carryOn}`;
}

/**
 * The card for a group of blocked hosts, decided a host at a time or all at once. Records the owner's
 * decisions and what each host still needs, so the card can be drawn again for the hosts left.
 */
export class SiteGroupCard {
  private readonly decided = new Map<string, SiteDecision>();

  constructor(readonly asks: readonly SiteAsk[]) {}

  /** The hosts nobody has decided yet. */
  get open(): SiteAsk[] {
    return this.asks.filter((ask) => !this.decided.has(ask.requestId));
  }

  /** Every host decided: time to carry the task on. */
  get complete(): boolean {
    return this.open.length === 0;
  }

  get allowed(): string[] {
    return this.hostsDecided('allow_site');
  }

  get kept(): string[] {
    return this.hostsDecided('keep_blocked');
  }

  /** Notes a decision RAVIS took. */
  record(requestId: string, decision: SiteDecision): void {
    if (this.asks.some((ask) => ask.requestId === requestId)) this.decided.set(requestId, decision);
  }

  /** The card for the hosts still open. */
  view(): CardView {
    const open = this.open;
    const hosts = open.map((ask) => ask.host);
    const how = open.length === 1 && open[0].protocol ? ` (${open[0].protocol})` : '';
    return {
      line: `Codex was blocked from reaching ${joinHosts(hosts)}${how}.`,
      detail: [SITE_LINES.allowedMeansEveryTask],
      options: [...open.flatMap(hostOptions), ...allowAll(open)],
      about: `the blocked site${hosts.length === 1 ? '' : 's'} ${joinHosts(hosts)}`,
    };
  }

  /** The decisions a reply makes: a button's label, or its number. Undefined when it isn't one. */
  read(reply: string): CardOption['decides'] | undefined {
    const options = this.view().options;
    const trimmed = reply.trim();
    const byNumber = /^\d+$/.test(trimmed) ? options[Number(trimmed) - 1] : undefined;
    const option = byNumber ?? options.find((candidate) => candidate.label.toLowerCase() === trimmed.toLowerCase());
    return option?.decides;
  }

  private hostsDecided(decision: SiteDecision): string[] {
    return this.asks.filter((ask) => this.decided.get(ask.requestId) === decision).map((ask) => ask.host);
  }
}

function hostOptions(ask: SiteAsk): CardOption[] {
  return [
    { label: `Allow ${ask.host}`, decides: [{ requestId: ask.requestId, decision: 'allow_site' }] },
    { label: `Keep ${ask.host} blocked`, decides: [{ requestId: ask.requestId, decision: 'keep_blocked' }] },
  ];
}

/** **Allow all**, once there is more than one host left to decide. */
function allowAll(open: readonly SiteAsk[]): CardOption[] {
  if (open.length < 2) return [];
  return [{ label: 'Allow all', decides: open.map((ask) => ({ requestId: ask.requestId, decision: 'allow_site' as const })) }];
}

/** The owner's answer to the ask before a task starts. */
export type PreTaskChoice = 'allow_and_start' | 'start_without' | 'cancel';

/** The ask before a task starts: which hosts, and the three ways on (the build notes' words). */
export function preTaskAsk(hosts: readonly string[]): { line: string; options: { label: string; detail: string }[] } {
  const one = hosts.length === 1;
  return {
    line: `This task may need ${joinHosts(hosts)}. Allow ${one ? 'it' : 'them'} before Codex starts?`,
    options: [
      { label: 'Allow and start', detail: `Codex's commands may reach ${one ? 'it' : 'them'} in this task and every later one` },
      { label: `Start without ${one ? 'it' : 'them'}`, detail: 'Codex asks again if a command is blocked' },
      { label: 'Cancel', detail: 'Nothing starts' },
    ],
  };
}

/** Which of the three a reply chose; undefined — nothing starts — for anything else, a Stop included. */
export function preTaskChoice(reply: string | undefined): PreTaskChoice | undefined {
  const said = reply?.trim().toLowerCase() ?? '';
  if (said === 'allow and start') return 'allow_and_start';
  if (said === 'start without them' || said === 'start without it') return 'start_without';
  return said === 'cancel' ? 'cancel' : undefined;
}
