import { ToolName } from './toolRegistry';
import { narrateCommand } from './toolNarration';

/**
 * What a step is about to do, for the person deciding whether to allow it.
 *
 * **The approval prompt was showing a log line.** It carried `describe(call)` —
 * `runCommand: python3 -m pip install pillow` — which is the right thing to find in
 * an output channel and the wrong thing to be asked to approve. Found live, during
 * the first-run checklist: the prompt named the command and said nothing about what
 * allowing it would do, so the only way to answer was to already know.
 *
 * So a step explains itself the way a gate does (§4.6): what changes, and whether it
 * can be taken back. The exact command or path is still shown — it is the one detail
 * a developer reads faster than any sentence about it — but underneath the sentence
 * rather than instead of it.
 *
 * Pure and separate, because the wording is the feature.
 */

export interface StepExplanation {
  /** The one-line question, in his voice. */
  title: string;
  /** What allowing it does, and what it costs if it was wrong. */
  what: string;
  /** The path or command itself, verbatim. Absent when there is nothing to quote. */
  exact?: string;
}

/**
 * Reversibility, said plainly.
 *
 * Every file this agent touches is snapshotted before the run starts, so an edit is
 * genuinely undoable in one command. A command is not: it can reach the network,
 * install something, or write outside the snapshot. That difference is the single
 * most useful thing to know before answering, so it is in every explanation.
 */
const UNDOABLE = 'Undoable — I snapshot every file before the run.';

const EXPLAIN: Record<ToolName, (args: Args) => StepExplanation> = {
  writeFile: ({ path }) => ({
    title: `Write ${path ?? 'a file'}`,
    what: `Creates ${path ?? 'the file'}, or replaces it completely if it already exists. ${UNDOABLE}`,
    exact: path,
  }),
  applyEdit: ({ path }) => ({
    title: `Edit ${path ?? 'a file'}`,
    what: `Changes part of ${path ?? 'the file'} and leaves the rest as it is. ${UNDOABLE}`,
    exact: path,
  }),
  runCommand: ({ command }) => ({
    title: narrateCommand(command),
    // No undo claim here, and deliberately: the checkpoint covers files, and a
    // command can install something, reach the network, or write to a build cache
    // outside the snapshot. Saying "undoable" about all of it would be the reassuring
    // half of the truth.
    what: 'Runs this in your project folder, confined to it. Files are snapshotted; anything it does outside the project — installing, downloading — is not.',
    exact: command,
  }),
  // Present for completeness, and unreachable in practice: the reading tools never
  // stop to ask. A `Record<ToolName, …>` is what makes the compiler insist a new tool
  // gets a line here, which is the point of the table.
  readFile: ({ path }) => reading(`Read ${path ?? 'a file'}`, path),
  listFiles: ({ directory }) => reading('List the project files', directory),
  search: ({ pattern }) => reading('Search the project', pattern),
  readDiagnostics: () => reading('Read the editor problems'),
  gitStatus: () => reading('Check git status'),
  gitDiff: () => reading('Read the current diff'),
};

function reading(title: string, exact?: string): StepExplanation {
  return { title, what: 'Reads only. Nothing changes.', exact };
}

interface Args {
  path?: string;
  command?: string;
  pattern?: string;
  directory?: string;
}

/** The explanation for one call, or an honest placeholder for a tool with no entry. */
export function explainStep(name: string, args: Record<string, unknown>): StepExplanation {
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const parts: Args = {
    path: text(args.path),
    command: text(args.command),
    pattern: text(args.pattern),
    directory: text(args.directory),
  };

  const explain = EXPLAIN[name as ToolName];
  // A tool the model invented, or one added without a line above. Named rather than
  // dressed up: "I don't know what this does" is the useful thing to say to someone
  // being asked to approve it.
  if (!explain) return { title: name, what: "A step I can't describe — approve it only if it makes sense to you." };

  return explain(parts);
}
