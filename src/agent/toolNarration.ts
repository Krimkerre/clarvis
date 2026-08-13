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
/**
 * How each tool reads in a transcript.
 *
 * A table rather than a switch: every arm was one expression, and the arms had nothing
 * to say to each other. A new tool is a line here, and the compiler insists it gets one,
 * because the key type is `ToolName` rather than `string`.
 */
const NARRATION: Record<ToolName, (parts: Parts) => string> = {
  readFile: ({ path }) => `Reading ${path ?? 'a file'}`,
  listFiles: ({ directory }) =>
    directory && directory !== '.' ? `Looking through ${directory}` : 'Looking through the project',
  search: ({ pattern }) => (pattern ? `Searching for ${pattern}` : 'Searching the project'),
  applyEdit: ({ path }) => `Editing ${path ?? 'a file'}`,
  writeFile: ({ path }) => `Writing ${path ?? 'a file'}`,
  runCommand: ({ command }) => narrateCommand(command),
  readDiagnostics: () => 'Checking what the editor is complaining about',
  gitStatus: () => 'Checking where things stand in git',
  gitDiff: () => 'Reading the current diff',
};

/** The arguments worth naming, already narrowed to strings. */
interface Parts {
  path?: string;
  command?: string;
  pattern?: string;
  directory?: string;
}

export function narrateTool(name: ToolName, args: Record<string, unknown>): string {
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const parts: Parts = {
    path: text(args.path),
    command: text(args.command),
    pattern: text(args.pattern),
    directory: text(args.directory),
  };

  // The name itself, for a tool that somehow has no entry — better than an empty line.
  return NARRATION[name]?.(parts) ?? name;
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
/**
 * Whether this call changes a file, as opposed to reading or running something.
 *
 * The two file-writing tools, named rather than derived: a new tool that edits
 * should have to say so here, and a rule inferred from the name would quietly
 * include the next thing called `writeSomething`.
 */
export function changesAFile(name: ToolName): boolean {
  return name === 'applyEdit' || name === 'writeFile';
}

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
