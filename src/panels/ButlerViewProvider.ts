import * as vscode from 'vscode';
import * as fs from 'fs';
import { ButlerState, isButlerState } from '../butlerState';

// The state union lives in butlerState.ts, which imports nothing — anything needing to
// validate a state name should not have to pull the extension host in to do it. Both
// are re-exported so existing imports of this module keep working.
export { BUTLER_STATES, isButlerState } from '../butlerState';
export type { ButlerState } from '../butlerState';

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

    // Messages coming FROM the webview.
    //
    // A table rather than a chain of eighteen `if`s. It was the most complex thing in
    // the project by some distance, and every branch was identical in shape — read a
    // type, fire an emitter. Anything unrecognised is ignored rather than throwing, so
    // an older webview build never crashes a newer extension host.
    webviewView.webview.onDidReceiveMessage((msg) => this.dispatch(msg));

    // A freshly resolved view is blank: it has no idea what was said before it
    // existed. Announcing that lets the host replay the stored thread, so moving
    // the panel or reloading doesn't look like the conversation was wiped.
    this.viewReady.fire();
  }

  /**
   * What each message from the webview does.
   *
   * Built once per instance rather than per message: the emitters are stable, and a
   * fresh object on every keystroke would be litter for no gain.
   */
  private get handlers(): Record<string, (msg: any) => void> {
    return {
      state: (msg) => isButlerState(msg.name) && this.stateReported.fire(msg.name),
      'speech-ended': (msg) => this.speechFinished.fire({ id: msg.id, error: msg.reason }),
      'speech-error': (msg) => this.speechFinished.fire({ id: msg.id, error: msg.reason }),
      'system-voices': (msg) => this.systemVoicesReported.fire(msg.voices ?? []),
      'audio-probe': (msg) => this.audioProbed.fire(msg),
      // The answer to "may this webview open a microphone", which only an
      // actual attempt can give — see `probeCapture`.
      'capture-probe': (msg) => this.captureProbed.fire(msg),
      recorded: (msg) => this.recorded.fire(msg),
      'audio-unlocked': () => {
        this.audioUnlocked = true;
        this.audioUnlockedEmitter.fire();
      },
      // Activation lost (webview re-created). Stops the next utterance spending an API
      // request on audio that cannot play.
      'audio-locked': () => {
        this.audioUnlocked = false;
      },
      ask: (msg) => typeof msg.text === 'string' && this.asked.fire(msg.text),
      'toggle-mute': () => this.muteToggled.fire(),
      'clear-chat': () => this.clearRequested.fire(),
      'show-history': () => this.historyRequested.fire(),
      'show-output': () => this.outputRequested.fire(),
      stop: () => this.stopRequested.fire(),
      // API config, in the bowtie's fold-out: the same message the bowtie itself sent before M15 C2b+.
      models: () => this.modelsRequested.fire(),
      // The fold-out opened, and its Codex section wants filling; then the owner's pick in it.
      'bowtie-menu': () => this.bowtieMenuOpened.fire(),
      'codex-choice': (msg) => this.codexChosen.fire({ model: msg.model, effort: msg.effort }),
      'choose-mode': () => this.modeRequested.fire(),
      // Every 10 s while the panel is open (M15 C2a): a Codex task followed from here counts it attached.
      'panel-ping': () => this.pinged.fire(),
    };
  }

  private dispatch(msg: any): void {
    const handler = typeof msg?.type === 'string' ? this.handlers[msg.type] : undefined;
    handler?.(msg);
  }

  private readonly asked = new vscode.EventEmitter<string>();
  private readonly muteToggled = new vscode.EventEmitter<void>();
  private readonly clearRequested = new vscode.EventEmitter<void>();
  private readonly historyRequested = new vscode.EventEmitter<void>();
  /** Reveal the terminal every command and tool call already writes to. */
  private readonly outputRequested = new vscode.EventEmitter<void>();
  private readonly stopRequested = new vscode.EventEmitter<void>();
  private readonly modelsRequested = new vscode.EventEmitter<void>();
  private readonly bowtieMenuOpened = new vscode.EventEmitter<void>();
  private readonly codexChosen = new vscode.EventEmitter<{ model: unknown; effort: unknown }>();
  private readonly modeRequested = new vscode.EventEmitter<void>();
  private readonly viewReady = new vscode.EventEmitter<void>();
  private readonly pinged = new vscode.EventEmitter<void>();

  /** A question typed into the chat box. */
  readonly onDidAsk = this.asked.event;
  /** The mute button above the prompt was clicked. */
  readonly onDidToggleMute = this.muteToggled.event;
  /** The Clear button was clicked. Confirmation is the host's job, not the webview's. */
  readonly onDidRequestClear = this.clearRequested.event;
  /** The History button was clicked. */
  readonly onDidRequestHistory = this.historyRequested.event;
  readonly onDidRequestOutput = this.outputRequested.event;
  /** API config was clicked, in the menu behind the bowtie next to the prompt. */
  readonly onDidRequestModels = this.modelsRequested.event;
  /** The bowtie's menu opened: its Codex section is read from RAVIS now, and never while it's closed. */
  readonly onDidOpenBowtieMenu = this.bowtieMenuOpened.event;
  /** A Codex model or effort was picked in the bowtie's menu. Unchecked: the host holds it to what RAVIS lists. */
  readonly onDidChooseCodex = this.codexChosen.event;
  /** The mode button was clicked. */
  readonly onDidRequestMode = this.modeRequested.event;
  /** Stop was clicked while an answer was streaming. */
  readonly onDidRequestStop = this.stopRequested.event;
  /** The webview exists and can be populated. */
  readonly onDidBecomeReady = this.viewReady.event;
  /** The panel's 10-second ping: it is open (M15 C2a; design §3.5.4). */
  readonly onDidPing = this.pinged.event;

  private readonly speechFinished = new vscode.EventEmitter<{ id: string; error?: string }>();
  private readonly systemVoicesReported = new vscode.EventEmitter<{ name: string; lang: string }[]>();
  private readonly audioProbed = new vscode.EventEmitter<Record<string, unknown>>();
  private readonly captureProbed = new vscode.EventEmitter<Record<string, unknown>>();
  private readonly recorded = new vscode.EventEmitter<Record<string, unknown>>();
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
  readonly onDidProbeCapture = this.captureProbed.event;
  readonly onDidRecord = this.recorded.event;

  /**
   * Ask the webview whether it can open a microphone, and wait for the answer.
   *
   * **Only an attempt settles it.** A webview is a cross-origin iframe, and
   * `getUserMedia` there is refused unless the parent document grants
   * `allow="microphone"` on the iframe element — which belongs to the workbench,
   * not to Clarvis. The load-time probe reports the API as present and the
   * *policy* as `unknown`, because Firefox does not expose
   * `document.permissionsPolicy`. Calling it is the only way to find out, and it
   * may prompt, which is why this is reached from a command the operator ran
   * rather than from panel load.
   */
  /**
   * Record from the *listener's* microphone, through the panel.
   *
   * The input half of the route `speak-audio` opened for output. On a browser or
   * remote host the extension host's own recorder captures the server's
   * microphone, which is the wrong machine; this asks the document that is
   * actually next to the person.
   *
   * Returns the clip as a WAV, built in the webview so every existing reader —
   * `peakDbfs` above all — works on it unchanged.
   */
  recordThroughPanel(seconds: number, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    const id = `r${this.nextRecordingId++}`;
    return new Promise((resolve) => {
      const done = this.onDidRecord((result) => {
        if (result.id !== id) return;
        clearTimeout(timer);
        done.dispose();
        resolve(result);
      });
      const timer = setTimeout(() => {
        done.dispose();
        resolve({ ok: false, error: 'no answer from the panel' });
      }, timeoutMs);
      this.post({ type: 'record-audio', id, seconds });
    });
  }

  private nextRecordingId = 0;

  probeCapture(timeoutMs = 30_000): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const done = this.onDidProbeCapture((result) => {
        clearTimeout(timer);
        done.dispose();
        resolve(result);
      });
      const timer = setTimeout(() => {
        done.dispose();
        resolve({ ok: false, error: 'no answer from the panel' });
      }, timeoutMs);
      this.post({ type: 'probe-capture' });
    });
  }

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
      this.captureProbed,
      this.recorded,
      this.audioUnlockedEmitter,
      this.asked,
      this.muteToggled,
      this.clearRequested,
      this.historyRequested,
      this.outputRequested,
      this.stopRequested,
      this.modelsRequested,
      this.bowtieMenuOpened,
      this.codexChosen,
      this.modeRequested,
      this.viewReady,
      this.pinged
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


    // The chat surface, under the avatar in the same webview (§3 — one panel, so the
    // face and the conversation can never end up docked in different places).
    // VS Code's own theme variables are used throughout: hardcoded colours look
    // correct in exactly one theme and wrong in every other.
    const chatUi = chatMarkup(n, this.extensionUri);
    const bridge = chatBridge(n, this.extensionUri);
    html = html.replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; media-src data:;">`
    );
    html = html.replace('</body>', `${chatUi}${bridge}</body>`);
    // the inline <script> that defines setState() also needs the nonce to run under our CSP
    html = html.replace('<script>\nconst svg', `<script nonce="${n}">\nconst svg`);

    return html;
  }
}


