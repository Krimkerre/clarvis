import * as path from 'path';
import * as fs from 'fs/promises';
import { resolveInWorkspace } from './workspacePaths';

/**
 * Reading and searching the workspace.
 *
 * Plain functions over `fs`, taking the workspace root as an argument rather than
 * reaching for `vscode.workspace` — which is what lets every one of them be tested
 * against a real temp directory with no extension host (§M8c).
 */

/** Above this, a file is almost certainly not something to reason about as text. */
export const MAX_READ_BYTES = 512 * 1024;

/** How many matches a search returns before it stops. */
export const MAX_SEARCH_RESULTS = 200;

/** Directories never worth walking into, and expensive to walk. */
const ALWAYS_SKIP = new Set(['.git', 'node_modules', 'dist', 'out', '.next', 'build', '.venv', '__pycache__']);

export interface ReadResult {
  text: string;
  /** True when the file was longer than the cap and has been cut. */
  truncated: boolean;
  bytes: number;
}

/**
 * Reads a file, refusing anything outside the workspace.
 *
 * Truncates rather than refusing a large file: a 4MB log still has a useful first
 * 512KB, and "too big, no" is a worse answer than "here is the start of it". The cut
 * is *reported*, so a model is never quietly reasoning about a fragment it thinks is
 * whole — which is how confident wrong answers get made.
 */
export async function readFile(root: string | undefined, requested: string): Promise<ReadResult> {
  const target = await resolveInWorkspace(root, requested);
  const stat = await fs.stat(target);

  if (stat.isDirectory()) {
    throw new Error(`\`${requested}\` is a directory. Use listFiles for that.`);
  }

  const handle = await fs.open(target, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
    await handle.read(buffer, 0, buffer.length, 0);

    return {
      text: buffer.toString('utf8'),
      truncated: stat.size > MAX_READ_BYTES,
      bytes: stat.size,
    };
  } finally {
    await handle.close();
  }
}

export interface ListOptions {
  /** Directory to list, relative to the root. Defaults to the root itself. */
  directory?: string;
  /** Walk into subdirectories. */
  recursive?: boolean;
  /** Stop after this many entries, so a huge tree can't flood a model's context. */
  limit?: number;
}

/**
 * Lists files, skipping the directories nobody means.
 *
 * `node_modules` and `.git` are excluded structurally rather than by a gitignore
 * parse: they are never the answer, they are enormous, and walking them turns a
 * one-second listing into a thirty-second one. Proper `.gitignore` handling belongs
 * with the search tool, where the user's own rules actually matter.
 */
export async function listFiles(
  root: string | undefined,
  options: ListOptions = {}
): Promise<string[]> {
  const start = await resolveInWorkspace(root, options.directory ?? '.');
  const limit = options.limit ?? 1000;
  const found: string[] = [];

  async function walk(directory: string): Promise<void> {
    if (found.length >= limit) return;

    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= limit) return;
      if (ALWAYS_SKIP.has(entry.name)) continue;

      const full = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (options.recursive) await walk(full);
        continue;
      }

      // Relative to the workspace, because absolute paths in a model's context are
      // noise that also leaks the user's home directory name.
      found.push(path.relative(root!, full));
    }
  }

  await walk(start);
  return found;
}

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export interface SearchOptions {
  directory?: string;
  /** Only look at files whose name ends with one of these. */
  extensions?: string[];
  limit?: number;
}

/**
 * Searches file contents for a pattern.
 *
 * Line-oriented and capped, because the output goes into a model's context window: a
 * search matching ten thousand lines is not more useful than one returning two
 * hundred, it is just more expensive. The cap is reported by the caller so a truncated
 * search is never mistaken for an exhaustive one.
 *
 * Binary files are skipped by a NUL-byte check rather than by extension — the
 * extension list is a convenience filter, not a safety one, and minified assets
 * without a recognised suffix are exactly what floods a search.
 */
export async function search(
  root: string | undefined,
  pattern: RegExp,
  options: SearchOptions = {}
): Promise<SearchHit[]> {
  const files = await listFiles(root, {
    directory: options.directory,
    recursive: true,
    limit: 5000,
  });

  const limit = options.limit ?? MAX_SEARCH_RESULTS;
  const hits: SearchHit[] = [];

  for (const file of files) {
    if (hits.length >= limit) break;
    if (options.extensions && !options.extensions.some((ext) => file.endsWith(ext))) continue;

    const target = path.join(root!, file);

    let content: string;
    try {
      const stat = await fs.stat(target);
      if (stat.size > MAX_READ_BYTES) continue;
      content = await fs.readFile(target, 'utf8');
    } catch {
      // Vanished mid-walk, unreadable, or a broken symlink. One unreadable file is
      // not a reason to fail a search across a thousand others.
      continue;
    }

    if (content.includes('\0')) continue; // binary

    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (hits.length >= limit) break;

      // Reset per line: a global regex carries lastIndex between calls and would skip
      // matches in a way that looks like the search being flaky.
      pattern.lastIndex = 0;
      if (pattern.test(lines[index])) {
        hits.push({ file, line: index + 1, text: lines[index].trim().slice(0, 300) });
      }
    }
  }

  return hits;
}
