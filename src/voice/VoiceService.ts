import * as vscode from 'vscode';
import { AvatarController } from '../AvatarController';
import { VoiceProvider, Utterance } from './VoiceProvider';
import { SpeechOccasion, mayBeSpoken } from './speechScope';

/**
 * Speaks, when speaking is appropriate.
 *
 * Owns three decisions that are easy to scatter and then get subtly wrong:
 *   1. whether voice is enabled at all
 *   2. whether *this* occasion is one of the two that may be spoken (§4.4)
 *   3. which tier to use, and what to do when it fails
 *
 * Failure is never loud. If the good voice can't be reached, the fallback speaks; if
 * that fails too, Clarvis simply stays quiet. The notification has already been shown
 * either way — voice is an enhancement to a message, never the message itself.
 */
export class VoiceService {
  /** One warning per session, so a persistent outage isn't a persistent nag. */
  private warnedThisSession = false;

  constructor(
    private readonly avatar: AvatarController,
    private readonly primary: VoiceProvider,
    private readonly fallback: VoiceProvider,
    private readonly log: (message: string) => void
  ) {}

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('clarvis').get<boolean>('voice.enabled', false);
  }

  private get selectedVoice(): string | undefined {
    const value = vscode.workspace
      .getConfiguration('clarvis')
      .get<string>('voice.selectedVoice', 'curated:default');

    // "system" and the curated placeholder both mean "no specific model id".
    return value.startsWith('fish:') ? value.slice('fish:'.length) : undefined;
  }

  /**
   * Says something, if it should be said.
   *
   * Deliberately fire-and-forget for callers: nothing waits on audio, so a slow or
   * broken voice can never delay a notification or block the extension.
   */
  say(text: string, occasion: SpeechOccasion): void {
    if (!this.enabled) return;
    if (!mayBeSpoken(occasion)) {
      this.log(`voice: not spoken (${occasion} is out of scope)`);
      return;
    }

    void this.speakWithFallback({ text, voiceId: this.selectedVoice });
  }

  /**
   * Tries the good voice, then the plain one.
   *
   * The avatar tracks actual playback — `talking` while audio is running, back to
   * `neutral` when it genuinely ends — rather than a fixed timer, so the mouth can't
   * drift out of sync with the sound.
   */
  private async speakWithFallback(utterance: Utterance): Promise<void> {
    this.avatar.setState('talking');

    try {
      if (await this.primary.isAvailable()) {
        await this.primary.speak(utterance);
        this.avatar.setState('neutral');
        return;
      }
    } catch (error) {
      this.log(`voice: ${this.primary.id} failed (${String(error)}), falling back`);
      this.warnOnce();
    }

    try {
      // The fallback gets no voice id — a Fish Audio model id means nothing to the OS.
      await this.fallback.speak({ text: utterance.text });
    } catch (error) {
      this.log(`voice: fallback failed too (${String(error)}); staying quiet`);
    } finally {
      this.avatar.setState('neutral');
    }
  }

  /** At most one non-modal warning per session (§4.4). Never a modal, never a retry storm. */
  private warnOnce(): void {
    if (this.warnedThisSession) return;
    this.warnedThisSession = true;
    void vscode.window.showWarningMessage(
      'Clarvis: the preferred voice is unavailable, using the system voice for now.'
    );
  }
}
