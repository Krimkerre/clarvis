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
      stop: () => this.stopRequested.fire(),
      models: () => this.modelsRequested.fire(),
      'choose-mode': () => this.modeRequested.fire(),
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
  private readonly stopRequested = new vscode.EventEmitter<void>();
  private readonly modelsRequested = new vscode.EventEmitter<void>();
  private readonly modeRequested = new vscode.EventEmitter<void>();
  private readonly viewReady = new vscode.EventEmitter<void>();

  /** A question typed into the chat box. */
  readonly onDidAsk = this.asked.event;
  /** The mute button above the prompt was clicked. */
  readonly onDidToggleMute = this.muteToggled.event;
  /** The Clear button was clicked. Confirmation is the host's job, not the webview's. */
  readonly onDidRequestClear = this.clearRequested.event;
  /** The History button was clicked. */
  readonly onDidRequestHistory = this.historyRequested.event;
  /** The bowtie next to the prompt was clicked. */
  readonly onDidRequestModels = this.modelsRequested.event;
  /** The mode button was clicked. */
  readonly onDidRequestMode = this.modeRequested.event;
  /** Stop was clicked while an answer was streaming. */
  readonly onDidRequestStop = this.stopRequested.event;
  /** The webview exists and can be populated. */
  readonly onDidBecomeReady = this.viewReady.event;

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
      this.audioUnlockedEmitter,
      this.asked,
      this.muteToggled,
      this.clearRequested,
      this.historyRequested,
      this.stopRequested,
      this.modelsRequested,
      this.modeRequested,
      this.viewReady
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
    const chatUi = chatMarkup(n);
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
function chatMarkup(n: string): string {
  return `<style nonce="${n}">
      /* avatar.html is a standalone demo: it centres one 320px avatar in the middle of
         the viewport. In a side panel the shape is different — face on top, history
         filling whatever is left, prompt pinned to the bottom — so its layout is
         overridden here rather than edited there (§3: the file stays untouched). */
      body { justify-content: flex-start; gap: 0; padding: 0; overflow: hidden; }
      .stage { width: 100%; height: auto; flex: 0 0 auto; padding: 10px 0 4px; }
      /* Scales with the panel instead of overflowing it — a side bar can be dragged
         much narrower than 320px, and a clipped butler looks broken rather than small. */
      svg.butler { width: clamp(130px, 62vw, 260px); height: auto; }
      .shadow { display: none; }

      /* The middle section owns the leftover height. min-height:0 is load-bearing:
         without it a flex child refuses to shrink below its content, so the transcript
         grows the page instead of scrolling and pushes the input off the bottom. */
      /* The generous bottom padding is deliberate: VS Code's notification toasts pop
         up over the bottom-right corner of the window, which is exactly where a
         bottom-pinned input sits when Clarvis is docked to the right — so the moment
         he says anything, he covers his own prompt. Sitting the input higher keeps it
         reachable while a toast is on screen. */
      .clarvis-chat { display:flex; flex-direction:column; gap:6px; padding:4px 10px 76px;
        flex: 1 1 auto; min-height: 0; width: 100%;
        font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
        color: var(--vscode-foreground); }
      .clarvis-chat-head { display:flex; align-items:center; justify-content:flex-end;
        flex: 0 0 auto; gap:6px; }
      .clarvis-mute { background:none; border:1px solid var(--vscode-widget-border, transparent);
        border-radius:4px; color: var(--vscode-foreground); cursor:pointer; padding:2px 8px;
        font-size:12px; opacity:.75; }
      .clarvis-mute:hover { opacity:1; background: var(--vscode-toolbar-hoverBackground); }
      .clarvis-mute[data-muted="true"] { opacity:1; color: var(--vscode-errorForeground); }
      /* The mode is a standing choice rather than a momentary one, so it reads as a
         label with a value rather than another action button. */
      .clarvis-mode { opacity:1; font-weight:600; }
      /* A mode that cannot edit is worth seeing without reading: the colour is the
         reassurance, the label is the detail. */
      .clarvis-mode[data-safe="true"] { color: var(--vscode-charts-green, var(--vscode-terminal-ansiGreen)); }
      #clarvis-transcript { display:flex; flex-direction:column; gap:8px;
        flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-right: 2px; }
      .clarvis-turn { line-height:1.45; white-space:pre-wrap; word-break:break-word;
        padding-left:8px; border-left:2px solid transparent; }
      .clarvis-turn .who { display:block; font-size:10px; letter-spacing:.08em;
        text-transform:uppercase; opacity:.55; margin-bottom:2px; }

      /* Two voices, told apart without shouting. Only VS Code's own theme variables,
         so this reads correctly in light, dark and high-contrast rather than in the
         one theme it was designed against.
         The user's own words sit back a little: they already know what they typed,
         and the reply is the thing worth reading. */
      .clarvis-turn.user { color: var(--vscode-descriptionForeground);
        border-left-color: var(--vscode-input-border, var(--vscode-descriptionForeground)); }
      .clarvis-turn.user .who { color: var(--vscode-descriptionForeground); }
      .clarvis-turn.clarvis { color: var(--vscode-foreground);
        border-left-color: var(--vscode-focusBorder); }
      .clarvis-turn.clarvis .who { color: var(--vscode-focusBorder); opacity:.8; }
      .clarvis-turn code { font-family: var(--vscode-editor-font-family);
        background: var(--vscode-textCodeBlock-background); padding:0 3px; border-radius:3px; }
      /* The prompt row: bowtie on the left, input taking the rest. Aligned to the
         bottom so the icon stays level with the first line as the box grows. */
      .clarvis-prompt { display:flex; align-items:flex-end; gap:6px; }
      .clarvis-bowtie { display:flex; align-items:center; justify-content:center;
        flex:0 0 auto; height:32px; width:28px; padding:0; cursor:pointer;
        background:none; border:1px solid var(--vscode-input-border, transparent);
        border-radius:4px; color: var(--vscode-foreground); opacity:.7; }
      .clarvis-bowtie:hover { opacity:1; background: var(--vscode-toolbar-hoverBackground); }
      /* Distinct from the bowtie: this one appears mid-answer and must read as an
         interruption, not another menu. */
      /* Greyed and inert while idle; unmistakable, and clickable, while he is working. */
      .clarvis-stop[data-busy="false"] { opacity:.4; cursor:default; }
      .clarvis-stop[data-busy="false"]:hover { background:none; opacity:.4; }
      .clarvis-stop[data-busy="true"] { color: var(--vscode-errorForeground); opacity:1; }
      #clarvis-input { flex:1 1 auto; box-sizing:border-box; resize:none; padding:6px 8px;
        font-family: inherit; font-size: inherit; border-radius:4px;
        color: var(--vscode-input-foreground); background: var(--vscode-input-background);
        border:1px solid var(--vscode-input-border, transparent); }
      #clarvis-input:focus { outline:1px solid var(--vscode-focusBorder); }
    </style>
    <div class="clarvis-chat">
      <div id="clarvis-transcript"></div>
      <!-- Controls sit between the history and the prompt: pinned to the bottom with
           the input, where the hand already is, rather than at the top where reaching
           them means looking away from what you were typing. -->
      <div class="clarvis-chat-head">
        <button id="clarvis-mode" class="clarvis-mute clarvis-mode"
                title="What Clarvis is allowed to do">Auto</button>
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
        <button id="clarvis-models" class="clarvis-bowtie" title="Models">
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
  const file = vscode.Uri.joinPath(extensionUri, 'media', 'chat.js');
  return `<script nonce="${n}">\n${fs.readFileSync(file.fsPath, 'utf8')}\n</script>`;
}
