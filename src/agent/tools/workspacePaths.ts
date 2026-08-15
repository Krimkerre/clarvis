import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * The boundary every tool goes through.
 *
 * This is the file where the safety guarantee actually lives (§4.6): *nothing outside
 * the workspace*. Everything else — gates, approvals, branch isolation — sits on top
 * of it, so it is written as plain functions and tested directly rather than through
 * a model, which would be testing the model.
 *
 * Two layers on purpose:
 *  - `isInside()` is **pure**, so the containment rule can be tested exhaustively
 *    against strings, including the cases nobody can conveniently create on disk.
 *  - `resolveInWorkspace()` adds the filesystem truth — symlinks — because a path can
 *    be textually innocent and still point somewhere else entirely.
 */

/** Refusal reasons, kept distinct so the caller can explain rather than just deny. */
export type PathRefusal = 'outside-workspace' | 'no-workspace' | 'unreadable';

export class PathRefused extends Error {
  constructor(
    readonly reason: PathRefusal,
    readonly requested: string,
    message: string
  ) {
    super(message);
    this.name = 'PathRefused';
  }
}

/**
 * Whether `candidate` sits inside `root`, as a pure question about two resolved paths.
 *
 * Deliberately strict about the boundary character: `/work` must not contain
 * `/workspace-secrets`, which a naive `startsWith` gets wrong — and that is the classic
 * way a containment check leaks a sibling directory.
 *
 * Case handling follows the platform, because it must match what the *filesystem*
 * does. On macOS and Windows a case-different path is the same file, so comparing
 * case-sensitively there would refuse legitimate paths; on Linux it is a different
 * file, and folding case would accept one that should be refused.
 */
export function isInside(root: string, candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = platform === 'win32' || platform === 'darwin';
  const normalise = (value: string) => {
    const resolved = path.resolve(value);
    return fold ? resolved.toLowerCase() : resolved;
  };

  const normalisedRoot = normalise(root);
  const normalisedCandidate = normalise(candidate);

  if (normalisedCandidate === normalisedRoot) return true;

  // The separator is what stops /work matching /workspace-secrets.
  return normalisedCandidate.startsWith(normalisedRoot + path.sep);
}

/**
 * Strips quotes a model wrapped around a path argument.
 *
 * Found live: `listFiles` was called with `"."` — quotes included — and the path
 * resolved to `<workspace>/"."`, which does not exist. The model is writing what it
 * would type in a shell, where the quotes are the shell's to remove; here nothing
 * removes them, and the run loses a step to an ENOENT on a directory that is plainly
 * there.
 *
 * Only a wholly-wrapped path with no inner quote is unwrapped, so a file genuinely
 * named `we"ird` still resolves to itself.
 */
export function unquote(requested: string): string {
  const trimmed = requested.trim();
  const quote = trimmed[0];

  if ((quote !== '"' && quote !== "'") || trimmed.length < 2 || !trimmed.endsWith(quote)) return requested;

  const inner = trimmed.slice(1, -1);
  return inner.includes(quote) ? requested : inner;
}

/**
 * Undoes a path that repeats the workspace folder's own name.
 *
 * Found live, on the first checklist project: the workspace was `1-photo-renamer`, and
 * the model asked for `1-photo-renamer/plan.md`. Resolved from the root that becomes
 * `.../1-photo-renamer/1-photo-renamer/plan.md`, which does not exist. It cost three
 * tool calls across two turns, and the run ended mid-milestone having read nothing.
 *
 * The mistake is structural rather than careless. Absolute paths appear in command
 * output, in `pwd`, and — worst — in the ENOENT message from the previous attempt, so
 * everything the model can see about where it is includes the folder name that must
 * not be repeated.
 *
 * **Only ever when the evidence is unambiguous**: the doubled path must not exist and
 * the shortened one must. A project whose root and package share a name — `mytool`
 * containing `mytool/` — is entirely normal, and there the doubled path *does* exist,
 * so nothing is stripped. Creating a genuinely new `mytool/cli.py` matches neither
 * condition, so a write to a new nested folder still means exactly what it says.
 */
