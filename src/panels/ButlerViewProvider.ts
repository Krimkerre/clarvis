import * as vscode from 'vscode';
import * as fs from 'fs';

// The six expressions avatar.html's own setState() understands. Kept here (not
// just inferred from the HTML) so the rest of the extension gets type-checked
// state names instead of arbitrary strings.
export const BUTLER_STATES = ['neutral', 'judging', 'impressed', 'thinking', 'talking', 'surprised'] as const;
export type ButlerState = (typeof BUTLER_STATES)[number];

/**
 * Narrows an arbitrary string to a ButlerState.
 *
 * Used at the extension's trust boundaries — the QuickPick (which is typed as plain
 * `string`) and messages arriving from the webview — so neither needs a cast that
 * would merely assert correctness rather than check it.
 */
export function isButlerState(value: unknown): value is ButlerState {
  return typeof value === 'string' && (BUTLER_STATES as readonly string[]).includes(value);
}

// Random per-load token required by the webview's CSP (script-src 'nonce-...').
// A fresh nonce each time buildHtml() runs means a script tag from a stale/cached
// render can never execute against the current page.
function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

// Renders the butler avatar inside a WebviewView (the panel registered under the
// "clarvis" activity-bar container). This class owns the one-way bridge from the
// extension host to the webview (setState) and the one-way bridge back
// (onDidReceiveMessage) — avatar.html's own JS never changes, this just wraps it.
export class ButlerViewProvider implements vscode.WebviewViewProvider {
  // Must match the "id" of the view declared under contributes.views in package.json.
  public static readonly viewId = 'clarvis.butler';
  private view?: vscode.WebviewView;

