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
      if (msg?.type === 'ask' && typeof msg.text === 'string') {
        this.asked.fire(msg.text);
        return;
      }
      if (msg?.type === 'toggle-mute') {
        this.muteToggled.fire();
        return;
      }
      if (msg?.type === 'clear-chat') {
        this.clearRequested.fire();
        return;
      }
      if (msg?.type === 'show-history') {
        this.historyRequested.fire();
        return;
      }
      if (msg?.type === 'stop') {
        this.stopRequested.fire();
        return;
      }
      if (msg?.type === 'models') {
        this.modelsRequested.fire();
        return;
      }
      if (msg?.type === 'choose-mode') {
        this.modeRequested.fire();
        return;
      }
    });

    // A freshly resolved view is blank: it has no idea what was said before it
    // existed. Announcing that lets the host replay the stored thread, so moving
    // the panel or reloading doesn't look like the conversation was wiped.
    this.viewReady.fire();
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
    const chatUi = `<style nonce="${n}">
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
      .clarvis-stop { color: var(--vscode-errorForeground); opacity:1; }
      .clarvis-stop[hidden] { display:none; }
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
        <!-- The second Stop. The one by the prompt is where your hand is while typing;
             this one is where your eye is while *watching* a run, which is the moment
             you actually want it. Both hidden until there is something to stop, so the
             row does not carry a dead control. -->
        <button id="clarvis-stop-top" class="clarvis-mute clarvis-stop" hidden
                title="Stop what Clarvis is doing">Stop</button>
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
        <button id="clarvis-stop" class="clarvis-bowtie clarvis-stop" hidden
                title="Stop the answer in progress">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>`;

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

      const transcript = document.getElementById('clarvis-transcript');
      const input = document.getElementById('clarvis-input');
      const muteButton = document.getElementById('clarvis-mute');

      // Renders one turn. Only inline backtick spans become <code>; everything else is
      // inserted as a text node, so a filename or an error message containing markup
      // can never become markup. Replies are generated locally today, but this same
      // box renders model output in M8b — sanitising it later would be too late.
      // The turn currently streaming, and its text so far.
      let streaming = null;
      let streamed = '';

      const addTurn = (speaker, text) => {
        const row = document.createElement('div');
        // The speaker is a class rather than inline styling, so the colours live in
        // one place with the rest of the theme variables.
        row.className = 'clarvis-turn ' + (speaker === 'user' ? 'user' : 'clarvis');

        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = speaker === 'user' ? 'You' : 'Clarvis';
        row.appendChild(who);

        renderInto(row, text);

        transcript.appendChild(row);
        transcript.scrollTop = transcript.scrollHeight;
        // Returned so a streamed reply can keep re-rendering the same row.
        return row;
      };

      // Replaces a turn's body, keeping its speaker label. Text nodes only, plus
      // <code> for backtick spans — never innerHTML, because model output lands here.
      const renderInto = (row, text) => {
        while (row.childNodes.length > 1) row.removeChild(row.lastChild);

        String(text).split('\\u0060').forEach((part, i) => {
          // Odd indices sat between a pair of backticks.
          if (i % 2 === 1) {
            const code = document.createElement('code');
            code.textContent = part;
            row.appendChild(code);
          } else {
            row.appendChild(document.createTextNode(part));
          }
        });
      };

      const send = () => {
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        vscode.postMessage({ type: 'ask', text });
      };

      // Enter sends, Shift+Enter makes a new line — the convention every chat box
      // uses, and getting it backwards is instantly infuriating.
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      });

      muteButton.addEventListener('click', () => vscode.postMessage({ type: 'toggle-mute' }));
      // The host asks for confirmation before wiping — a webview button sitting next
      // to one people click constantly is a misclick waiting to happen.
      document.getElementById('clarvis-clear')
        .addEventListener('click', () => vscode.postMessage({ type: 'clear-chat' }));
      document.getElementById('clarvis-history')
        .addEventListener('click', () => vscode.postMessage({ type: 'show-history' }));

      const modelsButton = document.getElementById('clarvis-models');
      modelsButton.addEventListener('click', () => vscode.postMessage({ type: 'models' }));

      const modeButton = document.getElementById('clarvis-mode');
      modeButton.addEventListener('click', () => vscode.postMessage({ type: 'choose-mode' }));

      // Two buttons, one behaviour. Kept as a list rather than two variables so a third
      // could not be added and quietly left out of the show/hide below.
      const stopButtons = [
        document.getElementById('clarvis-stop'),
        document.getElementById('clarvis-stop-top'),
      ];
      const showStop = (visible) => stopButtons.forEach((button) => { button.hidden = !visible; });
      stopButtons.forEach((button) =>
        button.addEventListener('click', () => vscode.postMessage({ type: 'stop' }))
      );

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;

        if (msg.type === 'chat-turn') {
          addTurn(msg.speaker, msg.text);
          return;
        }

        // A streamed reply is one turn that grows, not many turns. Appending to the
        // same node keeps inline code spans working across fragment boundaries, which
        // rendering each fragment separately would break.
        if (msg.type === 'chat-stream-start') {
          streaming = addTurn('clarvis', '');
          streamed = '';
          showStop(true);
          return;
        }

        if (msg.type === 'chat-stream') {
          // Defensive: if the start frame was missed, adopt this fragment into a new
          // row rather than dropping it. Requiring a live row here once swallowed an
          // entire reply: the text arrived, was spoken aloud, and never appeared in
          // the transcript. (No backticks in this comment - the whole script is a
          // template literal, and one would end it.)
          if (!streaming) {
            streaming = addTurn('clarvis', '');
            streamed = '';
            showStop(true);
          }

          streamed += msg.text;
          renderInto(streaming, streamed);
          transcript.scrollTop = transcript.scrollHeight;
          return;
        }

        if (msg.type === 'chat-stream-end') {
          streaming = null;
          showStop(false);
          return;
        }

        // Full replay, used when the view is (re-)created — the webview is blank
        // after a panel move, but the conversation isn't.
        if (msg.type === 'chat-thread') {
          transcript.replaceChildren();
          for (const t of msg.turns || []) addTurn(t.speaker, t.text);
          return;
        }

        if (msg.type === 'mode') {
          modeButton.textContent = msg.short;
          modeButton.dataset.safe = String(msg.safe);
          modeButton.title = msg.detail;
          return;
        }

        if (msg.type === 'model-info') {
          modelsButton.title = msg.text;
          return;
        }

        if (msg.type === 'mute') {
          muteButton.dataset.muted = String(msg.muted);
          muteButton.textContent = msg.muted ? 'Muted' : 'Mute';
          return;
        }

        // Mute has to reach speechSynthesis too: it lives in here, not in the host,
        // so killing the native player alone would leave the OS voice talking.
        if (msg.type === 'stop-speech') {
          try { speechSynthesis.cancel(); } catch (err) { /* nothing to cancel */ }
          return;
        }

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
    html = html.replace('</body>', `${chatUi}${bridge}</body>`);
    // the inline <script> that defines setState() also needs the nonce to run under our CSP
    html = html.replace('<script>\nconst svg', `<script nonce="${n}">\nconst svg`);

    return html;
  }
}
