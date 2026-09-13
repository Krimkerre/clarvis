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
      // **Unchanged text is not written again (M9i).** The draft is shown after every
      // decision now, usually unchanged, and replacing a document with itself still throws
      // away the cursor of someone who is in the middle of editing it.
      if (this.text() !== text) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(existing.uri, new vscode.Range(new vscode.Position(0, 0), lastPosition(existing)), text);
        await vscode.workspace.applyEdit(edit);
      }
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
   * What the draft says now, edits included — or `undefined` once it has been closed (M9i).
   *
   * Line endings come back as `\n` on every platform: the draft was written with them, and an
   * editor handing back `\r\n` would make a draft nobody touched read as one somebody edited.
   */
  text(): string | undefined {
    const document = this.document;
    return document && !document.isClosed ? document.getText().replace(/\r\n/g, '\n') : undefined;
  }

  /**
   * Closes the draft, if it is still open, without asking to save it.
   *
   * **Emptied first.** An untitled document with text in it is dirty, and closing a
   * dirty tab asks whether to save — this comment used to say closing the tab skipped
   * that. Found live, 11 September 2026: a file named `# Clockwork.md`, the draft's first
   * heading, appeared beside `plan.md` the moment the plan was approved, identical to it.
   * An empty untitled document is not dirty, so nothing is asked and nothing is saved.
   */
  async close(): Promise<void> {
    const document = this.document;
    this.document = undefined;
    if (!document || document.isClosed) return;

    const empty = new vscode.WorkspaceEdit();
    empty.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), lastPosition(document)), '');
    await vscode.workspace.applyEdit(empty).then(undefined, () => false);

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