async function undoubled(root: string, requested: string): Promise<string> {
  const first = requested.split(/[\\/]/)[0];
  if (!first || first !== path.basename(root)) return requested;

  const rest = requested.slice(first.length).replace(/^[\\/]+/, '');
  if (!rest) return requested;

  if (await exists(path.resolve(root, requested))) return requested;
  return (await exists(path.resolve(root, rest))) ? rest : requested;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a tool's path argument against the workspace, refusing anything outside it.
 *
 * The order matters and is the whole point:
 *  1. Resolve textually, so `../../etc/passwd` is caught before it touches disk.
 *  2. Resolve symlinks, so a *link* inside the workspace pointing outside is caught
 *     too. A textual check alone passes `notes -> /Users/you/.ssh` without blinking.
 *  3. Re-check containment on the real path.
 *
 * For a path that does not exist yet — creating a file is legitimate — the **nearest
 * existing ancestor** is realpathed instead. Otherwise every new file would be refused,
 * and a symlinked parent directory would still be caught, which is the case that
 * matters.
 */
export async function resolveInWorkspace(root: string | undefined, requested: string): Promise<string> {
  if (!root) {
    throw new PathRefused(
      'no-workspace',
      requested,
      'There is no folder open, so there is nothing I am allowed to touch.'
    );
  }

  // An absolute path is allowed, but only if it lands inside; a relative one is
  // resolved from the workspace root rather than from the extension host's cwd, which
  // is somewhere nobody intended.
  const textual = path.resolve(root, await undoubled(root, unquote(requested)));

  if (!isInside(root, textual)) {
    throw new PathRefused('outside-workspace', requested, outsideMessage(requested));
  }

  const realRoot = await realpathOrSelf(root);
  const realTarget = await realpathOfNearestExisting(textual);

  if (!isInside(realRoot, realTarget)) {
    // Reached only via a symlink, so the message says so — otherwise the refusal looks
    // arbitrary to someone staring at a path that is plainly inside the project.
    throw new PathRefused(
      'outside-workspace',
      requested,
      `\`${requested}\` is a link that leads outside the workspace. I don't follow those.`
    );
  }

  return textual;
}

function outsideMessage(requested: string): string {
  return `\`${requested}\` is outside the workspace. I don't reach past it — not for reading, not for anything.`;
}

/** realpath, or the path itself when it cannot be resolved (permissions, races). */
async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The real path of `target`, or of the closest ancestor that exists.
 *
 * Creating a new file must stay possible, so a missing leaf is not a refusal — but the
 * directory it would be created in still gets checked, which is where a symlink would
 * actually be.
 */
async function realpathOfNearestExisting(target: string): Promise<string> {
  let current = path.resolve(target);
  const missing: string[] = [];

  for (;;) {
    try {
      const real = await fs.realpath(current);
      // Re-attach whatever did not exist yet, so the answer describes the full path.
      return missing.length > 0 ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return path.resolve(target);

      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The workspace-relative path **as the filesystem spells it**.
 *
 * macOS and Windows match paths case-insensitively, so a model asking for `readme.md`
 * successfully edits `README.md` — and then every downstream consumer carries the
 * wrong spelling. Git is case-*sensitive*, so `git add readme.md` fails with a message
 * about a path that plainly exists, which is exactly how an agent run ends with its
 * work uncommitted and no obvious reason.
 *
 * Falls back to the requested spelling for a file that does not exist yet, which is
 * correct: nothing on disk contradicts it.
 */
export async function canonicalRelative(root: string, absolute: string): Promise<string> {
  try {
    return path.relative(await fs.realpath(root), await fs.realpath(absolute));
  } catch {
    return path.relative(root, absolute);
  }
}
