import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * Runs inside a real extension host (via @vscode/test-electron), unlike the rest of
 * the suite. Only for behavior a pure function genuinely can't check: does the
 * extension activate against the real VS Code API without throwing, and does every
 * command `package.json` promises actually get registered.
 */
suite('extension activation', () => {
  test('activates without throwing', async () => {
    const ext = vscode.extensions.getExtension('Krimkerre.clarvis');
    assert.ok(ext, 'extension not found by id — check publisher/name in package.json');
    await ext.activate();
    assert.ok(ext.isActive);
  });

  test('every command declared in package.json is registered', async () => {
    const ext = vscode.extensions.getExtension('Krimkerre.clarvis')!;
    await ext.activate();

    const declared: string[] = (ext.packageJSON.contributes?.commands ?? []).map(
      (c: { command: string }) => c.command
    );
    const registered = new Set(await vscode.commands.getCommands(true));

    const missing = declared.filter((command) => !registered.has(command));
    assert.deepEqual(missing, [], `declared but never registered: ${missing.join(', ')}`);
  });
});
