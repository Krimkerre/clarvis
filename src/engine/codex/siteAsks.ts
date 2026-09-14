/**
 * Asking the owner about the sites a Codex task needs (plan.md M15, C2b+; the ecosystem's build notes, "Owner
 * decisions 14 Sep 2026 — allowing sites before and during a task", and "From R5").
 *
 * **Why sites are asked at all.** Codex's commands reach the internet only through RAVIS's list of allowed
 * sites: calibration proved that approving a command never opens the network on Codex 0.154.0, so a command
 * that needs a site not on the list fails with the proxy's fixed line, and RAVIS asks the owner about that
 * host. Allowing it adds exactly that host, for every Codex task from then on.
 *
 * **Two moments, one set of words** (the owner's two choices of four, 14 September 2026):
 * - **Before a task starts.** Clarvis looks through the project for the hosts it will likely need
 *   (`siteScan.ts`), drops the ones already allowed, and asks once — about at most 20, as many as one
 *   `POST /api/v1/codex/sites` takes: "This task may need a.com and b.org. Allow them before Codex starts?" —
 *   **Allow and start**, **Start without them**, **Cancel**. A site allowed before a task starts needs no pause,
 *   because Codex reads the list when it loads the task.
 * - **While a task runs.** A running task never sees a site added later; only reopening it does (calibration
 *   run `cal_5a1d6ecc33b4`: unsubscribed, unloaded after about 60 s, resumed). So RAVIS asks about every host a
 *   turn was blocked from as one group (`group_id`: one group open at a time, its asks open together), and once
 *   the turn ends it reopens the task's thread. Clarvis shows the group as one card — each host with **Allow** or
 *   **Keep blocked**, plus **Allow all** — which a host opening later joins. While RAVIS reopens
 *   (`site.reopening`, as often as it does) Clarvis shows "Reconnecting Codex…" under the chat, and drops it once
 *   Codex has let go of the thread (`site.reopened`): the moment an allowed site works. At RAVIS's two-minute cap
 *   (`site.reopen_incomplete`) it says an allowed site may still be blocked. Once every host is decided it carries
 *   the task on — "The owner allowed X; Y stays blocked. Carry on where you stopped." — and RAVIS holds that turn
 *   until the thread is reopened.
 *
 * Pure: words, buttons and the bookkeeping of a card. Posting the decisions and the turn is the runner's.
 */

import type { DecisionKind, RequestView } from '../relay/relayTypes';
import type { PromptOption, RequestPrompt } from './approvals';
import type { FoundSite } from './siteScan';

export type SiteDecision = 'allow_site' | 'keep_blocked';

/** One blocked host RAVIS asked about: its request, the host, how the command wanted to reach it, and what RAVIS offers. */
export interface SiteAsk {
  requestId: string;
  host: string;
  protocol: string | null;
  /** The decisions RAVIS allows for this ask: a button for each, and none for anything else. */
  offers: SiteDecision[];
}

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
  /** Shown under the chat while RAVIS reopens the task, so the minute it takes isn't read as the task hanging. */
  reconnecting: 'Reconnecting Codex so newly allowed sites work (up to a minute)…',
  allowedMeansEveryTask: "Allowing a site lets Codex's commands reach it in every task from now on.",
  /** `site.reopen_incomplete`: Codex still held the task's thread after two minutes (R5). */
  reopenIncomplete: "Codex didn't reconnect within two minutes, so a site allowed just now may still be blocked in this task.",
  /** The owner's Cancel at the ask before a start. */
  cancelled: "Cancelled, so Codex didn't start.",
} as const;

/** The most hosts one `POST /api/v1/codex/sites` takes, and so the most asked about before a start (R5). */
export const MOST_SITES = 20;

const SITE_DECISIONS: readonly SiteDecision[] = ['allow_site', 'keep_blocked'];

/** The site a `site` request names, with the decisions RAVIS offers for it; undefined when its payload has no host. */
export function siteAskFrom(request: RequestView): SiteAsk | undefined {
  const { host, protocol } = request.payload as { host?: unknown; protocol?: unknown };
  if (typeof host !== 'string' || host === '') return undefined;
  const offers = SITE_DECISIONS.filter((decision) => request.allowed_decisions.includes(decision));
  return { requestId: request.id, host, protocol: typeof protocol === 'string' ? protocol : null, offers };
}

