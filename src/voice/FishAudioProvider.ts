import * as vscode from 'vscode';
import { Utterance, VoiceProvider } from './VoiceProvider';
import { cacheKey, selectForEviction, CacheEntry } from './voiceCache';
import { fishUnavailableReason } from './fallbackNotice';
import { capKeyFor, withinCap } from './dailyCap';
import { playFile } from './nativePlayer';
import { ButlerViewProvider } from '../panels/ButlerViewProvider';
import { audioDestination, audioDestinationReason } from './audioDestination';
import { WebviewSpeech } from './WebviewSpeech';
import { renderTimeout } from './renderTimeout';

/** Where the key lives: the OS keychain, never settings.json, never logged. */
export const FISH_KEY_SECRET = 'clarvis.fishAudio.key';

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
 * **Both of those are reasons to prefer the host, and neither survives the host not
 * being the listener's machine.** Under code-server the extension host is a server, so
 * a spawned player performs to an empty room — Stage 9 graded that a `FAIL`. Where the
 * workbench is a browser, or the extension host is remote, the rendered mp3 goes to the
 * webview as a data URI instead and comes out of the listener's own speakers. See
 * `audioDestination` for the rule and why it takes two axes.
 *
 * The autoplay constraint above is *real* there and is not solved by this: a briefing
 * before the first click will be refused by the browser. What changes is that the
 * refusal is reported — the webview answers `audio-locked` and re-arms on the next
 * gesture — rather than the audio playing correctly to nobody.
 *
 * Every failure path drops to the system voice rather than going silent, because a
 * plain voice now beats a good voice never.
 */
export class FishAudioProvider implements VoiceProvider {
  readonly id = 'fishAudio' as const;

