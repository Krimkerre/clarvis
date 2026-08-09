/**
 * Voices the user has pasted in and named, so a good find survives the session.
 *
 * Stored in settings rather than extension state on purpose: a plain
 * `{ "name": "<reference_id>" }` map is readable, hand-editable, and syncs with the
 * user's other settings. Deleting one is editing a line of JSON, which is why there's
 * no delete affordance in the picker.
 */
export interface SavedVoice {
  name: string;
  id: string;
}

/**
 * Reads the settings value into a list, discarding anything malformed.
 *
 * The setting is hand-editable, so it will eventually contain a number, a null, or a
 * stray nested object. One bad entry must not take the whole picker down with it.
 */
export function readSavedVoices(raw: unknown): SavedVoice[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

  return Object.entries(raw as Record<string, unknown>)
    .filter(([name, id]) => name.trim().length > 0 && typeof id === 'string' && id.trim().length > 0)
    .map(([name, id]) => ({ name: name.trim(), id: (id as string).trim() }));
}

/**
 * Adds a voice to the map, or renames one already saved under a different name.
 *
 * Saving the same id twice under two names would show it twice in the picker with no
 * way to tell which is which, so the id is the identity and the name is a label for
 * it. Re-saving a known id moves it to the new name rather than duplicating it.
 */
export function withSavedVoice(
  existing: SavedVoice[],
  name: string,
  id: string
): Record<string, string> {
  const map: Record<string, string> = {};

  for (const voice of existing) {
    if (voice.id !== id) map[voice.name] = voice.id;
  }

  map[name.trim()] = id.trim();
  return map;
}
