import type { FailureRecord } from './lastFailure';

/** Everything the briefing can draw on. Any part may be missing. */
export interface BriefingFacts {
  /** Absent when there's no Git extension, or the folder isn't a repository. */
  git?: { branch: string; dirtyCount: number };
  failure?: FailureRecord;
  recentFiles: string[];
  /** M5 fills this in; until then the briefing is simply shorter. */
  patternHint?: string;
}

/** `src/watch/BusyTracker.ts` → `BusyTracker.ts`. Paths are noise in one line of prose. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function gitLine(git: NonNullable<BriefingFacts['git']>): string {
  if (git.dirtyCount === 0) return `Branch ${git.branch}, working tree clean.`;
  const files = git.dirtyCount === 1 ? 'file' : 'files';
  return `Branch ${git.branch}, ${git.dirtyCount} ${files} dirty.`;
}

function failureLine(failure: FailureRecord): string {
  // No exit code means it was cancelled or a debug session — "was failing" would be a lie.
  if (failure.exitCode === undefined) return `${failure.label} was still running when you left.`;
  return `${failure.label} was red when you fled.`;
}

function filesLine(files: string[]): string {
  const names = files.slice(0, 3).map(basename);
  if (names.length === 1) return `Last touched ${names[0]}.`;
  return `Last touched ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}.`;
}

/**
 * Composes the briefing, skipping anything it has no facts for.
 *
 * Capped at four lines by §4.3, but the real rule is that every line has to earn its
 * place: a missing part is omitted rather than padded with "no failures recorded",
 * which is noise pretending to be information.
 *
 * Returns an empty array when there's nothing worth saying — a fresh window on a
 * non-repo folder with no history should produce silence, not a greeting.
 */
export function buildBriefingLines(facts: BriefingFacts): string[] {
  const lines: string[] = [];

  if (facts.git) lines.push(gitLine(facts.git));
  if (facts.failure) lines.push(failureLine(facts.failure));
  if (facts.recentFiles.length > 0) lines.push(filesLine(facts.recentFiles));
  if (facts.patternHint) lines.push(facts.patternHint);

  return lines;
}
