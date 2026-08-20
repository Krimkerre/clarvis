import { ModelService } from '../model/ModelService';
import { acceptRewrite, Line, Purpose, rewritePrompt, worthRewriting } from './say';
import { acceptOpening, openingPrompt } from './originalLine';

/**
 * Puts a line in Clarvis's voice, when there is a model to do it.
 *
 * Everything user-facing routes through here, so the character arrives everywhere at
 * once rather than being remembered surface by surface — which is how it came to be
 * present in chat and absent in every dialog (§2.2).
 *
 * Three things keep it from being a liability:
 *  - **the written line always works**, so a missing key, a slow model or a rejected
 *    rewrite costs nothing
 *  - **a short deadline**, because these sit in front of dialogs the user is waiting on
 *  - **caching by content**, so the same prompt is not rewritten twice in one session
 */

/** A dialog is being waited on. Late character is worse than none. */
const DEADLINE_MS = 2000;

/** Nothing is blocked on an opening line, and sounding fresh is worth the moment. */
const OPENING_DEADLINE_MS = 5000;

export class Voice {
  /**
   * **No cache.**
   *
   * The first version reused a rewrite for the whole session, so the third time a run
   * finished you heard the same sentence you heard the first time — repetition being
   * the exact failure the written bank already had, now with a model bill attached.
   */

  constructor(
    private readonly models: ModelService,
    private readonly log: (message: string) => void
  ) {}

  /** The line, in character where possible and verbatim where not. */
  async say(line: Line): Promise<string> {
    // A warning or a question was already plain, exact and fine. Rewriting it gained
    // nothing and cost stiffness, which is most of what made the layer feel worse than
    // the strings it replaced.
    if (!worthRewriting(line.purpose)) return line.fallback;

    try {
      if (!(await this.models.isReady('chat'))) return line.fallback;

      const raw = await Promise.race([
        this.collect(rewritePrompt(line)),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), DEADLINE_MS)),
      ]);

      const rewritten = acceptRewrite(line, raw);

      // **Logged like `open()` does, and for the reason written there**: "rejected" on its
      // own says a rule fired and not which one, and every guess about which costs a
      // rebuild and a live run. A rejection was silent here until 20 Aug, which made the
      // grounding check — the whole point of which is to catch a wrong number before
      // anyone reads it — impossible to observe working.
      if (!rewritten && raw?.trim()) {
        this.log(`voice: rewrite rejected, kept the written line — model said: ${JSON.stringify(raw.trim())}`);
      }

      return rewritten ?? line.fallback;
    } catch (error) {
      this.log(`voice: rewrite failed (${String(error)})`);
      return line.fallback;
    }
  }

  /**
   * A line written for the moment, rather than a written one rewritten.
   *
   * `say()` deliberately leaves questions alone — a question was already plain and
   * exact, and rewriting it costs stiffness. That is right for "shall I stop?" and
   * wrong for the line that opens plan mode, which is the first thing a new user
   * hears and read like a template because it was one. This asks for the line
   * itself, from the situation, with the written one still the fallback.
   *
   * A longer deadline than `say()`: nothing is waiting on this the way a modal is,
   * and it is worth a moment to not sound the same twice.
   */
  async open(situation: string, fallback: string, mustAsk = true, keep: readonly string[] = []): Promise<string> {
    try {
      if (!(await this.models.isReady('chat'))) return fallback;

      const raw = await Promise.race([
        this.collect(openingPrompt(situation, mustAsk, keep)),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), OPENING_DEADLINE_MS)),
      ]);

      const line = acceptOpening(raw, mustAsk, keep);
      // **The rejected text, verbatim.** "Rejected" on its own says a rule fired and
      // not which one — and every guess about which costs a rebuild and a live run.
      this.log(
        line
          ? 'voice: opening written for the moment'
          : `voice: opening rejected, used the written line — model said: ${JSON.stringify(raw ?? '(nothing)')}`
      );
      return line ?? fallback;
    } catch (error) {
      this.log(`voice: opening failed (${String(error)})`);
      return fallback;
    }
  }

  private async collect(prompt: string): Promise<string> {
    let text = '';

    for await (const fragment of this.models.stream(
      {
        system: 'You rewrite one line in character. Nothing else.',
        messages: [{ role: 'user', content: prompt }],
      },
      'chat'
    )) {
      text += fragment;
      if (text.length > 300) break;
    }

    return text;
  }
}

/**
 * The one voice, reachable from anywhere that speaks.
 *
 * A module-level accessor rather than a constructor argument, deliberately. Forty-odd
 * places in this extension say something to a person — pickers, watchers, wizards,
 * commands — and threading a writer into each is the friction that caused the original
 * problem: it was always easier to type the string than to plumb the character through.
 *
 * Unset, `phrase()` returns the written line, so nothing depends on it having been
 * wired. That matters for tests, and for the first seconds of activation.
 */
let writer: Voice | undefined;

export function setVoice(voice: Voice): void {
  writer = voice;
}

/**
 * The line, in character where possible and verbatim where not.
 *
 * `keep` names the facts that must survive — branch names, counts, commands — and a
 * rewrite that loses one is rejected rather than used.
 */
export async function phrase(purpose: Purpose, fallback: string, keep?: string[]): Promise<string> {
  if (!writer) return fallback;
  return writer.say({ purpose, fallback, keep });
}

/** An original line for a moment, from anywhere. See `Voice.open`. */
export async function opening(
  situation: string,
  fallback: string,
  mustAsk = true,
  keep: readonly string[] = []
): Promise<string> {
  if (!writer) return fallback;
  return writer.open(situation, fallback, mustAsk, keep);
}
