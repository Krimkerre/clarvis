import { ToolName } from './toolRegistry';

/**
 * What the agent is doing, said the way a person would say it.
 *
 * The transcript is where someone watches work happen; `applyEdit: src/app.ts` is a
 * log line that leaked into a conversation. The technical form still goes to the
 * output channel, where the precise tool name and arguments are exactly what you want
 * when something has gone wrong.
 *
 * Pure, because the wording is the feature and there is nothing else here.
 */
export function narrateTool(name: ToolName, args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path : undefined;
  const command = typeof args.command === 'string' ? args.command : undefined;
  const pattern = typeof args.pattern === 'string' ? args.pattern : undefined;
  const directory = typeof args.directory === 'string' ? args.directory : undefined;

  switch (name) {
    case 'readFile':
      return `Reading ${path ?? 'a file'}`;
    case 'listFiles':
      return directory && directory !== '.' ? `Looking through ${directory}` : 'Looking through the project';
    case 'search':
      return pattern ? `Searching for ${pattern}` : 'Searching the project';
    case 'applyEdit':
      return `Editing ${path ?? 'a file'}`;
    case 'writeFile':
      return `Writing ${path ?? 'a file'}`;
    case 'runCommand':
      return narrateCommand(command);
    case 'readDiagnostics':
      return 'Checking what the editor is complaining about';
    case 'gitStatus':
      return 'Checking where things stand in git';
    case 'gitDiff':
      return 'Reading the current diff';
    default:
      return name;
  }
}

/**
 * A command, described rather than quoted.
 *
 * `git show a1dc402 -- plan.md; echo ---; git show de8ee1f -- plan.md` is a perfectly
 * good thing to find in a log and an alarming thing to read in a conversation. The
 * audience (§6) does not know what a commit hash is, and showing them four of them
 * makes a routine look-up feel like something going wrong.
 *
 * Short, familiar commands are still shown verbatim — a developer reads `npm test`
 * faster than any sentence about it, and hiding it would be its own kind of unclear.
 */
export function narrateCommand(command: string | undefined): string {
  if (!command) return 'Running a command';

  const trimmed = command.trim();

  // Compound commands are always noise in a transcript: several things at once, joined
  // by punctuation nobody reads.
  const compound = /[;&|]{1,2}/.test(trimmed);

  for (const { pattern, said } of COMMAND_PHRASES) {
    if (pattern.test(trimmed)) return said;
  }

  if (compound || trimmed.length > 40) return 'Running a few commands';
  return `Running ${trimmed}`;
}

/** Common commands, in the terms of what they are *for*. */
const COMMAND_PHRASES: { pattern: RegExp; said: string }[] = [
  { pattern: /^git\s+(log|show|reflog)\b/, said: 'Reading the project history' },
  { pattern: /^git\s+(status|diff)\b/, said: 'Checking what has changed' },
  { pattern: /^git\s+branch\s+-{1,2}[dD]\b/, said: 'Deleting a branch' },
  { pattern: /^git\s+branch\s*(-{1,2}[a-z-]+\s*)*$/i, said: 'Listing the branches' },
  { pattern: /^git\s+branch\s+\S/, said: 'Making a branch' },
  { pattern: /^git\s+(checkout|switch)\b/, said: 'Switching branch' },
  { pattern: /^git\s+(add|commit)\b/, said: 'Saving the changes' },
  { pattern: /^(ls|find|cat|head|tail|grep|rg)\b/, said: 'Looking through the project' },
];

/**
 * Whether a step is Clarvis reading rather than changing anything.
 *
 * Used to collapse a run of them into one line. Nine "Reading x" lines describe the
 * machinery; "Having a look at the project" describes what is happening.
 */
export function isLookingAround(name: ToolName, args: Record<string, unknown>): boolean {
  if (name === 'runCommand') {
    const command = typeof args.command === 'string' ? args.command.trim() : '';

    // `git branch` and `git branch -a` list; `git branch new-thing` creates one. The
    // difference is a positional argument, and treating them alike would quietly hide
    // a branch being made — which is exactly the kind of change worth showing.
    const listsBranches = /^git\s+branch\s*(-{1,2}[a-z-]+\s*)*$/i.test(command);
    const reads = /^(git\s+(log|show|status|diff|reflog)|ls|find|cat|head|tail|grep|rg)\b/.test(command);

    return listsBranches || reads;
  }

  return ['readFile', 'listFiles', 'search', 'readDiagnostics', 'gitStatus', 'gitDiff'].includes(name);
}
