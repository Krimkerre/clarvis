# code-server compatibility matrix — Stage 9 spike

`ECOSYSTEM_RUNBOOK.md` §6.2 Stage 9 says **"Test, do not assume."** This is the result of
doing that, once, on one machine, on 29 August 2026. Every cell carries what was actually
observed. Where nothing was observed the cell says `NOT_TESTED` and names the action that
would settle it — the runbook's rule is that unsupported combinations are never offered as
supported, and a cell graded from reading rather than running is exactly how that happens.

**The combination tested.** code-server 4.135.0 ("with Code 1.135.0"), standalone install,
macOS arm64, Clarvis 0.0.1, served over plain HTTP on loopback, **direct** — never through
the NERVIS proxy, which is why every proxied cell below is `NOT_TESTED`. Browser axis:
Firefox only, and only for the webview question.

**This is not a support statement.** Stage 9's exit asks that install, activate, chat,
agent, stream, stop, tool, gate, workspace boundary, SecretStorage, persistence and
teardown all pass on at least one declared combination. Several of those are still
untested, so no combination is declared supported yet.

## Where it stands

| | |
|---|---|
| PASS | 18 |
| PASS_WITH_LIMITATION | 8 |
| FAIL | 3 |
| NOT_TESTED | 18 |

**How to read the confidence.** 7 cells were
settled by running Clarvis inside code-server; the rest were graded by reading code-server's
own shipped source and Clarvis's, then put to a second reader told to downgrade anything
resting on inference. That second pass downgraded nothing, and a cap left 11 of 20 optimistic
cells unchallenged — so the PASS column is softer than its count suggests, and the three
`FAIL`s and eight limitations are the load-bearing part of this document.

## Manifest, entrypoints and activation

### `PASS` — manifest engine (`engines.vscode: ^1.93.0`) under Code 1.135.0

Not inferred — I ran code-server's own validator. Extracted the version functions verbatim from ~/.local/lib/code-server-4.135.0/lib/vscode/out/server-main.js (minified `m6`/`Mw`/`Aw`/`g6` = isVersionValid/parseVersion/normalizeVersion/isValidVersion, regex `/^(\^|>=)?((\d+)|x)\.((\d+)|x)\.((\d+)|x)(\-.*)?$/`) into /private/tmp/claude-501/-Users-mathias-Documents-coding/52ed4eb1-abc9-40e7-92a7-de4333b757d2/scratchpad/ver.js and executed them. Each field is `parseInt(...,10)`, so comparison is numeric, not lexicographic: `^1.93.0` normalizes to {majorBase:1,majorMustEqual:true,minorBase:93,minorMustEqual:false,patchBase:0,patchMustEqual:false,isMinimum:false}; g6('1.135.0',undefined,'^1.93.0') === true; control g6('1.9.0',undefined,'^1.93.0') === false and g6('1.135.0',undefined,'^1.136.0') === false, which is what proves the ordering is numeric. lib/vscode/product.json version = "1.135.0". Runtime confirmation: krimkerre.clarvis-0.0.1 is present in ~/.local/share/code-server/extensions/extensions.json with metadata.source="vsix", and loaded (see activation cells).

### `PASS` — `extensionKind` (absent from the manifest) — ui vs workspace placement

code-server's own shipped workbench is the authority. ~/.local/lib/code-server-4.135.0/lib/vscode/out/vs/workbench/workbench.web.main.internal.js (byte offset ~4310037) contains verbatim: `deduceExtensionKind(e){if(e.main)return e.browser?Vt?["workspace","web"]:["workspace"]:["workspace"];if(e.browser)return["web"];...}`. Clarvis has `main` and no `browser`, so the deduced kind is `["workspace"]` — never `ui`, never `web`. Nothing overrides it: `getConfiguredExtensionKind` consults user setting -> product.json -> manifest, and product.json has no `extensionKind` map (0 keys) while the manifest has no `extensionKind` field. vsce agrees: the installed .vsixmanifest carries `Microsoft.VisualStudio.Code.ExtensionKind` Value="workspace". Runtime confirmation, not just source: Clarvis's activation is recorded in exthost's *remote* host log (~/.local/share/code-server/logs/20260829T132709/exthost1/remoteexthost.log and exthost2/remoteexthost.log), and `ps` shows those hosts are `.../lib/node .../out/bootstrap-fork --type=extensionHost --transformURIs --useHostProxy=false` (pids 93638, 98028) — a real server-side Node process, not a browser web worker. So Clarvis lands on the side where child_process exists.

### `PASS` — main/browser entrypoints

/Users/mathias/Documents/coding/clarvis/package.json declares `"main": "./dist/extension.js"` and has no `browser` key at all — so there is no web-worker entrypoint that could be selected or fail. The installed copy ~/.local/share/code-server/extensions/krimkerre.clarvis-0.0.1/dist/extension.js exists at 326,033 bytes. Scanning that bundle for `require("...")` yields only vscode, fs, path, crypto, child_process, fs/promises, os, http — node builtins and the vscode module, zero third-party runtime deps, consistent with the esbuild config described. A Node server host resolves all of those.

### `PASS` — activation events — does code-server fire `onStartupFinished`?

~/.local/share/code-server/logs/20260829T132709/exthost2/remoteexthost.log, lines 1-10: host pid 98028 starts 13:33:44.218; `Eager extensions activated` 13:33:44.607; then `ExtensionService#_doActivateExtension vscode.debug-auto-launch ... activationEvent: 'onStartupFinished'`, `vscode.merge-conflict ... 'onStartupFinished'`, and `ExtensionService#_doActivateExtension Krimkerre.clarvis, startup: false, activationEvent: 'onStartupFinished'` at 13:33:44.608 — Clarvis in the same startup-finished sweep as the built-ins, on a plain window open. exthost1/remoteexthost.log line 14 shows the same event for Clarvis in a second, independent host (pid 93638). Two hosts, two firings.

### `PASS` · observed — extension activation — does `activate()` complete under the server host?

Settled live. A real git workspace was opened in code-server 4.135.0 and `logs/20260829T140149/exthost1/Krimkerre.clarvis/clarvis.log` records `Clarvis build 2026-08-29T11:54:59.712Z` / `Clarvis activated.` / `bridge: registered with NERVIS as f726d98a… on port 58557`, with zero error lines in the sibling `remoteexthost.log`. The static pass could only observe an empty window.

### `PASS` — extension activation — VS Code API surface used at activation, 1.93 -> 1.135

Scoped to the activation path only. The 19 distinct `vscode.*` surfaces in /Users/mathias/Documents/coding/clarvis/src/extension.ts are all long-stable: commands.registerCommand/executeCommand, window.registerWebviewViewProvider, window.show{Information,Warning,Error}Message/showInputBox/showQuickPick/showTextDocument/withProgress, ProgressLocation.Notification, workspace.getConfiguration/onDidChangeConfiguration/fs/workspaceFolders/openTextDocument, Uri.file/joinPath, env.clipboard. src/watch/wireBusyTracker.ts subscribes six event APIs at activation time — tasks.onDidStartTask, tasks.onDidEndTaskProcess, debug.onDidStartDebugSession, debug.onDidTerminateDebugSession, window.onDidStartTerminalShellExecution, window.onDidEndTerminalShellExecution (the last two are the 1.93-era stabilizations, the plausible risk). All of those names are present in code-server's shipped ~/.local/lib/code-server-4.135.0/lib/vscode/out/vs/workbench/api/node/extensionHostProcess.js (grep -c: onDidStartTerminalShellExecution 2, onDidEndTerminalShellExecution 3, onDidStartTask 2, onDidEndTaskProcess 2, registerWebviewViewProvider 1). The installed .vsixmanifest declares `EnabledApiProposals` empty, so no proposed API is required. And nothing threw at activation. Nothing used at activation is removed or deprecated in 1.135.


