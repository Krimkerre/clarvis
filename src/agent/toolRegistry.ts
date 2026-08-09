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
  | 'gitDiff';

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
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

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
    if (supplied[required] === undefined || supplied[required] === '') {
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

/** The registry in Anthropic's shape. */
export function anthropicTools(): unknown[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

/** The registry in OpenAI's shape. */
export function openAiTools(): unknown[] {
  return TOOLS.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}
