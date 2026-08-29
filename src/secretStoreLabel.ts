/**
 * What to call the place a key is kept, given the editor it is kept in.
 *
 * `CLARVIS.md` §7.2: *"Do not assume code-server's `context.secrets` is backed
 * by the macOS Keychain. Verify its storage behaviour. If it is file- or
 * server-backed, document that clearly and label it differently from desktop
 * VS Code — never identically unless proven equivalent."*
 *
 * It was verified, on code-server 4.135.0, and it is not equivalent. There is no
 * OS keyring anywhere in the install — `Keychain`, `gnome-keyring`, `libsecret`
 * and `safeStorage` all return nothing. `context.secrets` resolves to
 * `LocalStorageSecretStorageProvider`: the value lives in the **browser's**
 * localStorage, AES-GCM-256 encrypted under a key that is the XOR of two halves.
 * One half sits in cleartext as the first 32 bytes of the same blob it protects.
 * The other is a world-readable file at `<user-data-dir>/serve-web-key-half`,
 * handed to any client that passes code-server's password. That is obfuscation
 * at rest, not confidentiality, and calling it a keychain would be a claim about
 * the operating system that nothing here is making.
 *
 * `vscode`-free so the fast suite can reach it, which is the same reason the
 * voice fallback's decision was extracted. The one thing that must not happen is
 * a string that is right on the desktop and wrong everywhere else, and only a
 * test catches that.
 */

/**
 * Where a key goes, in the words shown to the person putting it there.
 *
 * `remoteName` is `undefined` in desktop VS Code and set whenever the extension
 * host is remote — which covers code-server, Remote-SSH, dev containers and WSL.
 * That is deliberately broader than code-server: on every one of them the host
 * is not the machine whose keychain the desktop wording promises, so the desktop
 * sentence is wrong on all of them and this one is right on all of them.
 */
export function secretStoreLabel(remoteName: string | undefined): string {
  return remoteName ? "this editor's encrypted secret storage" : 'the system keychain';
}

/**
 * The same fact with the caveat attached, for the places that have room for it.
 *
 * Used where the user is being asked to hand over a key for the first time —
 * the one moment where the difference could change their mind about doing it.
 */
export function secretStoreDetail(remoteName: string | undefined): string {
  if (!remoteName) return 'the system keychain, never a settings file, never the log';
  return (
    "this editor's own encrypted storage rather than an OS keychain — never a " +
    'settings file, never the log, but weaker than the desktop app'
  );
}
