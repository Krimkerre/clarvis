import { ButlerViewProvider } from '../panels/ButlerViewProvider';
import { Utterance, VoiceProvider } from './VoiceProvider';

/** Nothing should hang forever waiting on a voice that never finishes. */
const SPEECH_TIMEOUT_MS = 30_000;

/**
 * Speaks with the operating system's own voice (Tier 0, §4.4).
 *
 * Free, offline, always there — and a downgrade, which the plan says out loud rather
 * than pretending the tiers are equivalent. It reads the words; it doesn't perform
 * them. Its job is to be the thing that still works when the good voice can't.
 *
 * The audio itself plays in the webview, because the extension host has no audio
 * output at all. This class is the host-side half of that conversation.
 */
export class SystemVoiceProvider implements VoiceProvider {
  readonly id = 'system' as const;

  private nextId = 0;
  private readonly pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();

  constructor(private readonly panel: ButlerViewProvider) {
    panel.onDidFinishSpeech(({ id, error }) => {
      const waiter = this.pending.get(id);
      if (!waiter) return;

      this.pending.delete(id);
      if (error) waiter.reject(new Error(error));
      else waiter.resolve();
    });
  }

  /**
   * Available whenever the panel exists.
   *
   * `speechSynthesis` support is probed at webview load rather than assumed — M1's
   * lesson about the webview sandbox — but a missing implementation surfaces as a
   * failed utterance, which the caller already handles by falling back or going quiet.
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  speak(utterance: Utterance): Promise<void> {
    const id = `s${this.nextId++}`;

    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.panel.post({ type: 'speak-system', id, text: utterance.text, voiceId: utterance.voiceId });

      // A voice that never reports back would otherwise leave the avatar stuck
      // mid-sentence — the same stuck-state class of bug M3 hit with cancelled tasks.
      setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error('speech timed out'));
      }, SPEECH_TIMEOUT_MS);
    });
  }
}
