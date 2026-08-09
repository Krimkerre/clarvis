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
 *
 * **Markdown is the main offender**, now that replies come from a model. Left alone, a
 * TTS engine reads `**not**` as "asterisk asterisk not asterisk asterisk", and a
 * bulleted list as a stream of "dash". Markers are therefore removed — but emphasis is
 * *replaced by a pause* rather than simply dropped, because the author meant a beat
 * there and silence carries emphasis better than a spoken symbol ever could.
 */

/**
 * A pause, written as punctuation.
 *
 * Commas rather than SSML or ellipses: every engine honours a comma, `…` gets read
 * aloud as "dot dot dot" by some voices, and SSML would tie this to one provider.
 */
const BEAT = ', ';

/**
 * Emphasis short enough to be worth pausing around.
 *
 * "**not**" earns a beat either side. A whole emphasised sentence does not — commas
 * around a long clause just make the delivery stutter, so those are unwrapped silently.
 */
const SHORT_EMPHASIS_WORDS = 3;

function emphasis(inner: string): string {
  const words = inner.trim().split(/\s+/).length;
  return words <= SHORT_EMPHASIS_WORDS ? `${BEAT}${inner}${BEAT}` : inner;
}

/** `2s` → `2 seconds`, `1m` → `1 minute`. Plural handled since "1 seconds" grates. */
function expandUnit(value: string, unit: 'm' | 's'): string {
  const count = Number(value);
  const word = unit === 'm' ? 'minute' : 'second';
  return `${value} ${word}${count === 1 ? '' : 's'}`;
}

export function speakable(text: string): string {
  return (
    text
      // Fenced code blocks are unspeakable — a screenful of punctuation read aloud.
      // Dropped entirely; the transcript still shows them, and voice is a supplement
      // to the text, never the only copy.
      .replace(/```[\s\S]*?```/g, BEAT)

      // Inline code markers: read as text, never as the word "backtick".
      .replace(/`/g, '')

      // Links: say the words, never the URL. "https colon slash slash" is the single
      // worst thing a TTS engine can do to a sentence.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

      // Headings: the text, then a beat, since a heading is a spoken pause anyway.
      .replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, `$1${BEAT}`)

      // Horizontal rules say nothing at all.
      .replace(/^\s*([-*_]\s*){3,}$/gm, '')

      // Bullets become a beat between items instead of a spoken "dash" or "asterisk".
      .replace(/^\s*[-*+]\s+/gm, BEAT)

      // Blockquote markers are punctuation for the eye only.
      .replace(/^\s*>\s?/gm, '')

      // Emphasis: strongest markers first, or the inner ones eat the outer pair.
      .replace(/\*\*\*([^*]+)\*\*\*/g, (_, inner: string) => emphasis(inner))
      .replace(/\*\*([^*]+)\*\*/g, (_, inner: string) => emphasis(inner))
      .replace(/(?<![A-Za-z0-9])\*([^*\n]+)\*(?![A-Za-z0-9])/g, (_, inner: string) => emphasis(inner))
      .replace(/(?<![A-Za-z0-9])__([^_\n]+)__(?![A-Za-z0-9])/g, (_, inner: string) => emphasis(inner))
      .replace(/(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g, (_, inner: string) => emphasis(inner))

      // Table pipes are layout, not speech.
      .replace(/\|/g, BEAT)

      // Any asterisk still standing was never valid markup — a lone bullet, a stray
      // footnote marker. Silence beats "asterisk".
      .replace(/\*/g, '')

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

      // Tidy up whatever the substitutions left behind. Order matters: collapse
      // repeated beats before trimming stray punctuation, or ", , ," survives as ",".
      .replace(/(,\s*){2,}/g, ', ')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,!?])/g, '$1')
      .replace(/,\s*([.!?])/g, '$1')
      .replace(/^[\s,.]+/, '')
      .trim()
  );
}
