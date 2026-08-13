import { ButlerState, isButlerState } from '../butlerState';

/**
 * Lets a reply carry the face it should be read with.
 *
 * §4.6 wants the tone of an answer on the avatar — mild contempt at a global variable,
 * alarm at "I force-pushed to main" — and only the model knows the tone of what it is
 * about to say. So it declares one, as a tag at the very start of the reply.
 *
 * **The tag must never be seen.** The plan calls it structured metadata for that reason,
 * and a tag arriving as text is a tag that can leak. Two things prevent it: the reader
 * below withholds the opening fragments until it knows whether one is there, and a
 * sweep strips any that turn up later regardless. Both, because streaming splits text at
 * arbitrary points and `[[jud` / `ging]]` across two fragments is a normal Tuesday.
 *
 * Not a tool call and not a second request: a tool is unavailable on the plain
 * streaming path, and a second request doubles the cost of every reply to decide a
 * facial expression.
 */

/** The marker, only ever valid at the very start of a reply. */
const TAG = /^\s*\[\[([a-z]+)\]\]\s*/i;

/** Any marker at all, for the sweep that catches one written somewhere unexpected. */
const ANY_TAG = /\[\[[a-z]+\]\]/gi;

/**
 * How much to hold back before deciding there is no tag.
 *
 * Long enough for the longest real one — `[[impressed]]` plus leading whitespace — and
 * short enough that a reply never looks stalled.
 */
const HEAD_CHARS = 20;

/**
 * Removes any marker that escaped the reader. Cheap, and the reply is the deliverable.
 *
 * **Does not trim.** It used to, and it was applied to every streamed fragment — so any
 * fragment that began with a space lost it and the words either side were glued
 * together. Seen live as "the probe-build-fail test has beenfailing". Leading whitespace
 * is only ever wrong at the very start of a reply, which is the one place that trims.
 */
export function stripTags(text: string): string {
  return text.replace(ANY_TAG, '');
}

/**
 * Reads the tag off the front of a streamed reply.
 *
 * Fragments in, display text out. The first few are buffered — nothing is emitted until
 * the tag is resolved either way — so the tag cannot appear on screen for the moment it
 * takes the next fragment to arrive.
 */
export class ReplyStateReader {
  private head = '';
  private decided = false;

  /** The state the model asked for, once known. Undefined means it did not ask. */
  state: ButlerState | undefined;

  /** Text safe to display. Empty while the opening is still being buffered. */
  push(fragment: string): string {
    if (this.decided) return stripTags(fragment);

    this.head += fragment;

    const match = TAG.exec(this.head);
    if (match) {
      // Validated, never trusted: a model inventing `smug` simply gets no expression.
      if (isButlerState(match[1].toLowerCase())) this.state = match[1].toLowerCase() as ButlerState;
      this.decided = true;
      return stripTags(this.head.slice(match[0].length)).trimStart();
    }

    // A tag that has not arrived by now is a tag that was never coming — but a partial
    // `[[` still open at the cutoff is worth one more fragment rather than flushing a
    // half-written marker onto the screen.
    if (this.head.length < HEAD_CHARS || /\[\[[a-z]*$/i.test(this.head)) return '';

    this.decided = true;
    return stripTags(this.head).trimStart();
  }

  /** Whatever is still buffered when the stream ends without ever resolving. */
  flush(): string {
    if (this.decided) return '';
    this.decided = true;
    return stripTags(this.head).trimStart();
  }
}

/**
 * The instruction, for the reply shape.
 *
 * **`talking` is the default and should stay the common case.** A face that changes on
 * every answer is wallpaper and stops carrying anything — §2 rule 2 (sass is earned),
 * applied to the expression rather than the words.
 */
export const STATE_TAG_INSTRUCTION = [
  'Begin the reply with exactly one tag, on the same line, from this list:',
  '[[talking]] [[judging]] [[impressed]] [[surprised]] [[neutral]]',
  'It sets your expression while the reply is read. Use [[talking]] unless the content genuinely earns another — judging at something careless, impressed at something good, surprised at something alarming. Most replies are [[talking]].',
  'Write the tag and then the reply. Never mention the tag, and never use one anywhere but the very start.',
].join('\n');
