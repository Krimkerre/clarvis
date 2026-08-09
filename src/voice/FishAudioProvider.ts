import * as vscode from 'vscode';
import { Utterance, VoiceProvider } from './VoiceProvider';
import { cacheKey, selectForEviction, CacheEntry } from './voiceCache';
import { playFile } from './nativePlayer';

/** Where the key lives: the OS keychain, never settings.json, never logged. */
export const FISH_KEY_SECRET = 'clarvis.fishAudio.key';

/** Past this, waiting is worse than a plainer voice arriving now (§4.4). */
const REQUEST_TIMEOUT_MS = 3000;

const TTS_ENDPOINT = 'https://api.fish.audio/v1/tts';

/**
 * The voice that actually carries the character (Tier 1, §4.4).
 *
 * The request is made **here, in the extension host**, and the rendered mp3 is played
 * by the OS's own headless player rather than by the webview.
 *
 * That last part was forced by a real constraint: Chromium blocks audio until the
 * webview document has had a user gesture, and the launch briefing — voice's whole
 * reason for existing — fires about a second after startup, long before anyone could
 * click anything. Webview playback would have meant the briefing was essentially never
 * spoken in the good voice, and that voice required the panel to be open at all.
 *
 * Playing natively also removes a round-trip: the player process exiting *is* the
 * "finished" signal, so the avatar tracks real playback with no timer involved.
 *
 * Every failure path drops to the system voice rather than going silent, because a
 * plain voice now beats a good voice never.
 */
export class FishAudioProvider implements VoiceProvider {
  readonly id = 'fishAudio' as const;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void
  ) {}

  /**
   * Available with a key, within the daily cap. No gesture needed any more, and no
   * panel either — playback doesn't go through the webview.
   */
  async isAvailable(): Promise<boolean> {
    const key = await this.context.secrets.get(FISH_KEY_SECRET);
    return Boolean(key) && this.withinDailyCap();
  }

  async speak(utterance: Utterance): Promise<void> {
    const engine = vscode.workspace
      .getConfiguration('clarvis')
      .get<string>('voice.fishAudio.engine', 's2.1-pro-free');

    const key = cacheKey(utterance.text, utterance.voiceId, engine);

    // The cache file is also the file we play, so there's no temp copy to manage.
    if (!(await this.isCached(key))) {
      await this.writeCache(key, await this.render(utterance, engine));
    }

    await playFile(this.cachePath(key).fsPath);
  }

  /** Fetches audio from Fish Audio. Throws on any failure. */
  private async render(utterance: Utterance, engine: string): Promise<Uint8Array> {
    const apiKey = await this.context.secrets.get(FISH_KEY_SECRET);
    if (!apiKey) throw new Error('no Fish Audio key');

    // Bounded wait: past a few seconds, a plainer voice arriving now is the better
    // outcome, so the timeout aborts rather than letting the briefing arrive late.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(TTS_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          model: engine,
        },
        body: JSON.stringify({
          text: utterance.text,
          reference_id: utterance.voiceId,
          format: 'mp3',
          latency: 'normal',
        }),
        signal: abort.signal,
      });

      if (!response.ok) {
        // Status is logged; the key never is.
        throw new Error(`Fish Audio responded ${response.status}`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      await this.countRequest();
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------ cache

  private get cacheDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'voice');
  }

  private cachePath(key: string): vscode.Uri {
    return vscode.Uri.joinPath(this.cacheDir, `${key}.mp3`);
  }

  private async isCached(key: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(this.cachePath(key));
      this.log('voice: cache hit');
      return true;
    } catch {
      return false;
    }
  }

  private async writeCache(key: string, bytes: Uint8Array): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.cacheDir);
      await vscode.workspace.fs.writeFile(this.cachePath(key), bytes);
    } catch {
      // A cache that can't be written is a slower cache, not a broken feature.
    }
  }

  /**
   * Trims the cache to its size limit, least-recently-used first.
   *
   * Run at shutdown rather than on every write: eviction is housekeeping, and doing it
   * mid-briefing would add latency to exactly the thing it's meant to speed up.
   */
  async evictCache(): Promise<void> {
    try {
      const files = await vscode.workspace.fs.readDirectory(this.cacheDir);
      const entries: CacheEntry[] = [];

      for (const [name] of files) {
        const uri = vscode.Uri.joinPath(this.cacheDir, name);
        const stat = await vscode.workspace.fs.stat(uri);
        entries.push({ key: name, bytes: stat.size, lastUsed: stat.mtime });
      }

      for (const name of selectForEviction(entries)) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.cacheDir, name));
      }
    } catch {
      // Nothing cached yet, or storage unavailable. Neither is worth reporting.
    }
  }

  // ------------------------------------------------------------- daily cap

  private get capKey(): string {
    return `clarvis.voice.requests.${new Date().toISOString().slice(0, 10)}`;
  }

  private withinDailyCap(): boolean {
    const cap = vscode.workspace.getConfiguration('clarvis').get<number>('voice.dailyRequestCap', 200);
    const used = this.context.globalState.get<number>(this.capKey, 0);
    return used < cap;
  }

  private async countRequest(): Promise<void> {
    const used = this.context.globalState.get<number>(this.capKey, 0);
    await this.context.globalState.update(this.capKey, used + 1);
  }
}
