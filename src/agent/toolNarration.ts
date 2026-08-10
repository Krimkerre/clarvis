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
      // The command itself is the interesting part and is short enough to show — a
      // developer reads `npm test` faster than any sentence about it.
      return `Running ${command ?? 'a command'}`;
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
