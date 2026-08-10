import { ModelService } from '../model/ModelService';
import { acceptRewrite, Line, Purpose, rewritePrompt } from './say';

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

export class Voice {
  /** Rewrites already made, keyed by the written line. */
  private readonly seen = new Map<string, string>();

  constructor(
    private readonly models: ModelService,
    private readonly log: (message: string) => void
  ) {}

  /** The line, in character where possible and verbatim where not. */
  async say(line: Line): Promise<string> {
    const cached = this.seen.get(line.fallback);
    if (cached) return cached;

    try {
      if (!(await this.models.isReady('chat'))) return line.fallback;

      const raw = await Promise.race([
        this.collect(rewritePrompt(line)),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), DEADLINE_MS)),
      ]);

      const accepted = acceptRewrite(line, raw);
      if (!accepted) return line.fallback;

      this.seen.set(line.fallback, accepted);
      return accepted;
    } catch (error) {
      this.log(`voice: rewrite failed (${String(error)})`);
      return line.fallback;
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
