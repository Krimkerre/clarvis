/**
 * Clarvis's voice, chosen in NERVIS (19 September 2026, owner's decision).
 *
 * The owner keeps one voice list and one Fish Audio key in NERVIS, and gave Clarvis a voice of
 * its own there ("I don't want them to sound identical"). Clarvis *asks* — NERVIS never writes a
 * Clarvis setting (CLARVIS.md §6.7) and its key never comes here. Both calls use the window's own
 * NERVIS-issued token, through routes NERVIS keeps for registered windows.
 *
 * `vscode`-free, with `fetch` handed in, so every answer below is tested without a host.
 */

/** A registered window's way to NERVIS: its address, this window's id, and NERVIS's token. */
export interface NervisLink {
  readonly url: string;
  readonly instanceId: string;
  readonly token: string;
}

/** The voice NERVIS keeps for Clarvis. */
export interface NervisProfile {
  readonly voice_id: string;
  readonly engine: string;
  readonly name?: string;
}

/**
 * What a render through NERVIS came to, and so what Clarvis does next:
 * - `audio`: play it; NERVIS counted it against its own cap, so Clarvis's isn't touched.
 * - `ownVoice`: NERVIS can't do this one (no key, no voice for Clarvis, not reachable, not
 *   registered) — Clarvis's own key may try.
 * - `systemVoice`: NERVIS refused on privacy or its daily cap, or the call timed out after NERVIS
 *   may already have paid — falling back to Clarvis's own key would get round the refusal or pay
 *   twice, so the plain voice says it.
 */
export type NervisRender =
  | { kind: 'audio'; bytes: Uint8Array }
  | { kind: 'ownVoice'; why: string }
  | { kind: 'systemVoice'; why: string };

/** NERVIS's refusals that must not be retried with Clarvis's own key. */
const FINAL_REFUSALS = new Set(['local_only', 'daily_cap', 'muted', 'nothing_to_say']);

const ASK_TIMEOUT_MS = 2000;

function base(link: NervisLink): string {
  return `${link.url.replace(/\/+$/, '')}/api/v1/registry/instances/clarvis/${encodeURIComponent(link.instanceId)}`;
}

/** Clarvis's voice in NERVIS, or `undefined` when NERVIS can't be asked or has none that speaks. */
export async function nervisProfile(
  link: NervisLink,
  fetchImpl: typeof fetch = fetch
): Promise<NervisProfile | undefined> {
  try {
    const answered = await fetchImpl(`${base(link)}/voice`, {
      headers: { Authorization: `Bearer ${link.token}` },
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
    if (!answered.ok) return undefined;
    const body = (await answered.json()) as { profile?: NervisProfile | null; can_speak?: boolean };
    const profile = body.profile;
    if (!body.can_speak || !profile || typeof profile.voice_id !== 'string' || typeof profile.engine !== 'string') {
      return undefined;
    }
    return profile;
  } catch {
    return undefined;
  }
}

/** One line in Clarvis's voice, rendered by NERVIS; see `NervisRender` for what each outcome means. */
export async function renderThroughNervis(
  link: NervisLink,
  text: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<NervisRender> {
  let answered: Response;
  try {
    answered = await fetchImpl(`${base(link)}/speak`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${link.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch {
    // Aborted by the render deadline: NERVIS may have rendered and paid, so no second try.
    if (signal.aborted) return { kind: 'systemVoice', why: 'NERVIS took too long' };
    return { kind: 'ownVoice', why: 'NERVIS is not reachable' };
  }
  if (answered.ok) return { kind: 'audio', bytes: new Uint8Array(await answered.arrayBuffer()) };
  if (answered.status === 401 || answered.status === 404) {
    return { kind: 'ownVoice', why: 'this window is not registered with NERVIS right now' };
  }
  const refusal = (await answered.json().catch(() => ({}))) as { reason?: string; detail?: string };
  const why = refusal.detail ?? `NERVIS answered ${answered.status}`;
  return FINAL_REFUSALS.has(refusal.reason ?? '') ? { kind: 'systemVoice', why } : { kind: 'ownVoice', why };
}
