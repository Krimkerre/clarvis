import { execFile } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Loading LM Studio's models the way Clarvis actually uses them.
 *
 * **This replaces a load that was going to happen anyway.** LM Studio just-in-time
 * loads any model a request names, using its own defaults — which reserve room for
 * four concurrent answers when Clarvis asks for exactly one. Doing that load
 * explicitly with `--parallel 1` is the same event with better parameters, not a new
 * action on the user's machine.
 *
 * **What it deliberately does not do**, because the line between the two matters:
 *
 * - **Never touches a model that is already loaded.** If the user loaded it
 *   themselves, their settings win — reloading it to "optimise" would be Clarvis
 *   changing something nobody asked him to change (§9.9), and would interrupt
 *   whatever else is using it.
 * - **Never writes LM Studio's `settings.json`.** That file belongs to another
 *   application and sits outside the workspace; settings there are the user's to
 *   change, and the manual explains the ones worth touching. See F28.
 *
 * - **Never unloads anything.**
 *
 * **Why warm at startup rather than on first use:** a cold just-in-time load was
 * measured at **5.3s**, against `Voice.open`'s 5s deadline — so the first thing said
 * in a session falls back to a written line for no better reason than the model not
 * being resident yet. That is a warm-up problem. (It is *not* an eviction problem:
 * LM Studio holds several models at once, tested directly — an earlier version of
 * this comment claimed otherwise on the strength of a setting's name.)
 *
 * **Only `--parallel`, and only because it was verified.** `--context-length` is
 * silently ignored on MLX models (`autoFit` appears to win) and speculative decoding
 * exists only under `llm.load.llama.*`, so neither is passed. Sending a flag that
 * does nothing would make Clarvis the fourth thing in this stack to quietly ignore
 * its own options.
 */

/** How long the CLI gets. A load is slower than a probe, and blocks nothing. */
const LOAD_TIMEOUT_MS = 120_000;

/** Finding the binary is quick or not happening. */
const PROBE_TIMEOUT_MS = 3000;

/** One answer at a time is what Clarvis asks for; the default reserves room for four. */
const PARALLEL = '1';

interface ModelRecord {
  id: string;
  state: string;
}

/**
 * The models this server knows, and whether each is resident.
 *
 * `/api/v0/models` is LM Studio's own endpoint on the port Clarvis already uses. It
 * reports far more than the OpenAI-compatible `/v1/models` does — `state`,
 * `max_context_length`, `quantization`, and a `capabilities` array (see F27).
 * Anything malformed reads as "no information", never as an error: this whole path
 * is an optimisation, and an optimisation must never be the reason a reply fails.
 */
export function parseModelStates(body: unknown): ModelRecord[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  return data.flatMap((entry) => {
    const record = entry as { id?: unknown; state?: unknown };
    return typeof record.id === 'string' && typeof record.state === 'string'
      ? [{ id: record.id, state: record.state }]
      : [];
  });
}

/**
 * Which of the models we want are not resident yet.
 *
 * **Deduplicated**, because chat and agent are frequently the same model and loading
 * it twice would be a second load rather than a faster one. A model the server has
 * never heard of is skipped: it may be a name the user typed, and asking the CLI to
 * load something that does not exist produces an error nobody can act on.
 */
export function needsLoading(states: ModelRecord[], wanted: readonly string[]): string[] {
  const byId = new Map(states.map((record) => [record.id, record.state]));
  const seen = new Set<string>();

  return wanted.filter((id) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return byId.get(id) === 'not-loaded';
  });
}

/**
 * Where the `lms` CLI is, if it is anywhere.
 *
 * **Not simply `lms`.** It installs to `~/.lmstudio/bin`, which a shell rc adds to
 * `PATH` — so it works in a terminal and is absent from a VS Code launched from
 * Finder, which is how most people launch it. Checked in both places, cached like
 * `hasGitBinary` for the same reason: it does not get installed mid-session.
 */
let binary: string | undefined | null = null;

export async function findLmsBinary(): Promise<string | undefined> {
  if (binary !== null) return binary;

  for (const candidate of ['lms', join(homedir(), '.lmstudio', 'bin', 'lms')]) {
    const works = await new Promise<boolean>((resolve) => {
      execFile(candidate, ['version'], { timeout: PROBE_TIMEOUT_MS }, (error) => resolve(!error));
    });
    if (works) {
      binary = candidate;
      return binary;
    }
  }

  binary = undefined;
  return binary;
}

/** Only for tests — the cache is a session-long fact everywhere else. */
export function forgetLmsBinary(): void {
  binary = null;
}

/**
 * Loads the named models with the parameters Clarvis actually wants.
 *
 * Never throws, never blocks anything that matters: every failure path leaves LM
 * Studio to just-in-time load exactly as it does today, which is the behaviour this
 * improves on rather than replaces.
 */
export async function tuneLoads(
  baseUrl: string,
  wanted: readonly string[],
  log: (message: string) => void
): Promise<void> {
  const pending = await notResident(baseUrl, wanted, log);
  if (pending.length === 0) return;

  const lms = await findLmsBinary();
  if (!lms) {
    // Said once, and only in the log: there is nothing for the user to do about it
    // mid-session, and LM Studio will load these itself a moment later regardless.
    log('model: lms CLI not found, leaving LM Studio to load these its own way');
    return;
  }

  for (const id of pending) {
    await new Promise<void>((resolve) => {
      execFile(lms, ['load', id, '-y', '--parallel', PARALLEL], { timeout: LOAD_TIMEOUT_MS }, (error) => {
        log(
          error
            ? `model: could not pre-load ${id} (${error.message.split('\n')[0]}) — LM Studio will load it on demand`
            : `model: pre-loaded ${id} with parallel=${PARALLEL}`
        );
        resolve();
      });
    });
  }
}

/** The models we want that the server says are not loaded. Empty on any doubt. */
async function notResident(
  baseUrl: string,
  wanted: readonly string[],
  log: (message: string) => void
): Promise<string[]> {
  if (wanted.every((id) => !id)) return [];

  try {
    const response = await fetch(`${baseUrl}/api/v0/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!response.ok) return [];
    return needsLoading(parseModelStates(await response.json()), wanted);
  } catch (error) {
    // A server that is not answering is F13's territory, and it is reported there
    // rather than here — this path stays quiet and simply does nothing.
    log(`model: could not read LM Studio's model states (${String(error)})`);
    return [];
  }
}