  /** Built only where the panel exists; absent means host playback is the only path. */
  private readonly speech?: WebviewSpeech;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    panel?: ButlerViewProvider
  ) {
    this.speech = panel ? new WebviewSpeech(panel) : undefined;
  }

  /**
   * Available with a key, within the daily cap. No gesture needed any more, and no
   * panel either — playback doesn't go through the webview.
   */
  /**
   * Whether a key is stored at all.
   *
   * Distinct from `isAvailable()`, which also weighs the daily cap and anything else
   * that makes a request unwise right now. "Has the user set this up?" and "should I
   * call the API this second?" are different questions, and the first-run offer needs
   * the first one.
   */
  async hasKey(): Promise<boolean> {
    return Boolean(await this.context.secrets.get(FISH_KEY_SECRET));
  }

  async isAvailable(): Promise<boolean> {
    const key = await this.context.secrets.get(FISH_KEY_SECRET);
    return Boolean(key) && this.withinDailyCap();
  }

  /**
   * Which of the two reasons applies, named rather than merged.
   *
   * They call for opposite responses — one wants a key entered, the other wants
   * the user to wait or raise the cap — so a single "unavailable" would send
   * half the people who see it looking in the wrong place.
   */
  async unavailableReason(): Promise<string> {
    return fishUnavailableReason(await this.hasKey(), this.withinDailyCap());
  }

  async speak(utterance: Utterance): Promise<void> {
    const engine = vscode.workspace
      .getConfiguration('clarvis')
      .get<string>('voice.fishAudio.engine', 's2.1-pro-free');

    const key = cacheKey(utterance.text, utterance.voiceId, engine);

    // The cache file is also the file we play, so there's no temp copy to manage.
    if (!(await this.isCached(key))) {
      await this.writeCache(key, await this.render(utterance, engine));
      await this.noteInIndex(key, utterance, engine);
    }

    this.log(`voice: playing ${key}`);
    await this.play(key);
  }

  /**
   * Play the cached mp3 wherever the listener actually is.
   *
   * Falls back to the host when there is no panel to send to — an utterance
   * spoken before the view is resolved, which is the launch briefing's ordinary
   * case on desktop. On a split host that fallback plays to the server, which is
   * the defect this method exists for, so it says so rather than failing quietly.
   */
  private async play(key: string): Promise<void> {
    const destination = audioDestination(vscode.env.uiKind, vscode.env.remoteName);
    const reason = audioDestinationReason(vscode.env.uiKind, vscode.env.remoteName);

    if (destination === 'host') {
      await playFile(this.cachePath(key).fsPath, process.platform, this.log);
      return;
    }

    if (!this.speech) {
      this.log(
        `voice: ${reason}, but no panel is open to play through — ` +
          'falling back to the host, where the listener may not be'
      );
      await playFile(this.cachePath(key).fsPath, process.platform, this.log);
      return;
    }

    // Read as bytes and handed over inline. The webview never fetches from the
    // extension's storage: a `vscode-resource` URL would work for a file on
    // disk and not for one the host holds, and a data URI needs no CSP
    // exception beyond the `media-src data:` the panel already declares.
    const audio = await vscode.workspace.fs.readFile(this.cachePath(key));
    this.log(`voice: playing through the webview — ${reason}`);
    await this.speech.request((id) => ({
      type: 'speak-audio',
      id,
      dataUri: `data:audio/mpeg;base64,${Buffer.from(audio).toString('base64')}`,
    }));
  }

  /** Fetches audio from Fish Audio. Throws on any failure. */
  private async render(utterance: Utterance, engine: string): Promise<Uint8Array> {
    const apiKey = await this.context.secrets.get(FISH_KEY_SECRET);
    if (!apiKey) throw new Error('no Fish Audio key');

    // Bounded wait: past a few seconds, a plainer voice arriving now is the better
    // outcome, so the timeout aborts rather than letting the briefing arrive late.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), renderTimeout(utterance.text.length));
    const startedAt = Date.now();

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
          // **Speed, at a cost nobody can hear.** `normal` is Fish's quality-first
          // mode and was costing 1.5–3s before a word came out — long enough that a
          // one-line remark landed after the moment it was about. `balanced` is
          // their low-latency mode; on a dry aside about a build, the difference is
          // inaudible and the wait is not.
          latency: 'balanced',
          // 128kbps is for music. Speech at 64 halves the transfer with no audible
          // loss through a laptop speaker, which is where all of this is heard.
          mp3_bitrate: 64,
        }),
        signal: abort.signal,
      });

      if (!response.ok) {
        // Status is logged; the key never is.
        throw new Error(`Fish Audio responded ${response.status}`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      this.log(`voice: rendered ${bytes.length} bytes in ${Date.now() - startedAt}ms (${engine})`);
      await this.countRequest();
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The user's own voice models.
   *
   * Returns nothing without a key, or if the request fails — an empty list simply
   * means that section doesn't appear in the picker, which is a normal state rather
   * than an error worth interrupting anyone about.
   */
  async listOwnVoices(): Promise<{ id: string; title: string }[]> {
    const apiKey = await this.context.secrets.get(FISH_KEY_SECRET);
    if (!apiKey) return [];

    try {
      const response = await fetch('https://api.fish.audio/model?self=true', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) return [];

      const body = (await response.json()) as { items?: { _id?: string; id?: string; title?: string }[] };
      return (body.items ?? [])
        .map((item) => ({ id: item._id ?? item.id ?? '', title: item.title ?? 'untitled' }))
        .filter((item) => item.id);
    } catch {
      return [];
    }
  }

  /**
   * Checks a pasted voice id by rendering with it.
   *
   * Costs one short request, which is the point: a bad id fails here rather than
   * silently mid-briefing days later. The rendered result is cached like anything
   * else, so the check doubles as the first preview.
   */
  async validateVoice(voiceId: string): Promise<boolean> {
    try {
      await this.speak({ text: 'Testing.', voiceId });
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ cache

  private get cacheDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'voice');
  }

  private cachePath(key: string): vscode.Uri {
    return vscode.Uri.joinPath(this.cacheDir, `${key}.mp3`);
  }

  /** Where the cache lives, for the reveal command. */
  get cacheLocation(): vscode.Uri {
    return this.cacheDir;
  }

  /**
   * A human-readable index alongside the audio.
   *
   * The files are named by hash, which makes the cache impossible to inspect — and
   * "why did switching voice change nothing?" is exactly the sort of question you
   * answer by looking. Kept best-effort: if the index is missing or stale the audio
   * still plays, since the mp3 filenames are the actual source of truth.
   */
  private async noteInIndex(key: string, utterance: Utterance, engine: string): Promise<void> {
    const indexUri = vscode.Uri.joinPath(this.cacheDir, 'index.json');
    let index: Record<string, unknown> = {};

    try {
      const bytes = await vscode.workspace.fs.readFile(indexUri);
      index = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      // No index yet, or unreadable — start a fresh one.
    }

    index[`${key}.mp3`] = {
      text: utterance.text,
      voice: utterance.voiceId ?? 'default',
      engine,
      renderedAt: new Date().toISOString(),
    };

    try {
      await vscode.workspace.fs.writeFile(
        indexUri,
        new TextEncoder().encode(JSON.stringify(index, null, 2))
      );
    } catch {
      // Inspectability is a nicety; never worth failing an utterance over.
    }
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
        if (!name.endsWith('.mp3')) continue; // never evict the index itself
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
    return capKeyFor(new Date());
  }

  private withinDailyCap(): boolean {
    const cap = vscode.workspace.getConfiguration('clarvis').get<number>('voice.dailyRequestCap', 200);
    const used = this.context.globalState.get<number>(this.capKey, 0);
    return withinCap(used, cap);
  }

  private async countRequest(): Promise<void> {
    const used = this.context.globalState.get<number>(this.capKey, 0);
    await this.context.globalState.update(this.capKey, used + 1);
  }
}
