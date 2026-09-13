/**
 * Every way the planning interview talks to whoever it's interviewing.
 *
 * Pulled out so the interview, the analysis verdicts, and the draft/approve loop
 * (`Interview.ts`, `Verdicts.ts`, `planReview.ts`) depend on an interface, not on
 * `vscode.window.*` directly — `VsCodeIO` implements this exactly as those call
 * sites used to behave, `ChatIO` (`src/chat/PlanningChatIO.ts`) implements it as a
 * chat conversation instead. Neither the state machine nor the prompts needed to
 * change for the interview to become chat-native; only where its questions land did.
 */
export interface PlanningIO {
  /**
   * A free-text question. `undefined` means cancelled/paused, never an empty answer.
   *
   * `prefill` is text to hand back for editing, as opposed to `placeholder`, which is
   * only a hint. The difference matters: "Rewrite this finding" was passing the
   * finding as a placeholder, so changing three words of a two-line sentence meant
   * retyping the whole thing.
   */
  askText(prompt: string, placeholder?: string, prefill?: string): Promise<string | undefined>;

  /** A menu. Returns the chosen item's label, or `undefined` if none was chosen. */
  askChoice(prompt: string, items: { label: string; detail?: string }[]): Promise<string | undefined>;

  /** A yes/no-shaped decision among named buttons. Returns the chosen button's label. */
  confirm(title: string, detail: string, buttons: string[]): Promise<string | undefined>;

  /** A short aside — a quip, a one-line status. Never blocks on a reply. */
  say(text: string): Promise<void>;

  /**
   * A longer piece of writing — a draft, a summary, the finished plan.
   *
   * Repeated calls replace what the last one showed rather than stacking up another
   * editor tab: an interview shows the summary, then a draft, then a redraw per
   * refinement round, and each of those used to arrive as its own document.
   */
  showDocument(text: string): Promise<void>;

  /**
   * Puts away whatever `showDocument` last showed.
   *
   * Called once `plan.md` exists on disk, because a draft sitting next to the file it
   * became is an invitation to edit the wrong one — and they look identical, an
   * untitled markdown document being named after its own first heading.
   */
  closeDocument(): Promise<void>;

  /**
   * What the document `showDocument` last showed says now — anything typed into it included.
   *
   * `undefined` when there is nothing to read: nothing shown yet, or the tab closed since.
   *
   * **The draft is editable, so what is typed into it is part of the answer (M9i).** Approve
   * used to write the text that had been rendered rather than the text on screen, so a step
   * deleted by hand came back in plan.md: the approval gate saving something other than what
   * was approved.
   */
  readDocument(): Promise<string | undefined>;
}

/**
 * Thrown out of a question when the person stops planning (M9i).
 *
 * **An error, not `undefined`, because `undefined` had come to mean three things.** Escape
 * on an interview question paused; Escape on a finding accepted it with its first fix; Stop
 * at "Go with that?" read as No and put the same options back. A cancellation that every
 * caller has to remember to treat as a pause is one that some caller will not. Thrown, it
 * unwinds to the one place that catches it — `runPlanning` — and nothing in between can
 * record it as an answer.
 */
export class PlanningPaused extends Error {
  constructor() {
    super('planning paused');
    this.name = 'PlanningPaused';
  }
}

/** What is said when planning pauses. Verbatim: two facts, at the moment someone pressed Stop. */
export const PLANNING_PAUSED_LINE = 'Paused. Nothing on screen was decided, and nothing was started.';
