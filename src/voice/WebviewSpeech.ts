import { ButlerViewProvider } from '../panels/ButlerViewProvider';

/** How long to wait for the webview to report an utterance finished. */
export const SPEECH_TIMEOUT_MS = 30_000;

/**
 * One utterance sent to the webview, awaited until it reports back.
 *
 * Extracted when Tier 1 gained a webview path and there were two providers
 * doing the same three things: mint an id, hold the promise until
 * `speech-ended` or `speech-error` arrives for that id, and give up rather than
 * leave the avatar stuck mid-sentence if nothing ever does. Two copies of a
 * timeout is two places for one of them to be forgotten.
 *
 * The timeout is the part worth keeping honest: a voice that never reports back
 * is indistinguishable from one still speaking, and the failure mode without it
 * is not silence but a UI that believes it is still talking forever.
 */
export class WebviewSpeech {
  private nextId = 0;
  private readonly pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();

  constructor(
    private readonly panel: ButlerViewProvider,
    private readonly timeoutMs: number = SPEECH_TIMEOUT_MS
  ) {
    panel.onDidFinishSpeech(({ id, error }) => {
      const waiter = this.pending.get(id);
      if (!waiter) return;

      this.pending.delete(id);
      if (error) waiter.reject(new Error(error));
      else waiter.resolve();
    });
  }

  /**
   * Post one message built around a fresh id, and resolve when the webview says
   * that id is done.
   *
   * The caller supplies the message so this stays ignorant of what is being
   * spoken — `speak-system` hands over text for the browser's own synthesiser,
   * `speak-audio` hands over rendered bytes as a data URI, and the waiting is
   * identical either way.
   */
  request(build: (id: string) => Parameters<ButlerViewProvider['post']>[0]): Promise<void> {
    const id = `s${this.nextId++}`;

    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.panel.post(build(id));

      setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error('speech timed out'));
      }, this.timeoutMs);
    });
  }
}
