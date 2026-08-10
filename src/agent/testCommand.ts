import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Working out how this project runs its tests.
 *
 * Offering to check the work is only useful if Clarvis can find the command without
 * asking — "what's your test command?" straight after a change is a question the user
 * came here to avoid. So: read what the project already declares, and stay quiet when
 * it declares nothing.
 *
 * Deliberately conservative. A wrong guess runs something unexpected right after an
 * edit, which is precisely when someone is least able to tell what went wrong.
 */

/** The signals, most trustworthy first. */
const FALLBACKS: { file: string; command: string }[] = [
  { file: 'Cargo.toml', command: 'cargo test' },
  { file: 'go.mod', command: 'go test ./...' },
  { file: 'pytest.ini', command: 'pytest' },
  { file: 'tox.ini', command: 'pytest' },
  { file: 'Gemfile', command: 'bundle exec rspec' },
];

export async function detectTestCommand(root: string | undefined): Promise<string | undefined> {
  if (!root) return undefined;

  // A declared npm script wins: it is the project saying so itself, rather than a
  // guess from the presence of a file.
  const declared = await npmTestScript(root);
  if (declared) return declared;

  for (const fallback of FALLBACKS) {
    if (await exists(path.join(root, fallback.file))) return fallback.command;
  }

  return undefined;
}

/**
 * `npm test`, unless the script is the placeholder npm creates.
 *
 * `npm init` writes a test script that prints "no test specified" and exits 1 — running
 * it would report a failure that means nothing, immediately after an edit, which is
 * the worst possible moment to be told something is broken when it isn't.
 */
async function npmTestScript(root: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
    const manifest = JSON.parse(raw) as { scripts?: Record<string, string> };
    const script = manifest.scripts?.test;

    if (!script) return undefined;
    if (/no test specified/i.test(script)) return undefined;

    return 'npm test';
  } catch {
    return undefined;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
