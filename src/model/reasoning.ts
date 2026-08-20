import { ModelError } from './ModelProvider';

/**
 * A reasoning model's private deliberation, kept out of the reply (M8i part 1, F29).
 *
 * **Why this is two problems and not one.** A model that thinks before it answers puts
 * that thinking somewhere, and on an OpenAI-compatible local server *where* is a setting
 * rather than a property of the model. LM Studio's `separateReasoningContentInAPI`
 * (default **on**) routes it into a `reasoning_content` field alongside `content`; turned
 * off, it arrives inline in `content` wrapped in `<think>…</think>`. Both were observed on
 * the wire on 20 Aug against `qwen/qwen3-1.7b`, same prompt, same server:
 *
 * | setting | delta keys | content | reasoning_content |
 * |---|---|---|---|
 * | on | `reasoning_content`, `role` | nothing across 199 frames | 1035 chars |
 * | off | `content`, `role` | 4103 chars, `<think>` from the first frame | none |
 *
 * So the same model produces either **silence** or a **leak**, and a stripper only
 * answers the second. The first needs to be recognised and said out loud, because its
 * symptom — nothing arrives — is indistinguishable from a slow model, and F14's "the
 * character has gone quiet" notice would otherwise fire with the wrong cause.
 *
 * **Why it lives at the provider rather than with the reply.** F15's lesson was one
 * stripper shared by both reply paths, and the provider is strictly more shared than
 * that: every phrasing call, quip, briefing line, intent classification and planning
 * prompt goes through `stream()` without ever meeting `ReplyStateReader`. A `<think>`
 * block reaching those is F22's shape — leaked model text quietly poisoning everything
 * downstream of it.
 *
 * **Anthropic is deliberately not covered.** Extended thinking arrives there as typed
 * `thinking` blocks and only when asked for; Clarvis never asks. There is nothing to
 * strip until that changes.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * How much of the tail of `text` could still be the start of `tag`.
 *
 * Streaming splits text wherever it likes, so a tag can arrive as `<thi` then `nk>` —
 * the same reason `ReplyStateReader` withholds its opening fragments rather than
 * matching `[[talking]]` in one go. Against `qwen3-1.7b` both tags in fact arrived whole,
 * one token each; a GGUF build without those tokens in its vocabulary will not, and a
 * filter that assumed otherwise would pass `<` and `think>` straight to the user.
 *
 * Returns 0 when nothing at the end could be a partial tag, so the common case holds
 * back nothing at all.
 */
function partialTag(text: string, tag: string): number {
  // A whole tag is not a *partial* tag; the caller has already looked for that.
  for (let n = Math.min(text.length, tag.length - 1); n > 0; n--) {
    if (text.slice(-n).toLowerCase() === tag.slice(0, n)) return n;
  }
  return 0;
}

/**
 * Removes `<think>…</think>` from a stream, fragment by fragment.
 *
 * Text either side is preserved exactly, **including whitespace** — the "the
 * probe-build-fail test has beenfailing" bug came from a stripper that trimmed each
 * fragment it touched, and this one never trims.
 *
 * **Only `<think>` opens a block.** A closing tag arriving on its own is passed through
 * as ordinary text. Some chat templates prefill the opening tag into the prompt rather
 * than having the model write it, which would leave only the closing one in the stream —
 * but that is *not* what LM Studio did in the run this was built from, where `<think>`
 * was the first frame, and treating a lone `</think>` as the end of an invisible block
 * would eat every reply that merely quotes the tag. This project's own documents quote
 * it, and Clarvis reads those files aloud. Handled when someone sees it happen.
 *
 * The buffer is bounded: while suppressing it holds at most a partial closing tag, and
 * otherwise at most a partial opening one. A 948-character think block does not sit in
 * memory waiting to be dropped, it is dropped as it arrives.
 */
export class ThinkFilter {
  /** Inside a think block: everything is dropped until the closing tag. */
  private inside = false;

  /** Text not yet safe to emit, because it could be the start of a tag. */
  private held = '';

  /**
   * Whether any thinking was actually removed.
   *
   * The end-of-stream check needs it: a reply that was *entirely* a think block leaves
   * nothing behind, which looks exactly like a model that said nothing at all.
   */
  suppressed = false;

  /** One fragment in, whatever is safe to show out. Often empty; never wrong. */
  push(fragment: string): string {
    this.held += fragment;
    let out = '';

    for (;;) {
      const tag = this.inside ? CLOSE : OPEN;
      const at = this.held.toLowerCase().indexOf(tag);

      if (at === -1) {
        // Nothing to act on yet. Emit everything that cannot be part of a tag, and keep
        // the rest for the next fragment.
        const keep = partialTag(this.held, tag);
        if (!this.inside) out += this.held.slice(0, this.held.length - keep);
        this.held = keep > 0 ? this.held.slice(-keep) : '';
        return out;
      }

      // Text ahead of an opening tag is the reply and is kept; everything from there to
      // the closing tag is not.
      if (!this.inside) out += this.held.slice(0, at);
      this.held = this.held.slice(at + tag.length);
      this.inside = !this.inside;
      this.suppressed = true;
    }
  }

