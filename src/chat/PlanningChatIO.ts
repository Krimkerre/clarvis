import { PlanningIO, PlanningPaused } from '../planning/PlanningIO';
import { phrase } from '../personality/Voice';

/** The editor tab a plan draft lives in — `DraftDocument`, as far as this adapter needs it. */
export interface DraftSurface {
  show(text: string): Promise<void>;
  close(): Promise<void>;
  text(): string | undefined;
}

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
  private waiting?: { answer: (reply: string | undefined) => void; pause: (stop: PlanningPaused) => void };

  /** Set by Stop and never cleared: one adapter serves one sitting. */
  private paused = false;

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
    private readonly offer: (items: { label: string; detail?: string }[]) => void,
    /** The editor tab drafts are shown in, read back from, and put away once plan.md exists. */
    private readonly draft: DraftSurface,
    /** Puts text in the prompt box for editing, rather than for copying by hand. */
    private readonly fill: (text: string) => void,
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
    waiting.answer(answer);
  }

  /**
   * Stops planning — with a question on screen, or while a model works out the next one.
   *
   * **This used to resolve the question as `undefined`**, on the grounds that every caller
   * already treated that as "paused". Four did not: a finding was accepted with its first fix,
   * the name picker and a follow-up recorded a default and asked the next question, and "Go
   * with that?" read it as No and offered the same options again (M9i). Now the waiting
   * question throws `PlanningPaused`, every later question throws before it is asked, and
   * whatever a model finishes after the stop is neither said nor shown.
   */
  cancel(): void {
    this.paused = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    this.offer([]);
    waiting?.pause(new PlanningPaused());
  }

  async askText(prompt: string, placeholder?: string, prefill?: string, actions?: string[]): Promise<string | undefined> {
    // The placeholder is a hint, not part of the question — written, never spoken,
    // and without markdown, which the panel renders as literal asterisks.
    await this.talk(prompt);
    if (placeholder) await this.note(placeholder);
    this.throwIfPaused();
    // Text to edit goes into the prompt box itself. Written into the transcript, it
    // would be something to copy by hand — which is what "Modify" asked for until now.
    if (prefill) this.fill(prefill);
    // "Draft it now" and the like, as buttons under the question; the typed answer box
    // stays the ordinary way to reply. A pressed button arrives as its label.
    if (actions && actions.length > 0) this.offer(actions.map((label) => ({ label })));
    return this.nextMessage();
  }

  /**
   * A menu, as buttons.
   *
   * Accepts a label, or its number when the number is the whole reply — see `optionIndex`.
   * Anything else is an answer in its own words, handed back exactly as it was typed.
   */
  async askChoice(prompt: string, items: { label: string; detail?: string }[]): Promise<string | undefined> {
    // **The options are the buttons.** They were a written list *and* a row of bare
    // labels underneath — the same information twice, in a panel narrow enough that
    // it filled the window. The explanation now lives on the button it belongs to.
    //
    // Spoken and written still differ: the question is worth hearing, five options
    // with a clause each is forty seconds of audio nobody asked for, and the one
    // option they pick gets read out at the point they pick it.
    await this.talk(prompt);

    for (;;) {
      this.throwIfPaused();
      this.offer(items);

      const reply = (await this.nextMessage())?.trim();
      if (!reply) return undefined;

      const index = optionIndex(reply, items.map((item) => item.label));
      if (index === undefined) {
        this.log(`planning: chat reply "${reply}" matched no option, treated as free text`);
        return reply;
      }

      // **Confirmed before it counts.** A button is one click away from the wrong
      // answer, and an interview that silently accepts a misclick is one you have to
      // start over. Reading the option back is also the only place the detail gets
      // spoken — which is what makes it worth hearing rather than skipping.
      const chosen = items[index];
      if (await this.confirmChoice(chosen)) return chosen.label;
      this.log(`planning: "${chosen.label}" declined at the confirmation, asking again`);
    }
  }

  /**
   * Reads the chosen option back and waits for a yes. Anything but yes asks again — except a
   * stop, which pauses rather than counting as the no it used to.
   */
  private async confirmChoice(chosen: { label: string; detail?: string }): Promise<boolean> {
    await this.talk(chosen.detail ? `${chosen.label}. ${chosen.detail}` : chosen.label);
    await this.note(await phrase('ask', 'Go with that?', []));
    this.throwIfPaused();
    this.offer([{ label: 'Yes' }, { label: 'No' }]);

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
    await this.talk(title);
    await this.note(detail);
    this.throwIfPaused();
    this.offer(buttons.map((label) => ({ label })));

    const reply = (await this.nextMessage())?.trim();
    if (!reply) return undefined;

    const index = optionIndex(reply, buttons);
    return index === undefined ? reply : buttons[index];
  }

  async say(text: string): Promise<void> {
    await this.talk(text);
  }

  /**
   * The editor, not the chat panel.
   *
   * Found live: a whole `plan.md` posted into a side panel arrives as one
   * unreadable slab — no headings, no spacing that survives, and it pushes the
   * question about it off the top of the transcript. The document goes where
   * documents are read; the approval question stays in the conversation, where it
   * can be answered. Never read aloud either — nobody wants a plan spoken at them.
   */
  async showDocument(text: string): Promise<void> {
    if (this.paused) return;
    await this.draft.show(text);
  }

  async closeDocument(): Promise<void> {
    if (this.paused) return;
    await this.draft.close();
  }

  /** Still answered after a stop: a paused sitting saves the draft as it reads at that moment. */
  async readDocument(): Promise<string | undefined> {
    return this.draft.text();
  }

  /** Spoken — unless planning has been stopped since whatever is being said was set in motion. */
  private async talk(text: string): Promise<void> {
    if (!this.paused) await this.speak(text);
  }

  /** Written, on the same condition. */
  private async note(text: string): Promise<void> {
    if (!this.paused) await this.write(text);
  }

  private throwIfPaused(): void {
    if (this.paused) throw new PlanningPaused();
  }

  private nextMessage(): Promise<string | undefined> {
    if (this.paused) return Promise.reject(new PlanningPaused());
    // A second question while one is already waiting would strand the first
    // forever; the flow is strictly sequential, so this is a bug if it ever fires.
    this.waiting?.answer(undefined);
    return new Promise((answer, pause) => {
      this.waiting = { answer, pause };
    });
  }
}

/**
 * Which option a reply names: its label, or its number when the number is the whole reply.
 *
 * **Only the whole reply (M9i).** `Number.parseInt` read `1 but keep offline support` as 1 —
 * at the approve gate that was Approve, and plan.md was written without the change the rest of
 * the sentence asked for — and `1.5` as option 1. A reply that says more than a number is
 * something to read, not a button to press. The buttons carry no numbers, so a typed number is
 * a shortcut kept for whoever already uses it rather than something the panel advertises.
 */
export function optionIndex(reply: string, labels: string[]): number | undefined {
  if (/^\d+$/.test(reply)) {
    const number = Number(reply);
    return number >= 1 && number <= labels.length ? number - 1 : undefined;
  }
  const index = labels.findIndex((label) => label.toLowerCase() === reply.toLowerCase());
  return index < 0 ? undefined : index;
}