/**
 * The chat surface, under the avatar in the same webview.
 *
 * §3 — one panel, so the face and the conversation can never end up docked in
 * different places. VS Code's own theme variables throughout: hardcoded colours look
 * correct in exactly one theme and wrong in every other.
 *
 * Lifted out of `buildHtml` when the linter put that function at 360 lines. It was
 * three documents in one: a stylesheet, a page, and a script, none of which had
 * anything to say to the others beyond the nonce.
 */
function chatMarkup(n: string, extensionUri: vscode.Uri): string {
  return `<style nonce="${n}">
${fs.readFileSync(vscode.Uri.joinPath(extensionUri, 'media', 'chat.css').fsPath, 'utf8')}
    </style>
    <div class="clarvis-chat">
      <div id="clarvis-transcript"></div>
      <!-- Controls sit between the history and the prompt: pinned to the bottom with
           the input, where the hand already is, rather than at the top where reaching
           them means looking away from what you were typing. -->
      <div id="clarvis-progress" class="clarvis-progress" data-active="false">
        <span class="count"></span><span class="step"></span>
        <span class="bar"><i style="width:0%"></i></span>
      </div>
      <div class="clarvis-chat-head">
        <button id="clarvis-mode" class="clarvis-mute clarvis-mode"
                title="What Clarvis is allowed to do">Auto</button>
        <button id="clarvis-output" class="clarvis-mute"
                title="Every command and tool call, as it runs.">Output</button>
        <button id="clarvis-history" class="clarvis-mute"
                title="Earlier conversations from this workspace.">History</button>
        <button id="clarvis-clear" class="clarvis-mute"
                title="Delete the conversation. There is no undo.">Clear</button>
        <button id="clarvis-mute" class="clarvis-mute" data-muted="false"
                title="Silence him. Resets when the window reloads.">Mute</button>
      </div>
      <div class="clarvis-prompt">
        <!-- Inline SVG rather than a file: the CSP is default-src 'none' with no
             img-src, and one path is cheaper than opening that up. -->
        <!-- The bowtie's fold-out (M15 C2b+): filled by media/bowtieMenu.js, anchored to this row. -->
        <div id="clarvis-bowtie-menu" class="clarvis-menu" role="dialog" aria-label="Models and Codex" hidden></div>
        <button id="clarvis-models" class="clarvis-bowtie" title="Models" aria-controls="clarvis-bowtie-menu">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path fill="currentColor" d="M2 6l8 4.2v3.6L2 18V6zm20 0v12l-8-4.2v-3.6L22 6zM12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/>
          </svg>
        </button>
        <textarea id="clarvis-input" rows="2" placeholder="Ask. Enter sends."></textarea>
        <!-- Sits with the prompt, not with the controls above: stopping is something
             you do *while typing was the last thing you did*, so it belongs where the
             hand already is. Hidden until there is something to stop. -->
        <button id="clarvis-stop" class="clarvis-bowtie clarvis-stop" data-busy="false" disabled
                title="Stop what Clarvis is doing">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>`;

    // Listens for {type:'state', name} messages from the extension host and calls
    // straight into avatar.html's own global setState() — the entire integration
    // surface is that one function call.
}

/**
 * Everything that runs *inside* the webview.
 *
 * Kept as one string rather than a file because the CSP is `default-src 'none'` and a
 * nonce has to be stamped into it per render — a separate script file would need its
 * own URI and buy nothing.
 */
/**
 * Everything that runs inside the webview, read from `media/chat.js`.
 *
 * **A file, not a template literal.** It was 240 lines of JavaScript inside a `...`
 * string, where a single backtick in a comment ends the script early — which happened
 * twice during M8, each time leaving a panel that looked fine and did nothing. Nothing
 * in it interpolates, so the only thing the host adds is the nonce on the tag.
 */
function chatBridge(n: string, extensionUri: vscode.Uri): string {
  // The bowtie's menu first: `chat.js` creates it (M15 C2b+). Both under the same nonce, neither interpolated.
  const menu = vscode.Uri.joinPath(extensionUri, 'media', 'bowtieMenu.js');
  const file = vscode.Uri.joinPath(extensionUri, 'media', 'chat.js');
  return [menu, file].map((script) => `<script nonce="${n}">\n${fs.readFileSync(script.fsPath, 'utf8')}\n</script>`).join('');
}
