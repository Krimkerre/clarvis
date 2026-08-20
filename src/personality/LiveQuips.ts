import { ModelService } from '../model/ModelService';
import { withDeadline } from '../model/deadline';
import { QuipTrigger } from './quipBank';
import {
  acknowledgementPrompt,
  completionQuipPrompt,
  quipPrompt,
  sanitiseQuip,
  QuipContext,
} from './liveQuip';

/**
 * Asks the model for a line, within a deadline it will usually beat.
 *
 * §4.6/M8g2's constraints, and each of them is here rather than at the call sites:
 *  - **only after the interruption budget has allowed the surface**, so tokens are
 *    never spent on a remark nobody will see
 *  - **never during an agent run**, where the same budget is paying for actual work
 *  - **a hard deadline**, because a joke that arrives after you've moved on is not a
 *    joke, and the bank is instant
 *
 * Failure is always `undefined`, never an exception: the caller has a canned line
 * ready, and a quip is the least important thing this product does.
 */

/** A late quip is a worse quip. Short enough that the fallback still feels immediate. */
const DEADLINE_MS = 4000;

export class LiveQuips {
  constructor(
    private readonly models: ModelService,
    /** Whether an agent run is in progress — quips stay out of its way. */
    private readonly busy: () => boolean,
    private readonly log: (message: string) => void
  ) {}

  async write(trigger: QuipTrigger, sharp: boolean, detail?: string): Promise<string | undefined> {
    if (this.busy()) return undefined;
    if (!(await this.models.isReady('chat'))) return undefined;

    const context: QuipContext = { trigger, sharp, detail };

    try {
      const text = await withDeadline(DEADLINE_MS, (signal) => this.collect(quipPrompt(context), signal), () => '');

      const quip = sanitiseQuip(text);
      this.log(quip ? `quip: written for ${trigger}` : `quip: model line rejected for ${trigger}`);
      return quip;
    } catch (error) {
      this.log(`quip: model failed for ${trigger} (${String(error)})`);
      return undefined;
    }
  }

  /**
   * The line said at the start of a run.
   *
   * Unlike a quip this is *solicited* — the user just asked for something — so it does
   * not go through the interruption budget and is not suppressed during a run: it is
   * the opening of the run itself.
   */
  async acknowledge(task: string): Promise<string | undefined> {
    if (!(await this.models.isReady('chat'))) return undefined;

    try {
      const text = await withDeadline(
        DEADLINE_MS,
        (signal) => this.collect(acknowledgementPrompt(task), signal),
        () => ''
      );

      return sanitiseQuip(text);
    } catch (error) {
      this.log(`quip: acknowledgement failed (${String(error)})`);
      return undefined;
    }
  }

  /** The aside after a finished task. Solicited, so no budget applies. */
  async afterTask(task: string, summary: string): Promise<string | undefined> {
    if (!(await this.models.isReady('chat'))) return undefined;

    try {
      const text = await withDeadline(
        DEADLINE_MS,
        (signal) => this.collect(completionQuipPrompt(task, summary), signal),
        () => ''
      );

      return sanitiseQuip(text);
    } catch (error) {
      this.log(`quip: completion line failed (${String(error)})`);
      return undefined;
    }
  }

  private async collect(prompt: string, signal: AbortSignal): Promise<string> {
    let text = '';

    try {
      for await (const fragment of this.models.stream(
        {
          // Kept out of the chat transcript deliberately: this is Clarvis thinking of
          // something to say, not a conversation the user is part of.
          system: 'You write one short, dry remark. Nothing else.',
          messages: [{ role: 'user', content: prompt }],
          signal,
        },
        'chat'
      )) {
        text += fragment;
        // No point streaming past the length limit — the answer is already too long.
        if (text.length > 400) break;
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }

    return text;
  }
}