## Node, processes, terminal and the command sandbox

### `PASS_WITH_LIMITATION` — Command sandbox mechanism and profile (sandbox-exec, outside Electron)

Nothing in the sandbox is Electron-dependent by construction: sandboxProfile.ts is pure text + argv (macProfile builds SBPL from a workspace path, os.homedir()/os.tmpdir() caches and a network flag; sandboxProfile.ts:119 returns `sandbox-exec -f <profile> /bin/sh -c <command>`), and sandbox.ts imports only os/path/fs/child_process. I ran Clarvis's OWN compiled `macProfile`/`sandboxArgv` (/Users/mathias/Documents/coding/clarvis/out/agent/tools/sandboxProfile.js) from a plain `node` process on this Mac via the scratchpad script sbtest.js. Results: `which sandbox-exec` → /usr/bin/sandbox-exec; write inside the fake workspace → EXIT 0 'hi'; `echo bad > $HOME/…probe.txt` → rc=1 and the file does not exist afterwards; `>/dev/null` → DEVNULL_OK; pipe + `&&` → PIPE_OK; with `network:'denied'` curl to RAVIS 127.0.0.1:8731 → http_code 000, rc=7; with `network:'allowed'` the identical curl → http_code 404, rc=0. So the profile confines writes and toggles network correctly on this host.

**Limitation.** Proven only from an ordinary Node process I spawned, NOT from inside code-server's extension host, and not through Clarvis's own spawn path. Two unverified links remain: (a) sandbox.ts:52 detects the sandbox with `execFile('which', [binary])`, which depends on the extension host's inherited PATH — code-server builds that env as `{...process.env, ...resolveShellEnv(...)}` plus a prepended remote-cli dir (~/.local/lib/code-server-4.135.0/lib/vscode/out/server-main.js, buildUserEnvironment for the `--type=extensionHost` fork), so it should contain /usr/bin, but this was not observed, and if `which` fails Clarvis does not error — it silently falls through to the 'no sandbox here, run unconfined?' prompt; (b) the profile is written to `context.globalStorageUri.fsPath` with node `fs`, and while `context.logUri.fsPath` demonstrably resolves to a real server-side path under code-server (ClarvisLog.ts:34-35 wrote the clarvis.log files found above), globalStorageUri itself was never exercised.

### `PASS_WITH_LIMITATION` — Login-shell / TTY / desktop-environment assumptions in shell-outs

No login shell and no TTY is assumed on the command path. Confined: sandboxProfile.ts:119 spawns `/bin/sh -c <command>` explicitly. Unconfined: commandTools.ts:90-94 uses `spawn(command, {cwd: root, shell: true, stdio:['ignore','pipe','pipe']})` — Node's POSIX `shell:true` is `/bin/sh -c`, non-login and non-interactive, with pipes rather than a pty. No call site passes an `env:` override (`grep -rn 'process.env' src/` finds only logTailing.ts:19's Windows APPDATA), so the child inherits the extension host's environment exactly as it does on desktop. The macOS profile explicitly allows `/dev/tty*` and `/dev/fd/*` writes (sandboxProfile.ts:94) rather than requiring a terminal. All other child_process users are plain execFile with no shell: gitBinary.ts:20 `git --version`, lmStudioTune.ts:116/177/210 `lms`, logTailing.ts:28/102 `find`/`tail`. sandbox.ts:197's `vscode.window.createTerminal('Install bubblewrap')` + sendText is the one real shell terminal, and it is unreachable here — mayRunUnconfined only calls it when `process.platform === 'linux'`, and this host is darwin with /usr/bin/sandbox-exec present.

**Limitation.** One genuine desktop assumption, in a diagnostic feature rather than the agent: logTailing.ts:11-22 `getLogDir()` hardcodes `~/Library/Application Support/Code/logs` on darwin and shells `find` at it (logTailing.ts:28) then `tail -f` (logTailing.ts:102). Under code-server the logs live at ~/.local/share/code-server/logs. That desktop directory does exist on this Mac (`ls -d` succeeds, desktop VS Code is installed), so `clarvis.startLogTailing` will not error — it will silently tail a different editor's logs. Separately, PATH: `shell:true` gives a non-login /bin/sh, so any command relying on shims added by ~/.zshrc (nvm, pyenv, rbenv) resolves only if the extension host's inherited PATH already carries them; that inheritance is unverified and is the main thing that could differ between a code-server started from a terminal and a desktop VS Code started from Finder.

### `NOT_TESTED` — child_process and the command sandbox (end to end, inside code-server)

No command has ever been run by Clarvis under this code-server. AgentRunner.ts:812-819 logs a `sandbox: …` line unconditionally on every gated command (confined, escaped, or unconfined), and sandbox.ts:40 logs `sandbox: using <x> on <platform>` the first time a sandbox is probed. All three code-server clarvis.log files (~/.local/share/code-server/logs/20260829T132709/exthost{1,2,3}/Krimkerre.clarvis/clarvis.log) contain only activation, branch-flow, briefing, bridge and voice lines — not one `sandbox:` line. Nor could a command have run: `ls ~/.local/share/code-server/User/workspaceStorage` = `empty-window` only, and runCommand throws `There is no folder open, so there is nowhere to run that.` (commandTools.ts:53) without a root. `~/.local/share/code-server/User/globalStorage` likewise has no `krimkerre.clarvis` dir, so the `<globalStorage>/sandbox/commands.sb` profile (AgentRunner.ts:785, sandbox.ts:141-143) was never written.

**To settle.** Open a real folder in the code-server window at 127.0.0.1:8741 (not an empty window), ask the agent to run something trivial that writes, e.g. `pwd && touch inside.txt && touch "$HOME/escape.txt"`, then read ~/.local/share/code-server/logs/<latest>/exthost*/Krimkerre.clarvis/clarvis.log for `sandbox: using sandbox-exec on darwin` and `sandbox: confined by sandbox-exec`, confirm `<globalStorage>/krimkerre.clarvis/sandbox/commands.sb` was created, and confirm $HOME/escape.txt does not exist. Repeat once with a network-gated command (dependency install) to exercise `network: 'allowed'`.

### `NOT_TESTED` — terminal shell execution — Clarvis's AgentTerminal (its own output terminal)

