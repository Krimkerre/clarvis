/**
 * Every way the planning interview talks to whoever it's interviewing.
 *
 * Pulled out so the interview, the analysis verdicts, and the draft/approve loop
 * (`Interview.ts`, `Verdicts.ts`, `PlanningFlow.ts`) depend on an interface, not on
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
}
