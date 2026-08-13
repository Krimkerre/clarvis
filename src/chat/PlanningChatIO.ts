import { PlanningIO } from '../planning/PlanningIO';

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

  constructor(
    private readonly post: (text: string) => Promise<void>,
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
    waiting(undefined);
  }

  async askText(prompt: string, placeholder?: string): Promise<string | undefined> {
    await this.post(placeholder ? `${prompt}\n\n*${placeholder}*` : prompt);
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
    const menu = items
      .map((item, index) => `**${index + 1}.** ${item.label}${item.detail ? `\n   ${item.detail}` : ''}`)
      .join('\n');
    await this.post(`${prompt}\n\n${menu}\n\n*Reply with a number, or the name itself.*`);

    const reply = (await this.nextMessage())?.trim();
    if (!reply) return undefined;

    const byNumber = Number.parseInt(reply, 10);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= items.length) {
      return items[byNumber - 1].label;
    }

    const byLabel = items.find((item) => item.label.toLowerCase() === reply.toLowerCase());
    if (byLabel) return byLabel.label;

    this.log(`planning: chat reply "${reply}" matched no option, treated as free text`);
    return reply;
  }

  /** The same numbered-menu shape as `askChoice`, so answering works identically. */
  async confirm(title: string, detail: string, buttons: string[]): Promise<string | undefined> {
    return this.askChoice(
      `${title}\n\n${detail}`,
      buttons.map((label) => ({ label }))
    );
  }

  async say(text: string): Promise<void> {
    await this.post(text);
  }

  async showDocument(text: string): Promise<void> {
    await this.post(text);
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
