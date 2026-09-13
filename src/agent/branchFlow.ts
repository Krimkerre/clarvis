/**
 * The project's own branching rules, read from its `plan.md`.
 *
 * Conventions (`main`, `testing`, `develop`) are a guess that happens to be right
 * often. A project that has written its flow down has stopped guessing, and Clarvis
 * should follow what it says rather than what most repositories do — a wizard that
 * offers `main` to a team whose trunk is `production` is confidently wrong in a way
 * that costs a merge.
 *
 * The format is a plain list under a heading, because `plan.md` is a document people
 * read and edit, not a config file. Anything unparseable is ignored rather than
 * fought over: falling back to conventions is a working wizard, and a parse error in
 * a prose document is not worth failing a run for.
 */

export interface BranchFlow {
  /** Where finished work eventually lands. */
  trunk?: string;
  /** The branch work passes through first, if the project uses one. */
  integration?: string;
  /**
   * Patterns for branches that are *work*, not steps in the flow.
   *
   * Load-bearing, not informational: without these, every feature branch in the
   * repository looks like an undeclared part of the flow and gets asked about. A
   * project with twelve milestone branches would be interrogated twelve times.
   *
   * `<task>` and `*` both stand for "anything here" — `clarvis/<task>`, `feature/*`,
   * `m*-*` are all sensible entries.
   */
  work?: string[];
  /**
   * Further branches the project routes work through, beyond the first.
   *
   * A flow is not always three branches: a project can have `staging` *and* `qa`, and
   * forcing the second into "trunk" or discarding it would misrepresent the workflow
   * the user just described.
   */
  extra?: string[];
}

/** The heading this looks under. Matched loosely — people write headings by hand. */
const HEADING = /^#{1,6}\s.*\bbranch(ing)?\s+flow\b/i;

/** `- trunk: main`, `* integration: testing`, `trunk: main` — all acceptable. */
const ENTRY = /^\s*(?:[-*+]\s*)?(trunk|main branch|integration|staging|work|feature)\s*[:=]\s*(.+?)\s*$/i;

/**
 * Reads a branch flow out of a plan document.
 *
 * Only the section under the heading is considered, so a mention of "trunk" in prose
 * elsewhere cannot be mistaken for a declaration. Reading stops at the next heading,
 * which is what makes the section a boundary rather than a starting point.
 */
export function parseBranchFlow(markdown: string): BranchFlow {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => HEADING.test(line));
  if (start === -1) return {};

  const flow: BranchFlow = {};

  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^#{1,6}\s/.test(line)) break; // next heading ends the section

    const match = ENTRY.exec(line);
    if (!match) continue;

    const key = match[1].toLowerCase();
    const value = cleanBranchName(match[2]);
    if (!value) continue;

    if (key === 'trunk' || key === 'main branch') flow.trunk ??= value;
    else if (key === 'integration' || key === 'staging') {
      // The first integration branch is the primary one; later ones are additional
      // steps rather than a correction of the first.
      if (flow.integration === undefined) flow.integration = value;
      else (flow.extra ??= []).push(value);
    } else (flow.work ??= []).push(value);
  }

  return flow;
}

/**
 * Strips the decoration people put around branch names in prose.
 *
 * Backticks, quotes and trailing commentary all appear in hand-written plans —
 * `` `main` (production) `` is a perfectly normal thing to write, and treating it as a
 * branch name called "`main` (production)" would silently break every merge.
 */
