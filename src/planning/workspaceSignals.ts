/**
 * The shape of what `workspaceResearch.ts` finds, and how to describe it in a
 * sentence. Split out and `vscode`-free so it's testable without the extension host
 * — same reason the prompt/parser pairs elsewhere in M9 live apart from their glue.
 */

export interface WorkspaceSignals {
  hasGit: boolean;
  manifestFile?: string;
  topLevelEntries: string[];
  readmeFirstLine?: string;
  planMdExists: boolean;
}

/** One plain sentence summarising what was found. Only ever real, observed facts. */
export function describeWorkspaceSignals(signals: WorkspaceSignals): string {
  const facts: string[] = [];
  if (signals.manifestFile) facts.push(`an existing ${signals.manifestFile}`);
  if (signals.hasGit) facts.push('a git repository already');
  if (signals.planMdExists) facts.push('an existing plan.md');
  if (signals.readmeFirstLine) facts.push(`a README starting "${signals.readmeFirstLine}"`);

  if (facts.length === 0) return 'An empty workspace — nothing built here yet.';
  return `This workspace already has: ${facts.join(', ')}.`;
}

/**
 * Whether this reads as a brand new project rather than one already underway.
 *
 * The offer to plan reacts to what is actually here: an empty folder deserves "oh, a
 * new project?", and a year of code with no `plan.md` very much does not. No git and
 * almost nothing in the folder is the whole test — deliberately crude, because the
 * cost of being wrong is one slightly-off opening line.
 *
 * Absent signals mean the research failed, which is not evidence of newness.
 */
export function looksLikeNewProject(signals?: WorkspaceSignals): boolean {
  return signals ? !signals.hasGit && signals.topLevelEntries.length <= 2 : false;
}

/**
 * What to tell the model when offering to plan, and what to say if it is not there.
 *
 * Pure so the two beats can be checked without a model or a workspace: notice what
 * you have walked into, *then* offer. A line that merely restates "there is no
 * plan.md" is a failed line, and that is easier to assert here than to notice live.
 */
export function planOfferPrompt(signals?: WorkspaceSignals): { context: string; fallback: string } {
  const isNew = looksLikeNewProject(signals);

  const context = [
    isNew
      ? 'They have just opened what looks like a brand new project: an empty folder, nothing built yet, and no plan.md.'
      : 'They have opened a project that already has files in it — someone has been working here — but there is no plan.md, so none of it was ever written down.',
    signals ? `What is actually in the folder: ${describeWorkspaceSignals(signals)}` : '',
    '',
    'Two beats, in this order. First: notice what you have walked into and have a',
    'view about it — a new project deserves a different remark from one already',
    'full of code nobody planned, and a line that merely restates "there is no',
    'plan.md" is a failed line.',
    'Then: offer to plan it with them — an interview, then a written plan they',
    'sign off on.',
  ]
    .filter(Boolean)
    .join(' ');

  const fallback = isNew
    ? 'Oh, a new project? We could sketch out what this is meant to do before the next person asks — or would you rather keep discovering it as we go?'
    : 'No plan.md, and a folder full of files that presumably mean something to someone. Would you like help working out what this is?';

  return { context, fallback };
}
