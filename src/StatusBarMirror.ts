import * as vscode from 'vscode';
import { ButlerState } from './panels/ButlerViewProvider';

/**
 * Codicon shown for each avatar state. Users who keep the Clarvis panel closed
 * still get a one-glyph readout of his mood from the status bar.
 */
const STATE_GLYPHS: Record<ButlerState, string> = {
  neutral: '$(circle-outline)',
  judging: '$(eye)',
  impressed: '$(thumbsup)',
  thinking: '$(sync~spin)',
  talking: '$(comment)',
  surprised: '$(warning)',
};

/**
 * The status-bar half of Clarvis's presence: a single item that mirrors whatever
 * expression the avatar webview is currently showing.
 *
 * Owns nothing but its own item — it never decides what the state *should* be,
 * it only renders the state it's handed (AvatarController makes that decision).
 */
export class StatusBarMirror {
  private readonly item: vscode.StatusBarItem;

  constructor(initialState: ButlerState) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.render(initialState);
    this.item.show();
  }

  /** Updates the glyph and tooltip to match the given state. */
  render(state: ButlerState): void {
    this.item.text = STATE_GLYPHS[state];
    this.item.tooltip = `Clarvis: ${state}`;
  }

  /** Hands the underlying item to context.subscriptions for automatic teardown. */
  get disposable(): vscode.Disposable {
    return this.item;
  }
}