/** "a.com", "a.com and b.org", "a.com, b.org and c.net". */
export function joinHosts(hosts: readonly string[]): string {
  if (hosts.length <= 1) return hosts[0] ?? '';
  return `${hosts.slice(0, -1).join(', ')} and ${hosts[hosts.length - 1]}`;
}

/** "a.com stays blocked", "a.com and b.org stay blocked". */
function staysBlocked(kept: readonly string[]): string {
  return `${joinHosts(kept)} ${kept.length === 1 ? 'stays' : 'stay'} blocked`;
}

/**
 * The turn that carries a task on once every host in its group is decided (the build notes' words): what the
 * owner allowed, what stays blocked, and to carry on. Codex was told to end its turn when blocked rather than
 * hunt for a way round, so it needs to hear both halves.
 */
export function carryOnText(allowed: readonly string[], kept: readonly string[]): string {
  const carryOn = 'Carry on where you stopped.';
  if (allowed.length > 0 && kept.length > 0) return `The owner allowed ${joinHosts(allowed)}; ${staysBlocked(kept)}. ${carryOn}`;
  if (allowed.length > 0) return `The owner allowed ${joinHosts(allowed)}. ${carryOn}`;
  return `The owner kept ${joinHosts(kept)} blocked. ${carryOn}`;
}

/** Said in the window whose answer decided a group's last host: what was allowed, what stays blocked, and that Codex goes on. */
export function siteDecisionsLine(allowed: readonly string[], kept: readonly string[]): string {
  const goesOn = 'Codex carries on where it stopped.';
  if (allowed.length > 0 && kept.length > 0) return `Allowed ${joinHosts(allowed)}; ${staysBlocked(kept)}. ${goesOn}`;
  if (allowed.length > 0) return `Allowed ${joinHosts(allowed)}. ${goesOn}`;
  return `${staysBlocked(kept)}. ${goesOn}`;
}

/**
 * The card for a group of blocked hosts, decided a host at a time or all at once. Records the owner's
 * decisions and what each host still needs, so the card can be drawn again for the hosts left.
 */
export class SiteGroupCard {
  private readonly decided = new Map<string, SiteDecision>();
  private readonly held: SiteAsk[];

  constructor(asks: readonly SiteAsk[]) {
    this.held = [...asks];
  }

  /** Every host the group asked about, decided or not, in the order they opened. */
  get asks(): readonly SiteAsk[] {
    return this.held;
  }