function cleanBranchName(raw: string): string | undefined {
  const cleaned = raw
    .replace(/[`"']/g, '')
    .split(/[—–,(]/)[0] // drop trailing commentary
    .trim();

  // A branch name has no spaces; anything with one is prose that got this far.
  if (!cleaned || /\s/.test(cleaned)) return undefined;
  return cleaned;
}

/**
 * The section written into a generated `plan.md` (§4.9).
 *
 * Written as prose with a parseable shape rather than a config block: the user reads
 * and edits this, and a document that hides machine-readable settings in an HTML
 * comment teaches people not to trust what they can see.
 */
// `main` when the caller has no branch to go on — no repository yet, or a detached HEAD.
export function branchFlowSection(trunk = 'main', integration?: string): string {
  return renderSection({ trunk, integration, work: ['clarvis/<task>'] });
}

/**
 * Whether a branch is covered by a work pattern rather than being part of the flow.
 *
 * Anything between angle brackets, and `*`, match a run of characters. Everything else
 * is literal — a pattern language rich enough to be surprising would be a pattern
 * language people get wrong.
 */
export function matchesWork(branch: string, patterns: string[] = []): boolean {
  return patterns.some((pattern) => {
    const source = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex metacharacters
      .replace(/<[^>]*>/g, '.+')
      .replace(/\*/g, '.+');

    return new RegExp(`^${source}$`).test(branch);
  });
}

/** Every branch the flow names, for working out what is new. */
export function flowBranches(flow: BranchFlow): string[] {
  return [flow.trunk, flow.integration, ...(flow.extra ?? [])].filter(
    (name): name is string => Boolean(name)
  );
}

/**
 * Writes a flow back into a plan document.
 *
 * Replaces the existing section in place when there is one, so the surrounding
 * document — and whatever the user wrote around it — survives. Appends only when the
 * section is genuinely absent.
 *
 * Rewriting the whole file from the parsed flow would be simpler and would silently
 * delete every sentence someone added under that heading, which is exactly the kind of
 * edit that makes people stop trusting a tool with their documents.
 */
export function writeBranchFlow(markdown: string, flow: BranchFlow): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => HEADING.test(line));

  if (start === -1) {
    const separator = markdown.endsWith('\n') ? '\n' : '\n\n';
    return `${markdown}${separator}${renderSection(flow)}`;
  }

  // The section runs to the next heading, or to the end of the document.
  let end = start + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++;

  const body = lines.slice(start + 1, end);
  const entries = renderEntries(flow);
  const firstEntry = body.findIndex((line) => ENTRY.test(line));

  // **Only the list is ours.** Everything else in the section is something the user
  // wrote — a note about why the flow is what it is, a warning about the release
  // branch — and replacing the whole section deleted it. A tool that quietly eats
  // prose is one people stop letting near their documents.
  const kept = body.filter((line) => !ENTRY.test(line));

  const rebuilt =
    firstEntry === -1
      ? [...trimTrailingBlanks(body), '', ...entries, '']
      : [
          ...trimTrailingBlanks(body.slice(0, firstEntry).filter((line) => !ENTRY.test(line))),
          ...entries,
          ...trimLeadingBlanks(kept.slice(countProseBefore(body, firstEntry))),
        ];

  return [...lines.slice(0, start + 1), ...rebuilt, ...lines.slice(end)].join('\n');
}

/** How many non-entry lines precede the first entry, so the rest can be re-attached. */
function countProseBefore(body: string[], firstEntry: number): number {
  return body.slice(0, firstEntry).filter((line) => !ENTRY.test(line)).length;
}

function trimTrailingBlanks(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop();
  return copy.length > 0 ? [...copy, ''] : [];
}

function trimLeadingBlanks(lines: string[]): string[] {
  const copy = [...lines];
  while (copy.length > 0 && copy[0].trim() === '') copy.shift();
  return copy.length > 0 ? ['', ...copy] : [''];
}

/** Just the list, which is the part Clarvis owns. */
function renderEntries(flow: BranchFlow): string[] {
  const entries: string[] = [];

  if (flow.trunk) entries.push(`- trunk: ${flow.trunk}`);
  if (flow.integration) entries.push(`- integration: ${flow.integration}`);
  for (const extra of flow.extra ?? []) entries.push(`- integration: ${extra}`);
  for (const work of flow.work ?? ['clarvis/<task>']) entries.push(`- work: ${work}`);

  return entries;
}

/** A whole section, for a document that has none. The prose here is a starting point. */
function renderSection(flow: BranchFlow): string {
  return [
    '## Branch flow',
    '',
    'How work moves through this project. Clarvis follows this when offering to merge',
    'an agent run, so changing it here changes what he offers.',
    '',
    ...renderEntries(flow),
    '',
  ].join('\n');
}

/**
 * Removes a branch from a flow, wherever it sits.
 *
 * Returns the flow unchanged when the branch isn't in it, so the caller can compare
 * and skip a pointless rewrite of the document.
 */
export function withoutBranch(flow: BranchFlow, branch: string): BranchFlow {
  return {
    ...flow,
    trunk: flow.trunk === branch ? undefined : flow.trunk,
    integration: flow.integration === branch ? undefined : flow.integration,
    extra: (flow.extra ?? []).filter((name) => name !== branch),
  };
}

/**
 * The flow with `branch` as its trunk, keeping the old trunk as a step only if it exists.
 *
 * **Found live, 13 September 2026.** A plan written into a fresh repository declared
 * `trunk: main` — the default — while `git init` had made `master`. Answering "It's the
 * trunk" for `master` then wrote `integration: main` into the plan and said "`master` is
 * the trunk now, with `main` kept as a step", about a branch that had never existed. Keeping
 * the old trunk is right for a project moving from `master` to `main`, which still routes
 * work through the old one for a while; it is only right when there is an old one.
 *
 * Local *and* remote, as in `missingBranches`: an old trunk deleted locally but alive on
 * the remote is still a branch work goes through.
 */
export function withTrunk(
  flow: BranchFlow,
  branch: string,
  existing: { local: string[]; remote: string[] }
): { flow: BranchFlow; keptAsStep?: string } {
  const known = new Set([...existing.local, ...existing.remote.map(stripRemote)]);
  const old = flow.trunk;
  const keptAsStep = old && old !== branch && known.has(old) ? old : undefined;

  return {
    flow: { ...flow, trunk: branch, extra: [...(flow.extra ?? []), ...(keptAsStep ? [keptAsStep] : [])] },
    keptAsStep,
  };
}

/**
 * Branches the flow names that no longer exist anywhere.
 *
 * **Local *and* remote.** Deleting a branch locally after merging it is routine — the
 * work is on the trunk and the branch was tidy-up — and asking about that every time
 * would punish good housekeeping. A branch gone from the remote as well is one the
 * project has actually finished with.
 *
 * The trunk is never reported: a repository whose trunk is missing has a much larger
 * problem than a stale line in a document, and offering to delete the entry would be
 * answering the wrong question.
 */
export function missingBranches(flow: BranchFlow, local: string[], remote: string[]): string[] {
  const known = new Set([...local, ...remote.map(stripRemote)]);

  return [flow.integration, ...(flow.extra ?? [])]
    .filter((name): name is string => Boolean(name))
    .filter((name) => !known.has(name));
}

/** `origin/testing` → `testing`, so the two lists can be compared at all. */
function stripRemote(ref: string): string {
  const slash = ref.indexOf('/');
  return slash === -1 ? ref : ref.slice(slash + 1);
}
