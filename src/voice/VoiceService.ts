import * as vscode from 'vscode';
import { AvatarController } from '../AvatarController';
import { VoiceProvider, Utterance } from './VoiceProvider';
import { SpeechOccasion, mayBeSpoken } from './speechScope';
import { resolveVoiceId } from './curatedVoices';
import { stopPlayback } from './nativePlayer';
import { speakable } from './speakable';

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

  /**
   * Utterances are spoken one at a time, in order.
   *
   * Without this they collide: the system voice calls `speechSynthesis.cancel()`
   * before speaking, so a second utterance **chops the first off mid-sentence**, and
   * two native players would simply talk over each other. A briefing followed closely
   * by a completion notice is enough to trigger it.
   */
  private queue: Promise<void> = Promise.resolve();

  /**
   * Session mute (§4.4), separate from `clarvis.voice.enabled` on purpose.
   *
   * The setting is a decision about the feature; this is a decision about the next ten
   * minutes. Muting to get through a meeting must not quietly disable voice forever,
   * so this lives in memory and dies with the window — reload and Clarvis talks again.
   */
  private muted = false;

  /** Fires whenever mute flips, so the panel and the avatar can show it. */
  private readonly muteListeners: ((muted: boolean) => void)[] = [];

  onMuteChange(listener: (muted: boolean) => void): void {
    this.muteListeners.push(listener);
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * Silences, or un-silences.
   *
   * Muting stops the utterance already playing *and* abandons everything queued behind
   * it. Dropping the queue is the part that is easy to miss: a paused backlog would
   * come flooding out on unmute, narrating builds that finished ten minutes ago.
   */
  setMuted(muted: boolean): void {
    this.muted = muted;

    if (muted) {
      const stopped = stopPlayback();
      // The system voice lives in the webview and has its own stop channel.
      this.stopSystemVoice();
      // Abandon the tail. Anything already chained keeps its own `muted` check, but
      // resetting the chain means unmute starts from silence rather than a backlog.
      this.queue = Promise.resolve();
      this.avatar.setState('neutral');
      this.log(`voice: muted${stopped ? ' (stopped playback in progress)' : ''}`);
    } else {
      this.log('voice: unmuted');
    }

    for (const listener of this.muteListeners) listener(muted);
  }

  /** How the webview's speechSynthesis is silenced; set by the composition root. */
  stopSystemVoice: () => void = () => {};

  constructor(
    private readonly avatar: AvatarController,
    private readonly primary: VoiceProvider,
    private readonly fallback: VoiceProvider,
    private readonly log: (message: string) => void
  ) {}

  private get enabled(): boolean {
    // Must match package.json's declared default. The two disagreeing when no settings
    // file exists is the kind of split-brain default nobody finds until it is reported
    // as "it talks on my machine but not on yours".
    return vscode.workspace.getConfiguration('clarvis').get<boolean>('voice.enabled', false);
  }

  private get selectedVoice(): string | undefined {
    const value = vscode.workspace
      .getConfiguration('clarvis')
      .get<string>('voice.selectedVoice', 'curated:default');

    return resolveVoiceId(value);
  }

  /**
   * Says something, if it should be said.
   *
   * Deliberately fire-and-forget for callers: nothing waits on audio, so a slow or
   * broken voice can never delay a notification or block the extension.
   */
  say(text: string, occasion: SpeechOccasion): void {
    if (!this.enabled || this.muted) return;
    if (!mayBeSpoken(occasion)) {
      this.log(`voice: not spoken (${occasion} is out of scope)`);
      return;
    }

    // Chained rather than fired: each utterance waits for the previous one to finish.
    // Failures are swallowed so one bad utterance can't stall everything behind it.
    this.queue = this.queue
      .catch(() => undefined)
      // Normalised here rather than at the call sites: written text and spoken text
      // are different languages, and every surface would otherwise have to remember.
      .then(() => this.speakWithFallback({ text: speakable(text), voiceId: this.selectedVoice }));
  }

  /**
   * Speaks a specific voice on demand, ignoring the enabled flag and the occasion
   * rules — auditioning a voice is a direct request, not an unsolicited remark.
   */
  preview(text: string, selectedVoice: string): void {
    const voiceId = resolveVoiceId(selectedVoice);
    this.queue = this.queue
      .catch(() => undefined)
      .then(() => this.speakWithFallback({ text: speakable(text), voiceId }));
  }

  /**
   * Tries the good voice, then the plain one.
   *
   * The avatar tracks actual playback — `talking` while audio is running, back to
   * `neutral` when it genuinely ends — rather than a fixed timer, so the mouth can't
   * drift out of sync with the sound.
   */
  private async speakWithFallback(utterance: Utterance): Promise<void> {
    // Re-checked here, not just at say(): an utterance can sit in the queue for
    // seconds behind a long one, and mute pressed during that wait must apply to it.
    if (this.muted) return;
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