  /**
   * Whatever is left when the stream ends.
   *
   * **An unclosed block is all thinking.** Observed while reproducing this: a reply cut
   * mid-thought carries `<think>` and no closing tag, and every character of it is
   * deliberation. Emitting it "because the tag never closed" would leak precisely what
   * this exists to prevent, so it is dropped and `suppressed` stays true — which is what
   * tells the caller the reply is empty for a reason worth naming.
   *
   * Held text that never became a tag is real text and comes back out.
   */
  flush(): string {
    const rest = this.inside ? '' : this.held;
    this.held = '';
    return rest;
  }
}

/**
 * Whether a finished stream said nothing because its thinking went somewhere else.
 *
 * Pure, and separate from the loop that feeds it, for the reason `absorbToolDeltas` is:
 * a rule buried in a `for await` over a socket is a rule no test can reach. The three
 * ways this is true are the same condition seen from either side of the setting —
 * reasoning arrived in its own field, or arrived inline and was stripped.
 *
 * **Tool calls count as having said something.** An agent turn that calls a tool and
 * writes no prose is ordinary, and reporting it as a broken model would fire on the
 * happy path of every agent run.
 */
export function saidNothingButThought(seen: {
  text: boolean;
  reasoningField: boolean;
  thinkingStripped: boolean;
  toolCalls: boolean;
}): boolean {
  if (seen.text || seen.toolCalls) return false;
  return seen.reasoningField || seen.thinkingStripped;
}

/**
 * One stream's worth of the above: the filter, plus what has been seen.
 *
 * Exists because both stream loops need the identical five lines, and putting them there
 * twice pushed each method past the complexity ceiling — the same rule whose enforcement
 * produced `absorbToolDeltas`, and the same argument for it. A loop that reads one field
 * and hands the delta here stays a loop about streaming.
 */
export class ReasoningWatch {
  private readonly filter = new ThinkFilter();
  private sawText = false;
  private sawReasoning = false;

  /**
   * One delta in, whatever the user may see out.
   *
   * **Whitespace is not speech.** A think block is followed by the `\n\n` that separated
   * it from the answer, and that arrives whether or not an answer does — seen on the
   * agent path, where a reasoning model left exactly two characters behind. Counting it
   * would mean a reply consisting of nothing but deliberation still passed for one that
   * said something. It is still *emitted*: what is shown and what counts are different
   * questions, and trimming the stream is how words get glued together.
   */
  push(delta?: { content?: string; reasoning_content?: string }): string {
    if (delta?.reasoning_content) this.sawReasoning = true;

    const text = this.filter.push(delta?.content ?? '');
    if (text.trim()) this.sawText = true;
    return text;
  }

  /** Anything the filter was still holding when the stream ended. */
  flush(): string {
    const tail = this.filter.flush();
    if (tail.trim()) this.sawText = true;
    return tail;
  }

  /** Whether this stream said nothing because its thinking went elsewhere. */
  saidNothing(toolCalls: boolean): boolean {
    return saidNothingButThought({
      text: this.sawText,
      reasoningField: this.sawReasoning,
      thinkingStripped: this.filter.suppressed,
      toolCalls,
    });
  }

  /**
   * Which of the two shapes it was.
   *
   * The reasoning field wins when both are somehow true: it is the one the user can do
   * something about, and a setting that routes thinking away is a fact about the server
   * rather than about this one reply.
   */
  shape(): 'separate' | 'inline' {
    return this.sawReasoning ? 'separate' : 'inline';
  }
}

/**
 * What the user is told when that happens.
 *
 * **Names the setting, does not touch it.** §9.9: Clarvis may read another application's
 * configuration and say something about it; changing it is never its business. The
 * sentence has to carry the fix anyway, because the symptom is silence and silence
 * offers no clue at all.
 *
 * Composed once here rather than at the two call sites — F25's lesson, where the same
 * explanation existed one function away from the path that needed it and was not shared.
 */
export function reasoningOnlyError(
  providerId: string,
  label: string,
  model: string,
  /**
   * Which of the two shapes was seen.
   *
   * **Not cosmetic.** Told to turn off a setting that is *already off*, a user follows
   * correct-sounding advice into no change at all — and the first version of this did
   * exactly that, because it assumed the branch instead of asking. Caught by replaying
   * both captured streams through it rather than by reading it.
   */
  shape: 'separate' | 'inline'
): ModelError {
  const cause =
    shape === 'separate'
      ? `${label} is keeping the thinking to itself, so nothing reaches me at all.`
      : 'it never got past the thinking — the whole reply was deliberation, with no answer at the end of it.';

  const fix =
    shape === 'separate'
      ? providerId === 'lmstudio'
        ? 'Turn off separateReasoningContentInAPI in LM Studio\'s developer settings, or run a model that does not reason.'
        : 'Run a model that does not reason, or one whose thinking comes back with the reply rather than beside it.'
      : 'Give it more room to finish — a larger context — or run a model that does not reason.';

  return new ModelError(
    `${model} thinks before it answers, and ${cause} ${fix}`,
    `${providerId}/${model}: stream carried ${shape} reasoning only, no visible content`
  );
}
