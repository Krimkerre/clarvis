/**
 * Turns written text into something that sounds right read aloud.
 *
 * The two are not the same language. `(probe-build-ok, 2s)` is a perfectly good thing
 * to *see* — compact, scannable, the eye skips the punctuation. Spoken, a TTS engine
 * reads the brackets as a pause with no cause and says "two ess", and the whole line
 * lands as a machine reading a log entry rather than a person telling you something.
 *
 * Applied centrally in VoiceService rather than at each call site, so every surface —
 * outcome notices, quips, chat replies, briefings — gets it without having to
 * remember, and so written text stays written text.
 */

/** `2s` → `2 seconds`, `1m` → `1 minute`. Plural handled since "1 seconds" grates. */
function expandUnit(value: string, unit: 'm' | 's'): string {
  const count = Number(value);
  const word = unit === 'm' ? 'minute' : 'second';
  return `${value} ${word}${count === 1 ? '' : 's'}`;
}

export function speakable(text: string): string {
  return (
    text
      // Inline code markers: read as text, never as the word "backtick".
      .replace(/`/g, '')

      // The outcome format — "(probe-build-ok, 2s)". Spoken, this wants to be a
      // sentence: "probe-build-ok took 2 seconds." Read as an aside it lands as a
      // machine appending metadata, which is exactly how it sounded.
      .replace(/\s*\(([^,()]+),\s*([\d.]+m?s?[\dms ]*)\)\s*$/, ' $1 took $2.')
      // Any other brackets: keep the words, drop the punctuation.
      .replace(/\s*\(([^)]*)\)/g, ', $1,')

      // Durations. Longest form first, or "1m 5s" would half-expand.
      .replace(/\b(\d+)m\s+(\d+)s\b/g, (_, m: string, sec: string) =>
        `${expandUnit(m, 'm')} and ${expandUnit(sec, 's')}`
      )
      .replace(/\b(\d+(?:\.\d+)?)s\b/g, (_, value: string) => expandUnit(value, 's'))
      .replace(/\b(\d+)m\b/g, (_, value: string) => expandUnit(value, 'm'))
      .replace(/\b(\d+)ms\b/g, '$1 milliseconds')

      // Tidy up whatever the substitutions left behind.
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,])/g, '$1')
      .replace(/,\s*\./g, '.')
      .trim()
  );
}
