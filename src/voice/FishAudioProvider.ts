import * as vscode from 'vscode';
import { ButlerViewProvider } from '../panels/ButlerViewProvider';
import { Utterance, VoiceProvider } from './VoiceProvider';
import { cacheKey, selectForEviction, CacheEntry } from './voiceCache';

/** Where the key lives: the OS keychain, never settings.json, never logged. */
export const FISH_KEY_SECRET = 'clarvis.fishAudio.key';

/** Past this, waiting is worse than a plainer voice arriving now (§4.4). */
const REQUEST_TIMEOUT_MS = 3000;

const TTS_ENDPOINT = 'https://api.fish.audio/v1/tts';

/** Nothing should hang forever waiting on audio that never finishes playing. */
const PLAYBACK_TIMEOUT_MS = 60_000;

/**
 * The voice that actually carries the character (Tier 1, §4.4).
 *
 * The request is made **here, in the extension host** — the rendered mp3 is handed to
 * the webview as a data URI. The key never crosses the CSP boundary, and the webview
 * never makes a network request of its own.
 *
 * Every failure path drops to the system voice rather than going silent, because a
 * plain voice now beats a good voice never.
 */
export class FishAudioProvider implements VoiceProvider {
  readonly id = 'fishAudio' as const;

  private nextId = 0;
  private readonly pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: ButlerViewProvider,
    private readonly log: (message: string) => void
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
   * Available only with a key, within the daily cap, **and once the webview has had a
   * user gesture** — Chromium won't play audio before that, so attempting it would
   * burn an API request on something that cannot be heard.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.panel.audioUnlocked) return false;
    const key = await this.context.secrets.get(FISH_KEY_SECRET);
    return Boolean(key) && this.withinDailyCap();
  }

  async speak(utterance: Utterance): Promise<void> {
    const engine = vscode.workspace
      .getConfiguration('clarvis')
      .get<string>('voice.fishAudio.engine', 's2.1-pro-free');

    const key = cacheKey(utterance.text, utterance.voiceId, engine);
    const cached = await this.readCache(key);
    const audio = cached ?? (await this.render(utterance, engine, key));

    await this.play(audio);
  }

  /** Fetches audio from Fish Audio and caches it. Throws on any failure. */
  private async render(utterance: Utterance, engine: string, key: string): Promise<Uint8Array> {
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
      await this.writeCache(key, bytes);
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Hands audio to the webview and waits for it to finish playing. */
  private play(bytes: Uint8Array): Promise<void> {
    const id = `f${this.nextId++}`;
    const dataUri = `data:audio/mpeg;base64,${Buffer.from(bytes).toString('base64')}`;

    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.panel.post({ type: 'speak-audio', id, dataUri });

      setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error('playback timed out'));
      }, PLAYBACK_TIMEOUT_MS);
    });
  }

  // ------------------------------------------------------------------ cache

  private get cacheDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'voice');
  }

  private async readCache(key: string): Promise<Uint8Array | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.cacheDir, `${key}.mp3`));
      this.log('voice: cache hit');
      return bytes;
    } catch {
      return undefined;
    }
  }

  private async writeCache(key: string, bytes: Uint8Array): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.cacheDir);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.cacheDir, `${key}.mp3`), bytes);
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