  // Fires when the webview reports a state change of its own (nothing does this yet —
  // reserved for M7's click/chat wiring, where the avatar might react to being clicked
  // without the extension host initiating it).
  //
  // An event rather than a constructor callback so the provider doesn't need to know
  // its consumer at construction time. That keeps wiring order flexible in
  // extension.ts, where the consumer (AvatarController) needs the provider itself.
  private readonly stateReported = new vscode.EventEmitter<ButlerState>();
  readonly onDidReportState: vscode.Event<ButlerState> = this.stateReported.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  // VS Code calls this once when the view becomes visible for the first time (or
  // again after being fully disposed — collapsing the panel does NOT dispose it,
  // since retainContextWhenHidden is set at registration).
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      // Restrict local file loads to media/ — nothing else in the extension or the
      // workspace is reachable from inside the webview.
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    // Messages coming FROM the webview. Only state reports are handled today;
    // anything else (future click/chat payloads) is silently ignored rather than
    // erroring, so an older webview build never crashes a newer extension host.
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'state' && isButlerState(msg.name)) {
        this.stateReported.fire(msg.name);
        return;
      }
      if (msg?.type === 'speech-ended' || msg?.type === 'speech-error') {
        this.speechFinished.fire({ id: msg.id, error: msg.reason });
        return;
      }
      if (msg?.type === 'system-voices') {
        this.systemVoicesReported.fire(msg.voices ?? []);
        return;
      }
      if (msg?.type === 'audio-probe') {
        this.audioProbed.fire(msg);
        return;
      }
      if (msg?.type === 'audio-unlocked') {
        this.audioUnlocked = true;
        this.audioUnlockedEmitter.fire();
        return;
      }
      if (msg?.type === 'audio-locked') {
        // Activation lost (webview re-created). Stops the next utterance spending an
        // API request on audio that cannot play.
        this.audioUnlocked = false;
      }
      // chat input wiring lands in M8
    });
  }

  private readonly speechFinished = new vscode.EventEmitter<{ id: string; error?: string }>();
  private readonly systemVoicesReported = new vscode.EventEmitter<{ name: string; lang: string }[]>();
  private readonly audioProbed = new vscode.EventEmitter<Record<string, unknown>>();
  private readonly audioUnlockedEmitter = new vscode.EventEmitter<void>();

  /**
   * Whether the webview has had a user gesture, which Chromium requires before it
   * will play audio. Until then, rendered speech cannot play at all.
   */
  audioUnlocked = false;
  readonly onDidUnlockAudio = this.audioUnlockedEmitter.event;

  /** Fires when an utterance finishes, or fails. Drives `talking` → `neutral`. */
  readonly onDidFinishSpeech = this.speechFinished.event;
  readonly onDidReportSystemVoices = this.systemVoicesReported.event;
  /** What the audio APIs look like inside the webview — reported once on load. */
  readonly onDidProbeAudio = this.audioProbed.event;

  /** Sends a message into the webview. No-ops if the panel has never been opened. */
  post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  /** Hands the event emitters to context.subscriptions for automatic teardown. */
  get disposable(): vscode.Disposable {
    return vscode.Disposable.from(
      this.stateReported,
      this.speechFinished,
      this.systemVoicesReported,
      this.audioProbed,
      this.audioUnlockedEmitter
    );
  }

  // The extension host's side of the bridge: push a state change INTO the webview.
  // No-ops if the view hasn't been resolved yet (e.g. panel never opened this
  // session) — postMessage would just be dropped silently by VS Code anyway.
  setState(state: ButlerState): void {
    this.view?.webview.postMessage({ type: 'state', name: state });
  }

  // Loads avatar.html unmodified from disk and adapts it to run inside a VS Code
  // webview: strips the standalone demo's manual controls (the real host drives
  // state programmatically), injects the CSP + a nonce, and wires up a small
  // bridge script that forwards postMessage state changes into avatar.html's own
  // setState() function — which is otherwise completely untouched.
  private buildHtml(webview: vscode.Webview): string {
    const avatarUri = vscode.Uri.joinPath(this.extensionUri, 'media', 'avatar.html');
    let html = fs.readFileSync(avatarUri.fsPath, 'utf8');
    const n = nonce();

    // strip the demo controls/quip UI — the real host drives state via postMessage
    html = html.replace(/<div class="controls"[\s\S]*?<\/div>\n\n<p class="quip"[\s\S]*?<\/p>/, '');

    // Listens for {type:'state', name} messages from the extension host and calls
    // straight into avatar.html's own global setState() — the entire integration
    // surface is that one function call.
    const bridge = `<script nonce="${n}">
      const vscode = acquireVsCodeApi();

      // Chromium blocks audio playback until this document has received a user
      // gesture. speechSynthesis is exempt, which is why the system voice works from
      // the first second and rendered audio does not. One click anywhere in the panel
      // grants it for the rest of the session.
      let audioUnlocked = false;
      const unlockAudio = () => {
        if (audioUnlocked) return;
        audioUnlocked = true;
        vscode.postMessage({ type: 'audio-unlocked' });
      };
      window.addEventListener('pointerdown', unlockAudio, { once: true });
      window.addEventListener('keydown', unlockAudio, { once: true });

      // Reports what the audio APIs actually look like in here. M1 probed
      // SpeechRecognition (input) and found it blocked, but never checked
      // speechSynthesis (output) — different API, no permission, and Tier 0 depends
      // entirely on it, so it's worth knowing rather than assuming.
      vscode.postMessage({
        type: 'audio-probe',
        speechSynthesis: typeof window.speechSynthesis !== 'undefined',
        audioElement: typeof window.Audio !== 'undefined',
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;

        if (msg.type === 'state' && typeof setState === 'function') {
          setState(msg.name);
          return;
        }

        // Speak via the OS voice. The mouth and the sound are the same component, so
        // they can't drift apart: playback events drive the avatar, not a timer.
        if (msg.type === 'speak-system') {
          try {
            const utterance = new SpeechSynthesisUtterance(msg.text);
            if (msg.voiceId) {
              const match = speechSynthesis.getVoices().find(v => v.name === msg.voiceId);
              if (match) utterance.voice = match;
            }
            utterance.onend = () => vscode.postMessage({ type: 'speech-ended', id: msg.id });
            utterance.onerror = (e) => vscode.postMessage({
              type: 'speech-error', id: msg.id, reason: (e && e.error) || 'unknown'
            });
            speechSynthesis.cancel();
            speechSynthesis.speak(utterance);
          } catch (err) {
            vscode.postMessage({ type: 'speech-error', id: msg.id, reason: String(err) });
          }
          return;
        }

        // Play pre-rendered audio handed over as a data URI. The webview never fetches
        // anything itself, so the API key never crosses the CSP boundary.
        if (msg.type === 'speak-audio') {
          try {
            const audio = new Audio(msg.dataUri);
            audio.onended = () => vscode.postMessage({ type: 'speech-ended', id: msg.id });
            audio.onerror = () => vscode.postMessage({
              type: 'speech-error', id: msg.id, reason: 'audio element error'
            });
            // play() rejects when autoplay policy blocks it. Swallowing that rejection
            // turns a clear NotAllowedError into a silent 60s timeout, so it is
            // reported rather than ignored.
            audio.play().catch((err) => {
              // A rejection here means this document's user activation is gone — the
              // webview can be re-created (panel moved, editor reloaded), and the
              // grant does not survive it. Re-arm the listeners so the next click
              // restores audio instead of leaving it permanently broken.
              if (err && err.name === 'NotAllowedError') {
                audioUnlocked = false;
                vscode.postMessage({ type: 'audio-locked' });
                window.addEventListener('pointerdown', unlockAudio, { once: true });
                window.addEventListener('keydown', unlockAudio, { once: true });
              }
              vscode.postMessage({
                type: 'speech-error',
                id: msg.id,
                reason: 'play() rejected: ' + (err && err.name ? err.name : String(err)),
              });
            });
          } catch (err) {
            vscode.postMessage({ type: 'speech-error', id: msg.id, reason: String(err) });
          }
          return;
        }

        if (msg.type === 'list-system-voices') {
          const voices = speechSynthesis.getVoices().map(v => ({ name: v.name, lang: v.lang }));
          vscode.postMessage({ type: 'system-voices', voices });
        }
      });
    </script>`;

    // Lock the page down: no network, no inline scripts without the nonce, styles
    // allowed only inline or from the webview's own approved source.
    //
    // `media-src data:` is what lets rendered speech play. Without it `default-src
    // 'none'` silently blocks the audio element, and Tier 1 fails with nothing more
    // useful than "playback failed" — while `speechSynthesis` keeps working, because
    // it isn't a fetched resource. `data:` only: the webview still cannot reach the
    // network, so the key stays on the host side.
    html = html.replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; media-src data:;">`
    );
    html = html.replace('</body>', `${bridge}</body>`);
    // the inline <script> that defines setState() also needs the nonce to run under our CSP
    html = html.replace('<script>\nconst svg', `<script nonce="${n}">\nconst svg`);

    return html;
  }
}