  /** The hosts nobody has decided yet. */
  get open(): SiteAsk[] {
    return this.held.filter((ask) => !this.decided.has(ask.requestId));
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

  /** A host of the group that opened after the card was first drawn (R5). False when it is already on the card. */
  add(ask: SiteAsk): boolean {
    if (this.held.some((known) => known.requestId === ask.requestId)) return false;
    this.held.push(ask);
    return true;
  }

  /** Notes a decision RAVIS took. */
  record(requestId: string, decision: SiteDecision): void {
    if (this.held.some((ask) => ask.requestId === requestId)) this.decided.set(requestId, decision);
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
    return this.held.filter((ask) => this.decided.get(ask.requestId) === decision).map((ask) => ask.host);
  }
}

/** A host's two buttons, as far as RAVIS offers them. */
function hostOptions(ask: SiteAsk): CardOption[] {
  const options: CardOption[] = [
    { label: `Allow ${ask.host}`, decides: [{ requestId: ask.requestId, decision: 'allow_site' }] },
    { label: `Keep ${ask.host} blocked`, decides: [{ requestId: ask.requestId, decision: 'keep_blocked' }] },
  ];
  return options.filter((option) => ask.offers.includes(option.decides[0].decision));
}

/** **Allow all**, once more than one host left to decide may be allowed. */
function allowAll(open: readonly SiteAsk[]): CardOption[] {
  const allowable = open.filter((ask) => ask.offers.includes('allow_site'));
  if (allowable.length < 2) return [];
  return [{ label: 'Allow all', decides: allowable.map((ask) => ({ requestId: ask.requestId, decision: 'allow_site' as const })) }];
}

// ── Before a task starts ─────────────────────────────────────────────────────

/** The owner's answer to the ask before a task starts. */
export type PreTaskChoice = 'allow_and_start' | 'start_without' | 'cancel';

/** The request id the ask before a start goes by: it answers no request of RAVIS's. */
export const PRE_TASK_ASK = 'sites-before-start';

/**
 * The three buttons carry the nearest decisions — allow, keep blocked, stop — so the chat draws them as it draws one
 * of Codex's requests; `preTaskChoice` reads them back.
 */
const PRE_TASK_CHOICES: Partial<Record<DecisionKind, PreTaskChoice>> = {
  allow_site: 'allow_and_start',
  keep_blocked: 'start_without',
  stop: 'cancel',
};

/**
 * The ask before a task starts: which hosts, where each was found, and the three ways on (the build notes' words).
 * Once allowing them has failed, only **Start without** and **Cancel** are left; `before` says what happened first.
 */
export function preTaskAsk(found: readonly FoundSite[], allowOffered = true, before = ''): RequestPrompt {
  const hosts = found.map((site) => site.host);
  const them = hosts.length === 1 ? 'it' : 'them';
  const question = allowOffered ? `This task may need ${joinHosts(hosts)}. Allow ${them} before Codex starts?` : `Start Codex without ${joinHosts(hosts)}?`;
  const options: PromptOption[] = [
    { label: 'Allow and start', detail: `Codex's commands may reach ${them} in this task and every later one`, decision: { kind: 'allow_site' } },
    { label: `Start without ${them}`, detail: 'Codex asks again if a command is blocked', decision: { kind: 'keep_blocked' } },
    { label: 'Cancel', detail: 'Nothing starts', decision: { kind: 'stop' } },
  ];
  return {
    requestId: PRE_TASK_ASK,
    line: before === '' ? question : `${before} ${question}`,
    detail: found.map((site) => `${site.host}: found in ${joinHosts(site.foundIn)}`),
    options: allowOffered ? options : options.slice(1),
    about: `the site${hosts.length === 1 ? '' : 's'} this Codex task may need`,
  };
}

/** Which of the buttons a reply chose, by label or number; undefined — ask again — for anything else. */
export function preTaskChoice(prompt: RequestPrompt, reply: string | undefined): PreTaskChoice | undefined {
  const said = reply?.trim().toLowerCase() ?? '';
  const byNumber = /^\d+$/.test(said) ? prompt.options[Number(said) - 1] : undefined;
  const option = byNumber ?? prompt.options.find((candidate) => candidate.label.toLowerCase() === said);
  return option ? PRE_TASK_CHOICES[option.decision.kind] : undefined;
}

/** Said once "Allow and start" went through. */
export function sitesAllowedLine(hosts: readonly string[]): string {
  return `Allowed ${joinHosts(hosts)} for Codex's commands, in this task and every later one.`;
}

/** A host RAVIS won't allow, and why, in `SITES_REFUSED`'s words. */
export interface RefusedSite {
  host: string;
  reason: string;
}

const REFUSAL_WORDS: Record<string, string> = {
  not_a_host_name: 'not a plain host name',
  wildcard: 'a wildcard',
  ip_address: 'an IP address',
  local_name: 'a name on this Mac or its network',
};

/** The hosts a `422 SITES_REFUSED` names, with why (R5); empty for any other details. */
export function refusedSites(details: Record<string, unknown>): RefusedSite[] {
  const refused: unknown[] = Array.isArray(details.refused) ? details.refused : [];
  return refused.flatMap((entry) => {
    const { host, reason } = (entry ?? {}) as { host?: unknown; reason?: unknown };
    return typeof host === 'string' ? [{ host, reason: typeof reason === 'string' ? reason : '' }] : [];
  });
}

/** `422 SITES_REFUSED`: RAVIS's rule, and each host it won't take with why. Nothing was added. */
export function sitesRefusedLine(refused: readonly RefusedSite[]): string {
  const named = refused.map(({ host, reason }) => `${host} (${Object.hasOwn(REFUSAL_WORDS, reason) ? REFUSAL_WORDS[reason] : reason})`);
  return `RAVIS allows only exact public host names, so nothing was added: ${joinHosts(named)} can't be allowed.`;
}

/** `409 SITE_NOT_ADDED` before a start: Codex didn't take the write. */
export function sitesNotAddedLine(hosts: readonly string[]): string {
  return `Codex didn't add ${joinHosts(hosts)}, so ${hosts.length === 1 ? 'it stays' : 'they stay'} blocked.`;
}

/** Any other failure to allow them before a start: RAVIS not answering, or unable to read Codex's list. */
export function sitesNotAllowedLine(hosts: readonly string[]): string {
  return `${joinHosts(hosts)} couldn't be allowed right now, so ${hosts.length === 1 ? 'it stays' : 'they stay'} blocked.`;
}
