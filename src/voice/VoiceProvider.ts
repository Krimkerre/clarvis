/** One thing Clarvis can say aloud. */
export interface Utterance {
  text: string;
  /** Voice model id, or undefined for the host's default system voice. */
  voiceId?: string;
}

/**
 * How Clarvis speaks. Two implementations behind it (§4.4): the OS voice, which is
 * free and always available, and Fish Audio, which is the one that actually carries
 * the character.
 *
 * The rest of the extension only knows this interface — same shape as the model and
 * speech-input providers, so swapping tiers never leaks into calling code.
 */
export interface VoiceProvider {
  readonly id: 'system' | 'fishAudio';

  /** Resolves when the utterance has finished playing, or rejects if it can't. */
  speak(utterance: Utterance): Promise<void>;

  /** Whether this provider can currently be used at all (key present, etc.). */
  isAvailable(): Promise<boolean>;

  /**
   * Why `isAvailable()` said no, in a sentence a person can act on.
   *
   * Optional, because a provider that is always available has nothing to
   * explain. It exists because "unavailable" was being treated as a non-event:
   * `VoiceService` warned when the good voice *threw* and said nothing at all
   * when it simply reported itself unavailable — so a missing key produced the
   * system voice, silently, and the only way to find out why was to guess.
   *
   * Found in code-server, where SecretStorage is a different store from desktop
   * VS Code's and the Fish Audio key therefore is not there. But the bug was
   * never code-server's: the same silence happens in desktop VS Code the moment
   * a key is absent.
   */
  unavailableReason?(): Promise<string>;
}
