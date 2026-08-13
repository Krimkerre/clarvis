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
