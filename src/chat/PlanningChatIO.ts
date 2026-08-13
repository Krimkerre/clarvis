import { PlanningIO } from '../planning/PlanningIO';
import { phrase } from '../personality/Voice';

/**
 * `PlanningIO` as a conversation: questions arrive in the chat panel and the next
 * thing the user types is the answer.
 *
 * **The interview drives, the panel follows.** `ChatService.ask()` normally decides
 * what a message is — a stop, an action, a job, a question. While planning is
 * running it does none of that: the message is an answer to the question just asked,
 * and every routing decision in between would be a chance to misroute it. So chat
 * hands the message straight here, and `ask()` doesn't run at all.
 *
 * A message that arrives with nobody waiting for it is dropped rather than queued —
 * queueing would silently answer a *later* question with an earlier message.
 */
export class PlanningChatIO implements PlanningIO {
  private waiting?: (answer: string | undefined) => void;

  /**
   * **Questions are spoken, documents are not.** Everything Clarvis asks here is
   * solicited — the user typed `/plan` — so §4.4 allows it out loud, and an interview
   * conducted in silence is the one part of this product most obviously improved by a
   * voice. A four-hundred-word plan draft read aloud is not; those go to `write`.
   */
  constructor(
    private readonly speak: (text: string) => Promise<void>,
    private readonly write: (text: string) => Promise<void>,
    /** Offers the answers as buttons in the panel. Typing still works regardless. */
    private readonly offer: (labels: string[]) => void,
    private readonly log: (message: string) => void
  ) {}

  /** Whether an answer is currently expected. Chat checks this before routing. */
  get isWaiting(): boolean {
    return this.waiting !== undefined;
  }

  /** Hands the user's message to whatever question is waiting for it. */
  supply(answer: string): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = undefined;
    this.offer([]);
    waiting(answer);
  }

  /**
   * Abandons the question in flight, if there is one.
   *
   * Resolving as `undefined` rather than leaving the promise hanging: every caller
   * in the interview already treats `undefined` as "paused", so cancelling unwinds
   * the whole flow through paths that already exist.
   */
  cancel(): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = undefined;
    this.offer([]);
    waiting(undefined);
  }

  async askText(prompt: string, placeholder?: string): Promise<string | undefined> {
    // The placeholder is a hint, not part of the question — written, never spoken,
    // and without markdown, which the panel renders as literal asterisks.
    await this.speak(prompt);
    if (placeholder) await this.write(placeholder);
    return this.nextMessage();
  }

  /**
   * A menu, as a numbered list.
   *
   * Accepts the number or the label itself — a chat box has no click targets, and
   * insisting on an exact label match would make "1" a wrong answer to a numbered
   * list, which nobody would forgive.
   */
  async askChoice(prompt: string, items: { label: string; detail?: string }[]): Promise<string | undefined> {
    // **Spoken and written differ here on purpose.** The question is worth hearing;
    // five options with a clause of detail each, read aloud, is forty seconds of
    // audio nobody asked for — and the options are on screen as buttons anyway.
    // The one option they pick gets read out, at the point they pick it.
    //
    // **No markdown.** The panel renders plain text with `code` spans and nothing
    // else, so `**1.**` arrived on screen as literal asterisks — found live. A blank
    // line between options and an indented detail line do the same job in a format
    // the panel actually has.
    const menu = items
      .map((item, index) => `${index + 1}.  ${item.label}${item.detail ? `\n      ${item.detail}` : ''}`)
      .join('\n\n');
    await this.speak(prompt);

    for (;;) {
      await this.write(menu);
      this.offer(items.map((item) => item.label));

      const reply = (await this.nextMessage())?.trim();
      if (!reply) return undefined;

      const chosen = this.match(reply, items);
      if (!chosen) {
        this.log(`planning: chat reply "${reply}" matched no option, treated as free text`);
        return reply;
      }

      // **Confirmed before it counts.** A button is one click away from the wrong
      // answer, and an interview that silently accepts a misclick is one you have to
      // start over. Reading the option back is also the only place the detail gets
      // spoken — which is what makes it worth hearing rather than skipping.
      const confirmed = await this.confirmChoice(chosen);
      if (confirmed) return chosen.label;
      this.log(`planning: "${chosen.label}" declined at the confirmation, asking again`);
    }
  }

  /** A reply as one of the options — by button or name, or by its number. */
  private match(
    reply: string,
    items: { label: string; detail?: string }[]
  ): { label: string; detail?: string } | undefined {
    const byNumber = Number.parseInt(reply, 10);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= items.length) return items[byNumber - 1];
    return items.find((item) => item.label.toLowerCase() === reply.toLowerCase());
  }

  /** Reads the chosen option back and waits for a yes. Anything else means no. */
  private async confirmChoice(chosen: { label: string; detail?: string }): Promise<boolean> {
    await this.speak(chosen.detail ? `${chosen.label}. ${chosen.detail}` : chosen.label);
    await this.write(await phrase('ask', 'Go with that?', []));
    this.offer(['Yes', 'No']);

    const answer = (await this.nextMessage())?.trim().toLowerCase();
    return answer === 'yes' || answer === 'y' || answer === '1';
  }

  /**
   * A decision among named buttons — taken as given, not re-confirmed.
   *
   * Unlike `askChoice`, these *are* the confirmation: "Approve" asked twice is a
   * dialog arguing with itself, and the buttons carry no detail worth reading back.
   */
  async confirm(title: string, detail: string, buttons: string[]): Promise<string | undefined> {
    await this.speak(title);
    await this.write(detail);
    this.offer(buttons);

    const reply = (await this.nextMessage())?.trim();
    if (!reply) return undefined;

    const byNumber = Number.parseInt(reply, 10);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= buttons.length) return buttons[byNumber - 1];
    return buttons.find((label) => label.toLowerCase() === reply.toLowerCase()) ?? reply;
  }

  async say(text: string): Promise<void> {
    await this.speak(text);
  }

  /** Written, never read aloud — nobody wants a plan draft spoken at them. */
  async showDocument(text: string): Promise<void> {
    await this.write(text);
  }

  private nextMessage(): Promise<string | undefined> {
    // A second question while one is already waiting would strand the first
    // forever; the flow is strictly sequential, so this is a bug if it ever fires.
    this.cancel();
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}
