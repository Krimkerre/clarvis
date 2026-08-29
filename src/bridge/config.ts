/**
 * What Clarvis is configured to do, as a value NERVIS may read (§6.2, §6.3).
 *
 * **Read-only, and additive rather than a hole.** §6.7 forbids NERVIS changing
 * a setting and the Bridge has no write path to extend, so this is the other
 * half of the same rule: a control plane that can *see* the configuration does
 * not need to reach into it. Asked "which model is the agent using", the honest
 * answer today is a trip into the editor to look — which is the whole class of
 * question this closes.
 *
 * **An allowlist of settings, and never the values that matter to an attacker.**
 * §6.4 forbids paths, prompts, source and credentials leaving this machine, and
 * a settings document is where all four are most likely to be sitting:
 *
 * - `clarvis.bridge.enrollmentSecretPath` is a path to a secret. Neither the
 *   path nor the secret travels; whether one is configured does.
 * - `clarvis.chat.baseUrl.custom` is a URL somebody typed. It can carry a token
 *   in a query string and it can name an internal host, so what travels is
 *   *loopback or not* — the fact NERVIS actually wants, without the string.
 * - API keys are in SecretStorage and are not settings at all, which is why
 *   nothing below has to remember to exclude them.
 *
 * Everything published here is a model name, a provider id, a mode, a boolean or
 * a theme id: values whose whole purpose is to be shown to the person who set
 * them. If a future setting does not fit that description, it does not belong in
 * `PUBLISHED` — the list is the security argument, not a convenience.
 */

/** The shape a reader gets: flat, primitive, and nothing else. */
export interface ConfigSummary {
  readonly [key: string]: string | boolean | undefined;
}

/**
 * How one setting becomes one published field.
 *
 * `as` exists for the two settings whose *value* must not travel: it turns a URL
 * into "loopback" and a path into a boolean. A summary that published them
 * verbatim would be one edit away from §6.4, and this keeps that edit from being
 * possible rather than from being noticed.
 */
interface Published {
  readonly setting: string;
  readonly field: string;
  readonly as?: (value: unknown) => string | boolean | undefined;
}

/** Whether a URL points at this machine — the fact, without the address. */
export function locality(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return undefined;
  try {
    const host = new URL(text).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
      ? 'loopback'
      : 'remote';
  } catch {
    // Not a URL. "Configured with something unparseable" is worth saying and is
    // not worth quoting, since the string is exactly what must not travel.
    return 'unreadable';
  }
}

/** Whether a value is set at all, for the settings whose contents may not travel. */
const configured = (value: unknown): boolean =>
  typeof value === 'string' ? value.trim().length > 0 : Boolean(value);

/**
 * The settings that may be published, and how.
 *
 * Written out rather than derived from the manifest for the same reason the
 * capability table is: a list derived from what exists publishes whatever gets
 * added, which is the opposite of an allowlist.
 */
export const PUBLISHED: readonly Published[] = [
  { setting: 'clarvis.chat.provider', field: 'chat.provider' },
  { setting: 'clarvis.chat.model', field: 'chat.model' },
  { setting: 'clarvis.chat.mode', field: 'chat.mode' },
  { setting: 'clarvis.chat.baseUrl.custom', field: 'chat.endpoint', as: locality },
  { setting: 'clarvis.agent.provider', field: 'agent.provider' },
  { setting: 'clarvis.agent.model', field: 'agent.model' },
  { setting: 'clarvis.voice.enabled', field: 'voice.enabled' },
  { setting: 'clarvis.voice.selectedVoice', field: 'voice.selected' },
  { setting: 'clarvis.bridge.enabled', field: 'bridge.enabled' },
  { setting: 'clarvis.bridge.nervisUrl', field: 'bridge.nervis', as: locality },
  {
    setting: 'clarvis.bridge.enrollmentSecretPath',
    field: 'bridge.enrolment_configured',
    as: configured,
  },
  { setting: 'workbench.colorTheme', field: 'theme' },
];

/**
 * Which setting each published field came from.
 *
 * **So the answer to "how do I change it" is exact.** A reader that knows
 * `chat.model` is `ravis/clarvis-chat` still cannot tell somebody where to
 * change it, and a control plane forbidden from changing a setting (§6.7) owes
 * them the next best thing: the id to search for in the editor's own settings
 * UI. Derived from the same table, so the two can never disagree — and it
 * carries no information the field names did not already imply.
 */
export function settingIds(): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const { setting, field } of PUBLISHED) ids[field] = setting;
  return ids;
}

/** How long a published string may be. A model id is short; a mistake is not. */
export const MAX_VALUE_CHARS = 120;

/**
 * The summary, from whatever can read settings.
 *
 * Takes a reader rather than `vscode` so the fast suite can drive it: the same
 * split every other module here uses, and the reason this file has no imports.
 *
 * A *string* setting nobody has set is absent rather than empty. §6.3's rule
 * about unknown values applies to configuration too — "" and "not set" are
 * different facts, and only one of them is true of a fresh install.
 *
 * A *derived boolean* is always present, because it answers a question rather
 * than reporting a value: "no enrolment secret is configured" is a fact about
 * this install and an absence would leave a reader unable to tell it from a
 * field nobody thought to publish.
 */
export function summarise(read: (setting: string) => unknown): ConfigSummary {
  const summary: Record<string, string | boolean> = {};
  for (const { setting, field, as } of PUBLISHED) {
    const raw = read(setting);
    const value = as ? as(raw) : raw;
    if (typeof value === 'boolean') {
      summary[field] = value;
      continue;
    }
    if (typeof value === 'string' && value.trim()) {
      summary[field] = value.trim().slice(0, MAX_VALUE_CHARS);
    }
  }
  return summary;
}
