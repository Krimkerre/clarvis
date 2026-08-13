import * as vscode from 'vscode';
import { PlanningIO } from './PlanningIO';

/**
 * `PlanningIO` over input boxes, QuickPicks and modals — the command-palette route.
 *
 * Behaviourally identical to what `Interview.ts` and its siblings called directly
 * before the interface existed, including `ignoreFocusOut` on every prompt (an
 * interview that vanishes when you click away is an interview you have to restart).
 */
export class VsCodeIO implements PlanningIO {
  async askText(prompt: string, placeholder?: string, prefill?: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
      prompt,
      placeHolder: placeholder,
      // `value`, not `placeHolder`: one is editable text, the other is grey ghosting
      // that vanishes the moment you type. Modify was offering the second and calling
      // it an edit.
      value: prefill,
      ignoreFocusOut: true,
    });
  }

  async askChoice(prompt: string, items: { label: string; detail?: string }[]): Promise<string | undefined> {
    const picked = await vscode.window.showQuickPick(items, { placeHolder: prompt, ignoreFocusOut: true });
    return picked?.label;
  }

  async confirm(title: string, detail: string, buttons: string[]): Promise<string | undefined> {
    return vscode.window.showInformationMessage(title, { modal: true, detail }, ...buttons);
  }

  async say(text: string): Promise<void> {
    void vscode.window.showInformationMessage(text);
  }

  async showDocument(text: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
    await vscode.window.showTextDocument(document, { preview: false });
  }
}