AgentTerminal (commandTools.ts:139) is a UI API: `vscode.window.createTerminal({name:'Clarvis', pty:{...}})` at commandTools.ts:153, i.e. an extension-owned Pseudoterminal whose rendering lives in the browser workbench. It was never instantiated in any code-server session — the only caller of `announce()` is AgentRunner.ts:808 in the command path, and no command ran (see the child_process cell). Source facts that bound the blast radius: command output reaches the model from `child_process.spawn` pipes (commandTools.ts:89-94), not from the terminal, so a terminal that renders badly cannot corrupt the agent's view of a command; the pty is display-only with `handleInput: () => undefined`, so nothing is typed back into a shell; and code-server's extension host does implement the API (`grep -c 'ExtHostPseudoterminal|createExtensionTerminal|onDidWrite' out/vs/workbench/api/node/extensionHostProcess.js` → 3). The real coupling is ordering: AgentRunner.ts:808 calls `this.terminal.announce(command)` BEFORE AgentRunner.ts:822 calls runCommand, so if createTerminal/show throws in the browser-hosted workbench the command never runs at all.

**To settle.** With a folder open in the code-server tab, run one agent command and watch whether a terminal named 'Clarvis' appears in the browser panel, whether the banner 'Clarvis — command output. Nothing typed here runs.' renders, whether streamed output appears with correct CRLF line endings, and whether `show(true)` reveals the panel without stealing focus from the webview. Then reload the browser tab mid-run to see whether the pty survives a workbench reconnect.

### `NOT_TESTED` — terminal shell execution — shell-integration events (onDidStartTerminalShellExecution)

src/watch/wireBusyTracker.ts:95,105 subscribes to `vscode.window.onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution` to drive BusyTracker. The API exists in this host (`grep -c onDidStartTerminalShellExecution out/vs/workbench/api/node/extensionHostProcess.js` → 2) and the engine constraint is satisfied (package.json engines vscode ^1.93.0; code-server 4.135.0 'with Code 1.135.0'). code-server also ships a working darwin-arm64 pty backend (lib/vscode/node_modules/node-pty/build/Release/pty.node). But these events fire only when VS Code's shell-integration script is successfully injected into the user's shell, which is a runtime property of the browser-side terminal plus the server shell, and no integrated terminal was ever opened in these sessions. wireBusyTracker's own comment records the API is 'silently absent otherwise (no error, just no events)' — a failure here is invisible, which is exactly why it cannot be graded from source.

**To settle.** In the code-server tab open an integrated terminal (zsh on this host), run `sleep 5`, and check that Clarvis reports busy then idle around it. Also confirm the phantom empty-commandLine startup execution is filtered (wireBusyTracker.ts:99-101) rather than pinning Clarvis busy for the session.

### `NOT_TESTED` — tasks

The only task usage is wireBusyTracker.ts:81 `vscode.tasks.onDidStartTask` and :87 `onDidEndTaskProcess`, feeding BusyTracker; Clarvis never creates, resolves or executes a Task (no ShellExecution/ProcessExecution/executeTask/fetchTasks/TaskProvider anywhere in src/, and package.json `contributes` has only viewsContainers, views, commands, configuration — no taskDefinitions). The API is present in code-server's extension host (`grep -c 'onDidStartTask|onDidEndTaskProcess' out/vs/workbench/api/node/extensionHostProcess.js` → 2). Nothing was exercised: the sessions ran in an empty window (workspaceStorage = `empty-window`), so there was no tasks.json and no task could run.

**To settle.** Open a folder with a tasks.json in code-server, run a task and cancel another, and verify Clarvis's busy state starts and ends once per task rather than twice — the double-count that wireBusyTracker's isTaskExecution heuristic (wireBusyTracker.ts:63-66) exists to prevent. That heuristic keys off `event.terminal.name === ''` for a brand-new task terminal, exactly the kind of timing/naming detail a browser-hosted terminal could order differently.

### `PASS` — Node and native dependencies

`unzip -l /Users/mathias/Documents/coding/clarvis/clarvis.vsix` = 12 files total; `find . -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' \)` over the unpacked archive returns nothing, and `file` on every entry gives only XML/JSON/text/PNG plus one `extension/dist/extension.js` (ASCII). Packaged manifest has `dependencies: undefined`, no `extensionKind`, no `browser`, `main: ./dist/extension.js`. Every `require()` in the shipped bundle: vscode(46), path(11), child_process(7), fs/promises(6), fs(6), crypto(6), os(3), http(1) — Node builtins only; zero hits for `process.dlopen`/`bindings(`/`node-gyp`/`*.node`. Empirically it loads: ~/.local/share/code-server/logs/20260829T132709/exthost{1,2,3}/remoteexthost.log each show `ExtensionService#_doActivateExtension Krimkerre.clarvis`, and the matching Krimkerre.clarvis/clarvis.log files show `Clarvis activated.` with no module errors (`grep -i 'error|failed|cannot find module' exthost*/remoteexthost.log` → empty).


## Paths, storage and SecretStorage

### `FAIL` — §7.2 labelling vs desktop VS Code (must not be labelled identically unless proven equivalent)

It is not equivalent (see the encryption cell: browser localStorage + a 0644 server key file, versus the macOS Keychain), yet Clarvis labels it identically in 12 places, including user-facing text: src/extension.ts:619 'Key stored, in the system keychain where it belongs.'; src/model/modelPickers.ts:475 '... key stored in the system keychain.' and :367 'API keys — stored in your OS keychain, one per provider'; src/voice/firstRun.ts:54 '... stored in your keychain'; src/chat/ChatActions.ts:307 'Yours go in the keychain, never a settings file.'; plus code comments at src/ClarvisLog.ts:22, src/extension.ts:552, src/voice/FishAudioProvider.ts:8, src/model/ModelService.ts:151, src/model/modelPickers.ts:412; and the shipped manual, media/MANUAL.md:254, :408 and :617 ('Keys live in your OS keychain').

**Limitation.** This is a documentation/UX defect, not a functional one — the store still works. But §7.2 says never label it identically unless proven equivalent, and the shipped strings assert Keychain semantics that do not exist under code-server. Any code-server support statement must carry a different label until these strings are made host-aware (e.g. branch on vscode.env.remoteName / uiKind).


**Resolved 29 Aug, commit `330feb1`.** The store was never the problem; the labelling was. Every user-facing string now resolves from `vscode.env.remoteName` — which also covers Remote-SSH, dev containers and WSL, where the desktop sentence is wrong for the same reason. A source-scanning test fails if a new string asserts a keychain unconditionally.

### `PASS_WITH_LIMITATION` — §7.1 desktop paths and URI schemes

Clarvis runs in the *server* (remote) extension host: installed manifest /Users/mathias/.local/share/code-server/extensions/krimkerre.clarvis-0.0.1/package.json has main=./dist/extension.js, no `browser`, no `extensionKind` -> defaults to workspace kind. That host is real Node on the same Mac (ps pid 93638/98028, bootstrap-fork --type=extensionHost --transformURIs). Measured proof that a context URI yields a usable native macOS path: /Users/mathias/Documents/coding/clarvis/src/extension.ts:76 passes context.logUri to ClarvisLog, and src/ClarvisLog.ts:34-35 does raw fs.mkdirSync(storageUri.fsPath) + fs.appendFileSync — and the file exists with real Clarvis lines at /Users/mathias/.local/share/code-server/logs/20260829T132709/exthost1/Krimkerre.clarvis/clarvis.log. Source for how these URIs are built: ~/.local/lib/code-server-4.135.0/lib/vscode/out/vs/workbench/api/node/extensionHostProcess.js, ExtensionStoragePaths.globalValue = joinPath(env.globalStorageHome, id.toLowerCase()).

