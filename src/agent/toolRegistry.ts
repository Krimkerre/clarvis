/**
 * What the model is allowed to ask for, and how those asks are checked.
 *
 * The registry is **the allow-list**. A tool call naming anything not in here is
 * discarded rather than dispatched — the same boundary rule as `isButlerState()` — so
 * a model, or text injected into one via a pasted error message, cannot invent a
 * capability. Everything the agent can do is in this file, visible in one place.
 *
 * Schemas live here too, in a neutral shape, because Anthropic and OpenAI describe
 * tools differently and duplicating eight definitions per dialect is eight chances to
 * let them drift apart.
 */

export type ToolName =
  | 'readFile'
  | 'listFiles'
  | 'search'
  | 'applyEdit'
  | 'writeFile'
  | 'runCommand'
  | 'readDiagnostics'
  | 'gitStatus'
  | 'gitDiff'
  | 'readSkill';

export interface ToolSchema {
  name: ToolName;
  description: string;
  /** JSON Schema for the arguments. Kept small: every property costs context. */
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  /** True for anything that changes the workspace — drives checkpointing and gating. */
  mutates: boolean;
  /**
   * True for a tool offered only to a run whose instructions list the owner's skills (plan.md §4.6, "Skills"): never to an
   * answer, a background call, or a run with none, where it would be a schema resent with every call for nothing.
   */
  skills?: boolean;
}

export const TOOLS: ToolSchema[] = [
  {
    name: 'readFile',
    description: 'Read a file from the workspace. Paths are relative to the workspace root.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path' } },
      required: ['path'],
    },
    mutates: false,
  },
  {
    name: 'listFiles',
    description: 'List files in the workspace. Skips node_modules, .git and build output.',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory to list, default the root' },
        recursive: { type: 'boolean', description: 'Walk subdirectories' },
      },
      required: [],
    },
    mutates: false,
  },
  {
    name: 'search',
    description: 'Search file contents with a regular expression. Returns file, line and text.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        directory: { type: 'string', description: 'Limit the search to this directory' },
      },
      required: ['pattern'],
    },
    mutates: false,
  },
  {
    name: 'applyEdit',
    description:
      'Replace an exact, unique piece of text in a file. Include enough surrounding lines to make it unique — the edit is refused if the text appears more than once.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path' },
        find: { type: 'string', description: 'Exact text to replace, including indentation' },
        replace: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'find', 'replace'],
    },
    mutates: true,
  },
  {
    name: 'writeFile',
    description: 'Write a whole file, creating it if needed. Use applyEdit for changes to existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path' },
        contents: { type: 'string', description: 'Full file contents' },
      },
      required: ['path', 'contents'],
    },
    mutates: true,
  },
  {
    name: 'runCommand',
    description:
      'Run a shell command in the workspace. Destructive, outward-facing and install commands stop and ask the user first.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The command line to run' } },
      required: ['command'],
    },
    mutates: true,
  },
  {
    name: 'readDiagnostics',
    description: 'Errors and warnings currently reported by the language servers.',
    parameters: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Limit to one file' } },
      required: [],
    },
    mutates: false,
  },
  {
    name: 'gitStatus',
    description: 'Current branch and how many files are staged, unstaged or untracked.',
    parameters: { type: 'object', properties: {}, required: [] },
    mutates: false,
  },
  {
    name: 'gitDiff',
    description: 'The current diff. Set staged to see staged changes instead.',
    parameters: {
      type: 'object',
      properties: { staged: { type: 'boolean', description: 'Show staged changes' } },
      required: [],
    },
    mutates: false,
  },
  {
    name: 'readSkill',
    description:
      'Read a skill the owner switched on, by its id from the skills list in your instructions: its SKILL.md, or a file inside it. Runs in the editor, through Clarvis, not as a command.',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: "The skill's id, as the list gives it" },
        file: { type: 'string', description: "A path inside the skill's folder; SKILL.md when left out" },
      },
      required: ['skill'],
    },
    mutates: false,
    skills: true,
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/**
 * Required arguments where an empty string is a real value, not a missing one.
 *
 * **Found live, 13 September 2026.** `writeFile tests/__init__.py` with empty contents — a
 * Python package marker, empty by design — was refused as `writeFile needs "contents"`,
 * and the run spent a step writing it through the shell instead. Empty file text is a file;
 * an empty replacement deletes what it matched. An empty path, search string or command
 * still means nothing, and is still refused.
 */
