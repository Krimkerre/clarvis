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
  /** Pattern for agent branches, e.g. `clarvis/<task>`. Informational. */
  work?: string;
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
    else if (key === 'integration' || key === 'staging') flow.integration ??= value;
    else flow.work ??= value;
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
export function branchFlowSection(trunk: string, integration?: string): string {
  const lines = [
    '## Branch flow',
    '',
    'How work moves through this project. Clarvis follows this when offering to merge',
    'an agent run, so changing it here changes what he offers.',
    '',
    `- trunk: ${trunk}`,
  ];

  if (integration) lines.push(`- integration: ${integration}`);
  lines.push('- work: clarvis/<task>', '');

  return lines.join('\n');
}