**Limitation.** Only context.logUri is proven. No workspace folder was ever opened (User/workspaceStorage contains only `empty-window`), so every folder.uri-derived path and both vscode.Uri.file(target) calls in src/agent/tools/editTools.ts:48,78 are unexercised. Two desktop-shell URI calls have no verified browser behaviour: vscode.env.openExternal(Uri.parse(...)) at src/voice/firstRun.ts:85 and executeCommand('revealFileInOS', fish.cacheLocation) at src/extension.ts:645.

### `PASS_WITH_LIMITATION` — §7.1 SecretStorage encryption and availability

Available and non-in-memory. In lib/vscode/out/vs/code/browser/workbench/workbench.js the bootstrap computes t=(location.pathname+'/mint-key') — always truthy — so `secretStorageProvider: e.remoteAuthority && !t ? void 0 : new Cco(i)` always constructs LocalStorageSecretStorageProvider (storageKey 'secrets.provider', type 'persisted'), which overrides get/set/delete and bypasses BaseSecretStorageService's IEncryptionService path entirely. Crypto is ServerKeyedAESCrypto (supported() = !!crypto.subtle; true on http://127.0.0.1 as a secure context): AES-GCM-256, blob = [32-byte clientKey][12-byte IV][ciphertext], key = clientKey XOR serverKey, serverKey = POST <base>/mint-key. code-server serves that from out/node/routes/vscode.js:193, reading or creating crypto.randomBytes(32) at `<user-data-dir>/serve-web-key-half` — confirmed present, 32 bytes, mode 0644, at /Users/mathias/.local/share/code-server/serve-web-key-half. No OS keyring exists anywhere in the install: across code-server's out/ and the bundled VS Code out/, `Keychain`, `gnome-keyring`, `libsecret` and `safeStorage` return 0 hits; the only `keytar` hits are a deprecated CLI-flag alias (`use-inmemory-secretstorage` deprecates `disable-keytar`).

**Limitation.** The encryption is obfuscation at rest, not confidentiality. The client key half sits in cleartext as the first 32 bytes of the same localStorage blob it protects, and the server half is a world-readable plain file handed to any client that passes code-server's password auth. Anyone with the browser profile plus a code-server session — or the browser profile plus that one file — recovers every secret. Nothing is bound to the macOS user login, an ACL, or the Secure Enclave, and secrets are per-origin, so every workspace served from 127.0.0.1:8080 shares one store.

### `PASS_WITH_LIMITATION` — §7.2 'RAVIS integration moves cloud keys out' — code today or aspirational?

Partly real, entirely elective. Clarvis writes exactly four secret keys today: clarvis.model.key.anthropic, clarvis.model.key.openai, clarvis.model.key.openrouter (src/model/ModelService.ts:15 keySecretId + :153 store, reachable only for needsKey:true providers — src/model/modelPickers.ts:361 filters on spec.needsKey and :57 gates on it) and clarvis.fishAudio.key (src/voice/FishAudioProvider.ts:9, stored at src/extension.ts:617). RAVIS is consumed through the `custom` provider, which declares needsKey:false (src/model/providers.ts:102-110), so a RAVIS-only user genuinely stores no cloud key. clarvis.model.key.{lmstudio,ollama,custom} are read on every request (ModelService.ts:171) but there is no code path that writes them.

**Limitation.** Nothing in the code moves, migrates, deprecates or hides the three cloud key paths — Anthropic is still PROVIDERS[0] and the ModelService.spec() fallback, and 'Clarvis: Manage API Keys' offers all three. So the exposure reduction is a user choice, not a structural guarantee, and the voice key (clarvis.fishAudio.key) remains in code-server's browser-backed store regardless of RAVIS — exactly the residual case ECOSYSTEM_RUNBOOK §6.2 Stage 9 names.

### `NOT_TESTED` — §7.1 workspace FS (vscode.workspace.fs, containment)

