import * as vscode from 'vscode';

/**
 * The one editor tab the interview writes into.
 *
 * **Found live at the end of the first checklist project: five tabs for one plan.**
 * The verdict summary opened an untitled document, every refinement round opened
 * another, `markdown.showPreview` doubled each of them, and the approved `plan.md`
 * arrived alongside the lot. Two of the tabs were called `# Photochrono`, because an
 * untitled document takes its name from its first heading — so the pair that looked
 * identical were a scratch draft and a rendered view of that same scratch draft,
 * neither of them the file.
 *
 * One document, reused. Later drafts replace its contents through a `WorkspaceEdit`
 * rather than opening a second, so the tab stays where the reader put it, and the
 * scroll position of a document being read repeatedly is worth something. Closed the
 * moment the real `plan.md` exists — a draft kept next to the file it became is a
 * chance to edit the wrong one.
 */
export class DraftDocument {
  private document?: vscode.TextDocument;

  /** Shows `text`, in the same tab as last time when there is one. */
  async show(text: string): Promise<void> {
    const existing = this.document;

    if (existing && !existing.isClosed) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(existing.uri, new vscode.Range(new vscode.Position(0, 0), lastPosition(existing)), text);
      await vscode.workspace.applyEdit(edit);
      // Brought forward rather than reopened: the tab already exists, and this is
      // what makes a redraw visible when the reader is looking at something else.
      await vscode.window.showTextDocument(existing, { preview: false, viewColumn: vscode.ViewColumn.One });
      return;
    }

    // No `markdown.showPreview`. Rendered markdown reads better and costs a second
    // tab with the same name as the first, which is the confusion this class exists
    // to remove — and the draft is read once, briefly, to be approved.
    const document = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
    this.document = document;
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
  }

  /**
   * Closes the draft, if it is still open.
   *
   * An untitled document with unsaved content would normally prompt to save on
   * close; closing its *tab* rather than the document skips that, which is right —
   * nobody wants to be asked whether to keep a draft of the file they just approved.
   */
  async close(): Promise<void> {
    const document = this.document;
    this.document = undefined;
    if (!document || document.isClosed) return;

    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const mine = tabs.filter((tab) => {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      return input?.uri?.toString() === document.uri.toString();
    });

    // Best effort throughout: a tab that has already gone is the outcome we wanted.
    await vscode.window.tabGroups.close(mine, true).then(undefined, () => undefined);
  }
}

function lastPosition(document: vscode.TextDocument): vscode.Position {
  return document.lineCount > 0 ? document.lineAt(document.lineCount - 1).range.end : new vscode.Position(0, 0);
}
