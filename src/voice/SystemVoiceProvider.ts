import { ButlerViewProvider } from '../panels/ButlerViewProvider';
import { Utterance, VoiceProvider } from './VoiceProvider';
import { WebviewSpeech } from './WebviewSpeech';

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

  private readonly speech: WebviewSpeech;

  constructor(panel: ButlerViewProvider) {
    // The id-and-timeout dance is shared with Tier 1's webview path; see
    // `WebviewSpeech` for why it is one implementation and not two.
    this.speech = new WebviewSpeech(panel);
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
    return this.speech.request((id) => ({
      type: 'speak-system',
      id,
      text: utterance.text,
      voiceId: utterance.voiceId,
    }));
  }
}