No workspace folder has ever been opened in this code-server: /Users/mathias/.local/share/code-server/User/workspaceStorage/ contains only `empty-window`, and all three activations logged `branch flow: watching (0 repository/ies at start)` and `branch flow: no plan.md, nothing to keep in step` (clarvis.log in logs/20260829T132709/exthost1|2|3). All ~30 vscode.workspace.fs.* call sites (src/planning/*, src/agent/*, src/chat/*, src/voice/FishAudioProvider.ts, src/memory/PatternStore.ts) and the isInside()/realpath containment logic therefore never ran.

**To settle.** Open a real folder in code-server (?folder=/Users/mathias/Documents/coding/clarvis), then exercise a read, an edit and a deliberate escape attempt (../ and a symlink out of the root) and confirm the gate refuses; check clarvis.log for the containment refusals.

### `NOT_TESTED` — §7.1 SecretStorage persistence

The write path demonstrably ran: clarvis.log (logs/20260829T132709/exthost3) has `voice: enabled, since a key was just set` at 11:35:35.209Z, which src/extension.ts:617-624 reaches only after `await context.secrets.store(FISH_KEY_SECRET, ...)` resolves; and /Users/mathias/.local/share/code-server/serve-web-key-half (32 bytes) was created at 13:35 local by the POST /mint-key handler at ~/.local/lib/code-server-4.135.0/out/node/routes/vscode.js:193 — an endpoint reached only from ServerKeyedAESCrypto.getServerKeyPart(), i.e. from the seal path. But no read-back has been observed.

**Limitation.** LocalStorageSecretStorageProvider.set() in lib/vscode/out/vs/code/browser/workbench/workbench.js calls save() WITHOUT awaiting it, and save() swallows failures (`catch(o){console.error(o)}`). A resolved context.secrets.store() therefore proves the in-memory map was updated and the crypto ran, not that localStorage.setItem landed. Persistence is also browser-profile-scoped, not machine-scoped.

**To settle.** Reload the code-server tab (or restart code-server) and let Clarvis activate again: src/voice/firstRun.ts:48 logs the exact line `voice: first-run offer skipped, a key is already stored` iff hasKey() -> context.secrets.get('clarvis.fishAudio.key') read the value back. Check the newest exthost*/Krimkerre.clarvis/clarvis.log for that line.

### `PASS` · observed — §7.1 global storage (context.globalStorageUri)

`~/.local/share/code-server/User/globalStorage/krimkerre.clarvis/` exists on disk, created by the running extension.

### `PASS` · observed — §7.1 globalState / workspaceState persistence

Round-trip observed rather than reasoned about. A code-server instance was restarted and its Bridge re-registered with the identical `machine_id` (f5af3dd1-b8d9-42ac-ac18-58bf80701343), which is minted once and stored in globalState — so the value survived a full server restart.

**Limitation.** Two independent code-server *processes* sharing one data directory each hold their own in-memory copy and diverge, last write winning. That is an unusual configuration and was created deliberately for an auth experiment; one server with several windows is untested.


## Webview

### `NOT_TESTED` — webview messaging

No browser available, and the described environment did not actually have Clarvis loaded. /Users/mathias/Documents/coding/NERVIS-ecosystem/.run/code-server.log records the running server using extensions folder `file:///Users/mathias/Documents/coding/NERVIS-ecosystem/.run/code-server-data/code-server/extensions`; at 13:29 that folder's extensions.json read exactly `[]`, while Clarvis 0.0.1 was installed into a DIFFERENT directory, ~/.local/share/code-server/extensions/krimkerre.clarvis-0.0.1 (listed in ~/.local/share/code-server/extensions/extensions.json). The same log shows two `Failed login attempt` entries and no successful workbench load. The server data dir and code-server.yaml have since been deleted and nothing is listening on 8741. Source read: host->webview via webviewView.webview.postMessage (ButlerViewProvider.ts:156, :183), webview->host via a handler table (:75-105) against vscode.postMessage calls in chat.js.

**To settle.** Start code-server with the SAME data dir used for `--install-extension` (or install with XDG_DATA_HOME set to /Users/mathias/Documents/coding/NERVIS-ecosystem/.run/code-server-data), confirm the server-side extensions.json actually lists krimkerre.clarvis, open http://127.0.0.1:8741, reveal the Clarvis view, and in browser devtools confirm (a) the `webview-ready` message reaches the outer frame and (b) a host-sent `{type:'chat-turn'}` / `{type:'state'}` arrives at chat.js's `window.addEventListener('message')` while an `{type:'ask'}` posted from the textarea reaches ButlerViewProvider.dispatch.

### `NOT_TESTED` — webview focus

Requires a real UI interaction. The only programmatic focus in the whole extension is inside the webview: chat.js:231-235 handles `prefill` with `input.focus(); input.setSelectionRange(...)`. The extension never calls webviewView.show() or a `clarvis.butler.focus` command (no `.show(` / focus hits in src/ other than that). Whether focus lands and keystrokes route correctly depends on VS Code's keyboard forwarding into the sandboxed content iframe (pre/index.html:1038 sandbox = allow-same-origin allow-pointer-lock allow-scripts allow-downloads; :1058-1059 installs keydown/keyup forwarders on the inner contentWindow) — browser behaviour, not readable from the extension source.

**To settle.** In a browser at http://127.0.0.1:8741 with the extension actually loaded: click into the Clarvis textarea and confirm typing goes to it (not to the workbench), Enter sends while Shift+Enter newlines (chat.js:150-152), and after a host `prefill` message the caret sits at end-of-text in the textarea rather than focus staying in the editor.

### `NOT_TESTED` — webview streaming (does streamed text actually render)

The streaming path is entirely postMessage-driven (chat.js:248-274), so it is exactly as verifiable as the messaging cell above — and that is NOT_TESTED for the same reasons (no browser; the running server's extensions folder was empty; port 8741 is now dead). Nothing about the streaming code is host-specific, but 'not host-specific' is not evidence that it renders.

**To settle.** With the extension actually loaded in code-server, ask a question that produces a streamed reply and confirm a single Clarvis turn grows in place (one row, not one row per fragment), that the transcript auto-scrolls (chat.js:267), and that Stop flips via the `busy` frame (chat.js:243-246). Watch the browser console for CSP violation reports at the same time.

### `NOT_TESTED` — webview rendering prerequisite under code-server (service-worker gate) — gates every webview item in §7.1

code-server's webview host blocks ALL content rendering on service-worker registration, even for a webview that loads no resources: ~/.local/lib/code-server-4.135.0/lib/vscode/out/vs/workbench/contrib/webview/browser/pre/index.html:975 is `await workerReady;` inside the content-update handler, and workerReady (defined :246-285) rejects with 'Service Workers are not enabled. Webviews will not work.' (:251-252) or 'Could not register service worker' (:280-284). So Clarvis's zero-resource design does not exempt it. Two mitigating facts, both read from code-server itself: (1) webviews are served same-origin, not from the CDN — server-main.js sets `webviewEndpoint: v+"/out/vs/workbench/contrib/webview/browser/pre"` where v = basePath + productPath + "/static", and workbench.js prefers `options.webviewEndpoint` over product.json's `webviewContentExternalBaseUrlTemplate` (https://{{uuid}}.vscode-cdn.net/...), so no internet is needed; (2) same-origin means the parentOrigin check short-circuits at pre/index.html:335-338 ('It is safe to run if we are on the same host'), avoiding the crypto.subtle branch. But service-worker registration itself still requires a secure context, which http://127.0.0.1:8741 satisfies and a non-localhost plain-http NERVIS-proxied origin would not.

**To settle.** Load the Clarvis view in a browser against code-server and confirm the panel paints the avatar at all (not a blank frame); in devtools, Application > Service Workers should show `/_static/out/.../pre/service-worker.js` activated. Then repeat through the NERVIS reverse proxy on a non-localhost origin — if that origin is plain http, expect the webview to stay blank and the console to show the service-worker registration error; that reproduction, not this reading, is what would justify a FAIL for the proxied axis.

### `PASS` — webview CSP (declaration, nonce, absence of hardcoded vscode-resource:/vscode-webview: URIs)

/Users/mathias/Documents/coding/clarvis/src/panels/ButlerViewProvider.ts:208 injects `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; media-src data:;">`. A fresh 32-char nonce per render at :14-19; stamped on the chat style (:231), the chat script (:298), and avatar.html's own inline script (:212, replacing `<script>\nconst svg` — target verified byte-exact at /Users/mathias/Documents/coding/clarvis/media/avatar.html:404-405 and in the installed copy). No hardcoded resource scheme exists to break: `grep -c` on the SHIPPED bundle ~/.local/share/code-server/extensions/krimkerre.clarvis-0.0.1/dist/extension.js gives vscode-resource=0, vscode-webview=0, asWebviewUri=0, cspSource=1. The one host-dependent token, webview.cspSource, resolves in code-server's own extension host to `'self' https://*.vscode-cdn.net` (~/.local/lib/code-server-4.135.0/lib/vscode/out/vs/workbench/api/node/extensionHostProcess.js: `cspSource(){let t=this.#r.extensionLocation;...return dI}` with `dI=`'self' https://*.${Hz}`` and `Hz="vscode-cdn.net"`) and appears only on style-src, where the two stylesheets that exist are both inline `<style>` blocks covered by 'unsafe-inline' (honoured, since style-src carries no nonce- or hash-source). So the CSP's correctness is independent of what cspSource evaluates to. code-server's webview host rewrites CSPs only for the legacy `vscode-resource:`/`vscode-webview-resource:` prefixes (~/.local/lib/code-server-4.135.0/lib/vscode/out/vs/workbench/contrib/webview/browser/pre/index.html:900-906) — a path this extension never enters.

### `PASS` — webview resources

The webview loads zero sub-resources, so the code-server resource pipeline cannot fail: `asWebviewUri` appears 0 times in /Users/mathias/Documents/coding/clarvis/src and 0 times in the installed dist/extension.js. avatar.html, chat.css and chat.js are read on the extension-host side with fs.readFileSync and inlined into the HTML string (ButlerViewProvider.ts:193, :232, :298). grep over /Users/mathias/Documents/coding/clarvis/media for `src=|href=|@import|@font-face|url(|fetch(|XMLHttpRequest` finds no external reference at all: every `url(...)` hit in avatar.html (lines 302, 306, 318, 323, 331, 332, 384, 385) is an in-document SVG fragment ref such as `url(#shell)`, and chat.css has zero `url(`/`@import`/`@font-face`. Toolbar icons are deliberately inline SVG paths (ButlerViewProvider.ts:256-272, comment: the CSP has no img-src). localResourceRoots is set to media/ (ButlerViewProvider.ts:51) but nothing ever resolves through it. Installed media files are byte-identical to source (diff -q on avatar.html, chat.js, chat.css against ~/.local/share/code-server/extensions/krimkerre.clarvis-0.0.1/media/).

### `PASS` — webview clipboard

Nothing inside the webview touches the clipboard, so there is no browser-permission-gated or cross-origin clipboard path to fail: grep for `clipboard|execCommand|navigator\.` across /Users/mathias/Documents/coding/clarvis/media returns zero hits. The extension's only clipboard use is the proxied host-side API, `await vscode.env.clipboard.writeText(hint.command)` at /Users/mathias/Documents/coding/clarvis/src/extension.ts:573, inside the 'Copy install command' branch of a showInformationMessage — outside the webview entirely, and `clipboard` occurs exactly once in the shipped dist/extension.js. (code-server does grant the content frame `clipboard-read; clipboard-write;` when scripts are enabled and the browser is not Firefox — pre/index.html:1044-1048 — but Clarvis never asks for it.)

### `PASS` — webview streaming / avatar animation — dependence on Electron specifics (file://, node integration, custom protocols)

No Electron-only capability is used, so none can be lost in a browser. grep over /Users/mathias/Documents/coding/clarvis/media for `file://|require(|process\.|import(|Worker|WebSocket|localhost|http://|https://` returns zero hits. The avatar is inline SVG animated by CSS `@keyframes` (avatar.html:39+ `shadowPulse` etc.) plus one inline DOM script (avatar.html:404-461) using only getElementById/classList/setTimeout. The sole host bridge is the standard `acquireVsCodeApi()` (media/chat.js:9). Streaming is pure postMessage + DOM text nodes (chat.js:248-274 handling chat-stream-start/chat-stream/chat-stream-end, appending via renderInto into the same row) — no fetch, EventSource, WebSocket or custom protocol in the webview. Media playback uses plain web APIs, `new Audio(msg.dataUri)` (chat.js:339) and speechSynthesis (chat.js:305, 318-328, 371), matched by `media-src data:` in the CSP; code-server's webview host delegates `autoplay` to the content frame (pre/index.html:1044 `allowRules = ['cross-origin-isolated;', 'autoplay;', 'local-network-access;']`), and chat.js already handles the autoplay-gesture requirement and NotAllowedError re-arming (chat.js:16-22, 347-357).


## Audio and voice

### `FAIL` — audio playback — Tier 1 when the browser is on a different machine from the code-server host

Playback is a subprocess of the extension host (nativePlayer.ts:98), which under code-server is an ordinary process on the server. Clarvis has no way to notice: `grep -rn "uiKind|remoteName|appHost|extensionKind" src/ media/ package.json` = 0 hits, and 0 hits in dist/extension.js. `hostKind()` (src/bridge/identity.ts:147-153) can name code-server — and code-server's product.json sets nameLong=code-server — but `grep -rn hostKind src/` shows no consumer outside identity.ts and its test, and nothing in the voice path.

**Limitation.** Tier-1 speech is emitted from the server's speakers to whoever is sitting at the server, not to the user at the browser. Clarvis cannot detect the split and has no fallback for it: the only webview audio route it has is Tier 0 system TTS, which is a different (worse) voice. On this machine browser and server coincide, which masks the defect rather than fixing it.


**Open.** Not fixed, and not a fork candidate: in a browser the speaker belongs to the browser, so only routing audio through the webview would fix it, which is a Clarvis change rather than a host one. `media/chat.js` already has half of that path.

### `FAIL` — voice advertised as a separately withheld capability (runbook Stage 9 / §7.1 spike exit: "voice limitations are advertised through capabilities")

src/bridge/protocol.ts:52-80 `CAPABILITIES` declares exactly five entries — clarvis.status.read@1, clarvis.events@1, clarvis.diagnostics.summary@1, clarvis.logs.reference@1, clarvis.ravis_provider@1 — and none concerns voice. `grep -rn voice src/bridge/` returns nothing at all. src/bridge/Bridge.ts:251-254 registers only entries whose state is `available`, from that same frozen table, and src/bridge/server.ts:211-215 serves `GET /ecosystem/capabilities` from `capabilitiesBody(1)` over it. The table is deliberately hand-written, not derived from what is wired (protocol.ts:40-46), so a voice capability will not appear by itself.

**Limitation.** Voice can be withheld from the *user* — `clarvis.voice.enabled` defaults to false (package.json:266), plus session mute (VoiceService.ts:68) and a daily Fish cap (FishAudioProvider.ts:271) — but nothing advertises voice, or its degraded-under-code-server state, to NERVIS or any peer. As the code stands, the Stage 9 exit clause "voice limitations are advertised through capabilities" cannot be satisfied.


**Resolved 29 Aug, commit `330feb1`.** `clarvis.voice@1` is declared and resolved per host: `available` on a desktop, `degraded` on a remote one with the reason spelled out, `unavailable` when switched off. Degraded rather than unavailable because speech still happens — out of the server's speakers — and a peer reading `unavailable` would conclude Clarvis had gone quiet, which is a different and less alarming thing.

### `PASS_WITH_LIMITATION` — runbook claim: "Clarvis plays speech through a Node-side subprocess ... only routing audio through the webview does [fix this]"

True for Tier 1 (FishAudioProvider.ts:74 → nativePlayer.ts:98, afplay), and the source states the reason: Chromium blocks webview audio until a user gesture and the launch briefing fires ~1s after startup (FishAudioProvider.ts:18-27; media/chat.js:11-22). Not true as a blanket statement: Tier 0 already routes through the webview (SystemVoiceProvider.ts:45-58 / media/chat.js:316), and SystemVoiceProvider.ts:14-15 says outright "the extension host has no audio output at all" — the opposite framing from the runbook's.

**Limitation.** The prescribed fix is half-built and half-dead. media/chat.js:337 already handles a `speak-audio` message that plays a pre-rendered data URI in the webview — exactly the missing route — but `grep -c speak-audio dist/extension.js` = 0 (also 0 inside the vsix), so no host code ever sends it. Any Stage 9 write-up should say "Tier 1 uses a subprocess; Tier 0 already uses the webview; the webview receiver for rendered audio exists but is unreachable", not "Clarvis plays speech through a subprocess".

### `PASS_WITH_LIMITATION` — voice never blocks the Code tab (activation, chat, agent)

`say()` is void and fire-and-forget (VoiceService.ts:113-132); utterances are chained onto a private queue whose rejections are swallowed (`this.queue.catch(() => undefined)`, :128); a Tier-1 failure falls to Tier 0 (:158-167) and a Tier-0 failure logs and goes quiet (:172-176); the warning is once per session and non-modal (:180-186). Voice is off by default (package.json:266) and is not in the activation path — activationEvents is `["onStartupFinished"]` and main is ./dist/extension.js. So an audio failure degrades to silence, never to a blocked host.

**Limitation.** `playFile` has no timeout, unlike SystemVoiceProvider's 30s guard (SystemVoiceProvider.ts:5,54-57): it settles only on the child's `exit` or `error` (nativePlayer.ts:102-119). A player process that never exits wedges the voice queue for the window's lifetime — recoverable via mute, which kills the child (VoiceService.ts:72 → nativePlayer.ts:16-21). Contained to voice; it cannot stall chat or the agent.

### `NOT_TESTED` — audio playback — Tier 1 (Fish Audio) under code-server, browser on the same machine as the server

/Users/mathias/Documents/coding/clarvis/src/voice/FishAudioProvider.ts:74 `await playFile(this.cachePath(key).fsPath, process.platform, this.log)` → /Users/mathias/Documents/coding/clarvis/src/voice/nativePlayer.ts:98 `spawn(candidate.command, candidate.args(file), { stdio: 'ignore' })`, candidate for darwin = `afplay` (nativePlayer.ts:38-40). `grep -o afplay dist/extension.js` = 1 hit, and 1 hit inside the shipped clarvis.vsix, so this is the code that installs. No browser was opened; no extension host was run.

**To settle.** In a code-server browser session with a Fish key in SecretStorage and `clarvis.voice.enabled` true, run `Clarvis: Test Voice`, then read the Clarvis output channel for a `play: spawned afplay pid=<n>` line followed by `play: exit code=0 ... after <ms>ms`, and confirm sound at the machine running code-server.

### `NOT_TESTED` — audio playback — Tier 0 (system TTS fallback) in a code-server webview

Tier 0 does NOT use a subprocess: SystemVoiceProvider.ts:50 posts `{ type: 'speak-system', ... }` to the webview and media/chat.js:316-333 answers it with `new SpeechSynthesisUtterance(...)` / `speechSynthesis.speak(...)`. So the audio device for this tier is the browser's, which is the correct device under code-server. Whether Chromium permits `speechSynthesis.speak()` inside code-server's cross-origin webview iframe — and whether it needs a user gesture there — cannot be determined without a browser.

**To settle.** Open the Clarvis panel in a code-server browser tab, run `Clarvis: Test Voice` with no Fish key stored, and check the `audio-probe` message the webview posts on load (media/chat.js:28-32, handled at src/panels/ButlerViewProvider.ts:81) for `speechSynthesis: true`, then listen for the utterance at the browser and watch for a `speech-error` reply rather than the 30s timeout at SystemVoiceProvider.ts:54-57.

### `NOT_TESTED` — audio capture — the `clarvis.debug.micProbe` spike command under code-server

src/extension.ts:661 `await recordClip(file.fsPath, 3, process.platform, log)` → src/voice/nativeRecorder.ts:95 `spawn('ffmpeg', ['-nostdin','-f','avfoundation','-i',':default', ...])`; `grep -c avfoundation dist/extension.js` = 1, so it ships. ffmpeg is present at /opt/homebrew/bin/ffmpeg, so the binary-missing branch would not fire here. Same locality defect as playback: the mic opened is the server's, and the code has no remote-awareness (0 hits, above). macOS TCC would attribute the request to code-server's node process — untested.

**To settle.** Run `Clarvis: Debug — Microphone Probe` from a code-server browser session and read the Clarvis output channel: `mic probe: ffmpeg wrote <n> bytes, captured audio, peak <x> dBFS` versus `SILENT (peak -inf dBFS)`. nativeRecorder.ts:188 `peakDbfs` exists precisely because a denied mic returns exit 0 and a well-formed file of silence, so the exit code alone settles nothing.

### `PASS` — audio capture — voice input (M10) as a product feature

There is no capture path to break. `grep -rni "transcri|whisper|speechToText|asr|SpeechInput|dictat" src/` returns no speech-input implementation; `grep -ni "mic|getUserMedia|SpeechRecognition|record" media/chat.js media/avatar.html` returns only a comment (media/chat.js:25) — no mic button, no recorder UI. The only importer of nativeRecorder is src/extension.ts:16, used solely at src/extension.ts:661 inside a command the source labels "M10 spike (§4.7)". docs/CURRENT_STATE.md:61 states `src/voice/` holds "the voice-input design (not built — M10)" and :84 lists M10 as unbuilt; plan.md:4307 has M10 as a stretch milestone. The runbook's premise is confirmed from source, not from the plan.


## Network, the Bridge and the proxy

### `NOT_TESTED` — localhost LM Studio

Never exercised: settings.json selects provider `custom` (RAVIS) for both chat and agent, so the lmstudio ProviderSpec was never used, and the extension host holds no socket to 1234. Two measured facts bear on it. LM Studio binds IPv4 only (`lsof -nP -iTCP -sTCP:LISTEN`: LM Studio 83984 127.0.0.1:1234), while Clarvis's default is /Users/mathias/Documents/coding/clarvis/src/model/providers.ts:82 `baseUrl: 'http://localhost:1234'` — a name, not an address. That is the classic ::1-first failure, and it is neutralised here specifically: code-server spawns the extension host as `node --dns-result-order=ipv4first .../bootstrap-fork --type=extensionHost` (ps, pid 93638), so `localhost` resolves IPv4 first in this host. That flag is code-server's, not Clarvis's, so the mitigation is a property of this host, not of the extension.

**To settle.** Set clarvis.chat.provider=lmstudio in code-server's settings, reload the window, open the model picker, and confirm a `GET /v1/models` reaches LM Studio's server log and the picker lists a model.

### `NOT_TESTED` — NERVIS reverse proxy in front of code-server / embedded Code tab

The component does not exist, so there was nothing to test. NERVIS's app (/Users/mathias/Documents/coding/NERVIS-ecosystem/nervis/src/nervis/app.py:73-81) mounts eight routers — ecosystem, api, chat, events, diagnostics, traces, instances, voice — plus the dashboard; none is a proxy, and `grep -rn 'absproxy|/proxy/' nervis/` finds only a test asserting that allowed_endpoint REFUSES such a path (nervis/tests/test_m2_registry.py:734). The Code tab is a mock, not an iframe: nervis/index.html:8770 renders `<div class="full code-server" id="clarvis-frame">` filled with hand-written title bar, file list, EDITOR_PREVIEW code and a Clarvis panel, and the file says so twice — line 14 ('replace the mock workspace with a code-server iframe'), line 3180 ('In the real build the Code tab is an <iframe> at this origin behind the NERVIS reverse proxy') and line 8741 ('When the Code tab becomes a real iframe this constant is deleted outright'). The only <iframe> elements in the dashboard are srcdoc avatar frames (index.html:1021,1032).

**To settle.** Build the NERVIS route that serves code-server (the mock's placeholder is `base_path:'/code/'`, index.html:3185), point #clarvis-frame at it, and load the dashboard in a browser.

### `NOT_TESTED` — WebSockets through the NERVIS proxy

Untestable today for the reason above: no NERVIS proxy exists. What the host requires is readable: code-server's workbench WebSocket route is guarded by `ensureOrigin, ensureAuthenticated, ensureVSCodeLoaded` (~/.local/lib/code-server-4.135.0/out/node/routes/vscode.js:225), so a proxy must forward the upgrade AND satisfy the origin rule below. Clarvis itself adds no WebSocket: its own Bridge surface is plain HTTP with SSE over node's `http` (src/bridge/server.ts) and its webview opens no socket (no WebSocket/EventSource in media/).

**To settle.** Once a NERVIS /code route exists, load it in a browser and confirm the workbench connects — no 403 on the upgrade in code-server's log and the editor renders rather than hanging on 'Connecting'.

### `NOT_TESTED` — Origins (proxied)

No proxy to test against. The rule that will decide it is in ~/.local/lib/code-server-4.135.0/out/node/http.js:322-352: `authenticateOrigin` rejects the request unless the Origin header's host equals the Host header (honouring Forwarded / X-Forwarded-Host) or matches `--trusted-origins`. So a NERVIS proxy that rewrites Host to 127.0.0.1:8741 while the browser's Origin stays NERVIS's own will get 403 Forbidden on the workbench WebSocket and code-server will never load; forwarding Host unchanged, or listing NERVIS's origin in --trusted-origins, is the fix. On the Clarvis side there is nothing origin-dependent: the webview ships `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-...'; media-src data:` (src/panels/ButlerViewProvider.ts:208) with localResourceRoots limited to media/ (line 51), so it cannot make a cross-origin request at all.

**To settle.** Stand up the NERVIS /code route, then check code-server's log for `host "..." does not match origin "..."` / 'Forbidden' on the WebSocket upgrade, and whether adding --trusted-origins clears it.

### `NOT_TESTED` — Auth and base path (proxied)

Nothing was verified behind the auth gate. code-server runs with password auth (~/.config/code-server/config.yaml: `bind-addr: 127.0.0.1:8080`, `auth: password`) and the gate demonstrably fires — .run/code-server.log ends with two 'Failed login attempt' entries from 127.0.0.1 — but no authenticated session was driven, so no Clarvis feature was exercised through it. Base path is likewise unexercised: code-server is served at `/` and no proxy prefixes it. Clarvis contributes no base-path dependency of its own (no `asExternalUri`, no absolute URL into the code-server origin; the webview addresses resources only through `webview.cspSource` and localResourceRoots, src/panels/ButlerViewProvider.ts:48-51,208) — but that is an argument, not a measurement, and code-server's own behaviour under a prefix is the untested half.

**To settle.** Log in to http://127.0.0.1:8080 with the configured password, confirm the Clarvis panel renders and streams; then serve code-server under a prefix (e.g. /code/ via a proxy that forwards Host) and confirm the workbench and the Clarvis webview both load without 404s on _static.

### `PASS` · observed — localhost RAVIS

Reached from inside the code-server extension host. Clarvis's log carries RAVIS's own 503 body verbatim (`upstream_not_configured`), which proves the loopback request was made and answered; after the launcher bug behind that 503 was fixed, `ravis/clarvis-chat` resolved to a local `meta-llama-3.1-8b-instruct` and answered.

### `PASS` · observed — Clarvis Bridge under code-server

The Bridge bound 127.0.0.1 on an OS-assigned port from inside the extension host, registered with NERVIS, held its lease, and NERVIS read `/v1/status` back through M8b. Observed repeatedly across restarts; the registry lists each window separately with its own port.

### `PASS` — code-server port proxy (/proxy/{port}/, /absproxy/{port}/) on the Bridge's path

Source is the evidence: the API is not used, so it cannot fail. `grep -rn 'asExternalUri|openExternal|proxy' /Users/mathias/Documents/coding/clarvis/src` finds no `vscode.env.asExternalUri` anywhere — 'proxy' appears only in comments and in src/bridge/server.ts:38. The Bridge binds 127.0.0.1 with port 0 (src/bridge/server.ts, `server.listen(0, '127.0.0.1', ...)`, address read back from the OS) and registers a bare integer port (src/bridge/registration.ts, `Claim.port`), and NERVIS builds the endpoint itself as `http://127.0.0.1:{port}` (/Users/mathias/Documents/coding/NERVIS-ecosystem/nervis/src/nervis/instances.py:219). NERVIS therefore reaches the Bridge by direct loopback and never traverses code-server's proxy. The proxy routes exist (~/.local/lib/code-server-4.135.0/out/node/routes/index.js:140-160) and would in any case require code-server's password cookie (routes/pathProxy.js calls `authenticated(req)`), which NERVIS does not hold.


## Trust, Git and containment

### `PASS_WITH_LIMITATION` · observed — Git, worktree, checkpoint and undo flows

code-server opens a folder in Restricted Mode by default. VS Code's own Workspace Trust dialog states extensions are activated only "In a Trusted Folder", and `vscode.git` is absent from the extension host's activation log entirely while `vscode.git-base` is present — so `getExtension('vscode.git')` returns undefined and every branch, worktree, checkpoint and undo flow silently does not run. git 2.55.0 is on PATH and `vscode.git` ships in the install; neither is the cause.

**Limitation.** Works once the folder is trusted. Trust was not granted during this spike — it is a security consent belonging to the operator — so the trusted path is inferred from VS Code's own dialog rather than observed.

### `PASS` · observed — Workspace containment and the safety gates under an untrusted folder

`src/agent/tools/trust.ts` throws `UntrustedWorkspaceError` before any command runs, and `editTools.ts` refuses writes before a path is even resolved. The manifest declares `untrustedWorkspaces: limited` with the eight restricted settings enumerated. Restricted Mode was observed live and Clarvis ran in it without reaching for either.


## What was fixed because of this spike

Four defects were found by running the thing, and all four are fixed. Three were Clarvis's
and not code-server's — code-server only made them easy to hit.

- **Clarvis promised an OS keychain on hosts that do not have one.** §7.2 said to measure
  it rather than assume; measured, `context.secrets` is browser localStorage under a key
  whose client half sits in cleartext in the same blob. Five user-facing strings and the
  manual said "the system keychain". Now resolved from `vscode.env.remoteName`.
- **The good voice declining was treated as a non-event.** A missing key produced the system
  voice with no message and no log line, because only a *thrown* failure warned. The empty
  branch is now the one that explains itself.
- **"No Git extension" sent you to install one you already had.** The cause was Restricted
  Mode; the message named the symptom.
- **RAVIS started with no upstream** and the launcher printed the opposite. Found because
  Clarvis logged RAVIS's 503 verbatim from inside code-server.

## What this spike did not do

- **No proxied testing at all.** Every cell above is direct-to-code-server. The NERVIS
  reverse proxy, WebSockets through it, origins and base path are the second half of §7.1's
  axis and none of it has run.
- **One browser.** Firefox, and only for whether the webview renders.
- **Trust was never granted**, so the trusted-folder path is inferred from VS Code's own
  dialog rather than observed.
- **No fork was proposed**, and none is justified: the runbook permits one only after a
  failure is reproduced that the extension API cannot reach, and neither of the two named
  candidates qualifies. SecretStorage is weaker but present and working. Audio is a real
  limitation and a fork would not fix it — in a browser the speaker belongs to the browser,
  so only routing audio through the webview would, which is a Clarvis change.
