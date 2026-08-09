/**
 * The shipped voices, described by how they sound and named after nobody (§4.4).
 *
 * The character traits in §2 are an archetype anyone may use; a voice marketed as
 * sounding like a specific copyrighted character is a different thing, and not
 * something this project distributes. So these entries describe *qualities* — and the
 * picker's paste-an-ID row exists precisely so anyone who wants a different voice can
 * point Clarvis at one themselves.
 */
export interface CuratedVoice {
  id: string;
  label: string;
  detail: string;
}

export const CURATED_VOICES: CuratedVoice[] = [
  {
    id: '14129c3e320149449d6bada6862f7338',
    label: 'The default butler',
    detail: 'Gravelly, impatient, audibly bored of having to explain. Matches the writing.',
  },
];

/** The voice used when nothing else has been chosen. */
export const DEFAULT_CURATED_ID = CURATED_VOICES[0].id;

/**
 * Turns a `selectedVoice` setting into a Fish Audio voice id.
 *
 * Three forms exist and all three have to resolve here, or the setting silently means
 * something different depending on who reads it:
 *   `fish:<id>`        — an explicit voice
 *   `curated:default`  — the shipped default, resolved to a real id
 *   `system`           — no Fish voice at all
 */
export function resolveVoiceId(setting: string): string | undefined {
  if (setting.startsWith('fish:')) return setting.slice('fish:'.length);
  if (setting.startsWith('curated:')) return DEFAULT_CURATED_ID;
  return undefined; // 'system', or anything unrecognised
}
