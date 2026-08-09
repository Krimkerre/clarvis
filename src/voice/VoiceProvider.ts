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
}
