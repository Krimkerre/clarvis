import * as vscode from 'vscode';
import * as fs from 'fs';

export const BUTLER_STATES = ['neutral', 'judging', 'impressed', 'thinking', 'talking', 'surprised'] as const;
export type ButlerState = (typeof BUTLER_STATES)[number];

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

export class ButlerViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'clarvis.butler';
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onState: (state: ButlerState) => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'state' && BUTLER_STATES.includes(msg.name)) {
        this.onState(msg.name);
      }
      // click/chat wiring lands in M7 — no-op for now
    });
  }

  setState(state: ButlerState): void {
    this.view?.webview.postMessage({ type: 'state', name: state });
  }

  private buildHtml(webview: vscode.Webview): string {
    const avatarUri = vscode.Uri.joinPath(this.extensionUri, 'media', 'avatar.html');
    let html = fs.readFileSync(avatarUri.fsPath, 'utf8');
    const n = nonce();

    // strip the demo controls/quip UI — the real host drives state via postMessage
    html = html.replace(/<div class="controls"[\s\S]*?<\/div>\n\n<p class="quip"[\s\S]*?<\/p>/, '');

    const bridge = `<script nonce="${n}">
      const vscode = acquireVsCodeApi();
      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'state' && typeof setState === 'function') {
          setState(msg.name);
        }
      });
    </script>`;

    html = html.replace(
      '<meta charset="utf-8">',
      `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">`
    );
    html = html.replace('</body>', `${bridge}</body>`);
    // the inline <script> that defines setState() also needs the nonce to run under our CSP
    html = html.replace('<script>\nconst svg', `<script nonce="${n}">\nconst svg`);

    return html;
  }
}
