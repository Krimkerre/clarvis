/**
 * What the project folder holds and what its plan says it is built with, for the facts
 * an answer is given.
 *
 * **Because an answer with nothing to go on invents.** Found live, 11 September 2026: asked
 * why the project would use Go, chat said "the src/main.go file says otherwise" — about a
 * project whose only source file was src/main.py, in Python as the plan said. It had been
 * told the top-level entries only (`plan.md`, `src/`), so what was inside `src/` was a
 * guess. Two levels of the folder, and the plan's own language line, make both questions
 * answerable from fact.
 *
 * Pure: the directory is read through the function handed in, so tests need no disk.
 */

export interface Entry {
  name: string;
  isDirectory: boolean;
}

/** Folders whose contents are generated or installed, never the project's own work. */
const SKIPPED = new Set(['node_modules', 'venv', '.venv', '__pycache__', 'dist', 'out', 'build', 'target']);

/** The project's files and folders, two levels deep, hidden ones left out, capped. */
export function projectEntries(read: (relative: string) => Entry[], limit = 60): string[] {
  const found: string[] = [];

  const visit = (relative: string, depth: number): void => {
    let entries: Entry[];
    try {
      entries = [...read(relative)].sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || found.length >= limit) continue;
      const shown = relative ? `${relative}/${entry.name}` : entry.name;
      found.push(entry.isDirectory ? `${shown}/` : shown);
      if (entry.isDirectory && depth < 2 && !SKIPPED.has(entry.name)) visit(shown, depth + 1);
    }
  };

  visit('', 1);
  return found;
}

/**
 * What the plan says the project is built with, from its Language section.
 *
 * The interview records the answer as the first bold line under the heading that is not
 * the question: `**Python with tkinter** — …` reads as "Python with tkinter".
 */
export function plannedStack(plan: string): string | undefined {
  const lines = plan.split('\n');
  const start = lines.findIndex((line) => /^##\s+(?:\d+\.\s+)?Language\b/i.test(line));
  if (start === -1) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) return undefined;
    const answer = /^\*\*(?!Asked:)(.+?)\*\*/.exec(line.trim());
    if (answer) return answer[1].trim();
  }
  return undefined;
}