const MAY_BE_EMPTY = new Set(['writeFile.contents', 'applyEdit.replace']);

/**
 * Narrows a model-supplied string to a tool we actually have.
 *
 * The trust boundary. A model that hallucinates `deleteEverything` gets nothing back
 * but a refusal, and the refusal is a normal tool result rather than an exception —
 * an agent told "no such tool" recovers, one handed a crash does not.
 */
export function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && BY_NAME.has(value as ToolName);
}

export function toolSchema(name: ToolName): ToolSchema {
  return BY_NAME.get(name)!;
}

/** Whether a call would change the workspace, for checkpointing and step accounting. */
export function mutates(name: ToolName): boolean {
  return BY_NAME.get(name)?.mutates ?? false;
}

/**
 * Checks a model's arguments against the schema before anything runs.
 *
 * Only presence and primitive type — a full JSON Schema validator would be a
 * dependency and a lot of code to catch what the tools already reject themselves.
 * The point is to turn a malformed call into a *message the model can act on* rather
 * than a stack trace from three layers down.
 */
export function validateArgs(name: ToolName, args: unknown): { ok: true } | { ok: false; error: string } {
  const schema = toolSchema(name);

  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { ok: false, error: `${name} needs an object of arguments.` };
  }

  const supplied = args as Record<string, unknown>;

  for (const required of schema.parameters.required) {
    const empty = supplied[required] === '' && !MAY_BE_EMPTY.has(`${name}.${required}`);
    if (supplied[required] === undefined || empty) {
      return { ok: false, error: `${name} needs "${required}".` };
    }
  }

  for (const [key, value] of Object.entries(supplied)) {
    const expected = schema.parameters.properties[key];
    // Unknown keys are ignored rather than rejected: models add stray fields, and
    // failing the call over one would waste a step for nothing.
    if (!expected) continue;

    const actual = typeof value;
    if (expected.type === 'boolean' && actual !== 'boolean') {
      return { ok: false, error: `${name}: "${key}" should be true or false.` };
    }
    if (expected.type === 'string' && actual !== 'string') {
      return { ok: false, error: `${name}: "${key}" should be a string.` };
    }
  }

  return { ok: true };
}

/**
 * The tools a *question* may use.
 *
 * Answering "what does this file do?" needs to read the file — but not a branch, a
 * checkpoint, or a commit. Filtering by `mutates` rather than keeping a second list
 * means a new tool cannot accidentally become available to the answer path by being
 * forgotten: it has to be marked non-mutating to get there.
 */
export function readOnlyTools(): ToolSchema[] {
  // Nor a skills tool: an answer is given no skills list, so it has nothing to read one by (plan.md §4.6, "Skills").
  return TOOLS.filter((tool) => !tool.mutates && !tool.skills);
}

/**
 * The tools a run is offered: all of them, with `readSkill` only when the run's instructions list skills (plan.md §4.6,
 * "Skills"). Without skills it would be a schema resent with every call, naming a list the model was never given.
 */
export function runTools(withSkills: boolean): ToolSchema[] {
  return TOOLS.filter((tool) => withSkills || !tool.skills);
}

/** The registry in Anthropic's shape. A caller that names no tools gets a run's tools, without skills. */
export function anthropicTools(only: ToolSchema[] = runTools(false)): unknown[] {
  return only.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

/** The registry in OpenAI's shape. */
export function openAiTools(only: ToolSchema[] = runTools(false)): unknown[] {
  return only.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}
