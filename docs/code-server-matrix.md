# code-server compatibility matrix — Stage 9 spike

`ECOSYSTEM_RUNBOOK.md` §6.2 Stage 9 says **"Test, do not assume."** This is the result of
doing that, once, on one machine, on 29 August 2026. Every cell carries what was actually
observed. Where nothing was observed the cell says `NOT_TESTED` and names the action that
would settle it — the runbook's rule is that unsupported combinations are never offered as
supported, and a cell graded from reading rather than running is exactly how that happens.

**Updated 30 August 2026.** Four cells moved from `NOT_TESTED` by running them with a real
folder open and trusted: shell-integration events (`PASS`), tasks
(`PASS_WITH_LIMITATION` — a genuine double-count this document predicted), SecretStorage
persistence (`PASS`) and Tier 1 audio playback (`PASS_WITH_LIMITATION`). Workspace FS lost its
blocking premise but keeps `NOT_TESTED`, because containment is the cell and the escape attempt
still has not been made. The two webview cells were attempted and deliberately left ungraded:
the browser used had service workers blocked, which no webview can survive, and that is a fact
about the browser rather than about Clarvis.

**The combination tested.** code-server 4.135.0 ("with Code 1.135.0"), standalone install,
macOS arm64, Clarvis 0.0.1, served over plain HTTP on loopback — **direct**, and since 30 August
also through a **spike reverse proxy** at a `/code/` base path. The spike is not NERVIS's proxy:
it forwards bytes and does none of §13.3's security work, so what it grades is Clarvis and
code-server *under a proxy*, never NERVIS's own route. Everything behind code-server's login
remains ungraded, because the password is the operator's to type. Browser axis: two points, and only for the
webview question — Firefox, where webviews load, and a Chromium-based agent with service
workers blocked, where no webview can load at all.

**This is not a support statement.** Stage 9's exit asks that install, activate, chat,
agent, stream, stop, tool, gate, workspace boundary, SecretStorage, persistence and
teardown all pass on at least one declared combination. Several of those are still
untested, so no combination is declared supported yet.

## Where it stands

| | |
|---|---|
| PASS | 27 |
| PASS_WITH_LIMITATION | 13 |
| FAIL | 4 |
| NOT_TESTED | 7 |

**How to read the confidence.** 12 cells have now been
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

### `PASS` · observed — a terminal runs a real shell under code-server

Driven in an isolated instance (`--auth none`, its own `--user-data-dir`, a scratch workspace),
so no password and none of the operator's settings were involved. Terminal ▸ New Terminal opened
a panel and a shell executed: the visible output includes zsh's own
`_p9k_deschedule_redraw:2: No handler installed for fd 17`, which is powerlevel10k complaining
inside a real process rather than anything the editor drew.

**One behaviour worth naming.** Creating the first terminal raised Workspace Trust — *"Creating a
terminal process requires executing code"* — and the terminal was created and usable after
**Cancel**. The prompt gates the folder's trust, not the terminal, so a "no" leaves a working
shell in a Restricted Mode window. Clarvis's own gates are unaffected: `trust.ts` throws
`UntrustedWorkspaceError` before any command it would run, which is a separate and stricter
check.

**Limitation.** This is the *editor's* terminal. Clarvis's `AgentTerminal` — the one an agent run
writes into — was not exercised, because an agent run needs the panel and the panel needs a
browser with working service workers.

### `PASS` — terminal shell execution — shell-integration events (onDidStartTerminalShellExecution)

**Settled 30 August 2026 by running it.** An integrated terminal (zsh) opened in the
code-server tab, with `~/Documents/coding/ai-router-main` open and trusted. Running
`echo stage9-shell-probe && sleep 3 && echo probe-done` produced, in
`logs/20260830T104315/exthost3/Krimkerre.clarvis/clarvis.log`:

```text
[2026-08-30T08:49:56.796Z] outcome terminal "echo stage9-shell-probe && sleep 3 && echo probe-done" exitCode=0 durationMs=3038 (threshold=30s)
```

Both events fired: `onDidStartTerminalShellExecution` supplied the command line, which is
reported verbatim, and `onDidEndTerminalShellExecution` supplied `exitCode=0`. The measured
3038 ms matches the `sleep 3`, so the pair bracket the real execution rather than the
keystroke. VS Code's shell-integration script is therefore injected successfully into zsh
under this host — the runtime property that could not be graded from source.

The phantom empty-commandLine startup execution was also filtered as designed: opening the
terminal produced no `outcome` line, and the first one appeared only when a command ran.

The evidence below is what stood before that run.

#Prior reasoning (was `NOT_TESTED`) — terminal shell execution — shell-integration events (onDidStartTerminalShellExecution)

src/watch/wireBusyTracker.ts:95,105 subscribes to `vscode.window.onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution` to drive BusyTracker. The API exists in this host (`grep -c onDidStartTerminalShellExecution out/vs/workbench/api/node/extensionHostProcess.js` → 2) and the engine constraint is satisfied (package.json engines vscode ^1.93.0; code-server 4.135.0 'with Code 1.135.0'). code-server also ships a working darwin-arm64 pty backend (lib/vscode/node_modules/node-pty/build/Release/pty.node). But these events fire only when VS Code's shell-integration script is successfully injected into the user's shell, which is a runtime property of the browser-side terminal plus the server shell, and no integrated terminal was ever opened in these sessions. wireBusyTracker's own comment records the API is 'silently absent otherwise (no error, just no events)' — a failure here is invisible, which is exactly why it cannot be graded from source.

**To settle.** In the code-server tab open an integrated terminal (zsh on this host), run `sleep 5`, and check that Clarvis reports busy then idle around it. Also confirm the phantom empty-commandLine startup execution is filtered (wireBusyTracker.ts:99-101) rather than pinning Clarvis busy for the session.

### `PASS_WITH_LIMITATION` — tasks

**Settled 30 August 2026 by running one, and the limitation this cell predicted is real.**
A temporary `.vscode/tasks.json` defining `stage9-task-probe`
(`echo … && sleep 3 && echo …`) was added to the open folder, run from
Terminal → Run Task, and removed afterwards. The log records:

```text
[2026-08-30T08:52:28.462Z] outcome task "stage9-task-probe" exitCode=0 durationMs=3362 (threshold=30s)
[2026-08-30T08:52:28.465Z] outcome terminal "echo stage9-task-started && sleep 3 && echo stage9-task-finished" exitCode=0 durationMs=3369 (threshold=30s)
```

The task half works: `onDidStartTask` supplied the label, `onDidEndTaskProcess` supplied the
exit code, and BusyTracker tracked it.

**The limitation is the double-count, exactly where this cell said to look.** One task run
produced *two* outcomes — one `task`, one `terminal` — because `isTaskExecution`
(wireBusyTracker.ts:63-66) recognises a task's own terminal by
`event.terminal.name === ''`, "which is how a brand-new task terminal looks before VS Code
names it". Under code-server it does not look like that: the terminal is already named after
the task when the execution starts, so the guard misses and the same run is counted twice.

Consequences are bounded but real. BusyTracker holds two overlapping jobs for one task, and
`WatchPresenter.handleOutcome` runs twice — for a task over the 30 s announcement threshold
that is two notifications for one piece of work. `rememberIfTaskTerminal` learns the terminal
at *end* time, so a second task in the same terminal is recognised correctly; it is the first
task in each fresh terminal that doubles.

Not reproduced on desktop VS Code, so whether this is a code-server ordering difference or
true of both hosts is **untested** — the fix (recognise a task terminal by matching a running
task name, not by an empty one) is the same either way.

The evidence below is what stood before that run.

#### Prior reasoning (was `NOT_TESTED`) — tasks

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

**Half of this moved on 30 August 2026, and the half that matters did not.** A real folder
(`~/Documents/coding/ai-router-main`) is now open and trusted, so the premise below — that no
folder had ever been opened — is void, and workspace-dependent paths ran:

```text
[2026-08-30T08:48:24.861Z] chat: filed previous session (2 turns)
[2026-08-30T08:48:24.882Z] branch flow: watching (0 repository/ies at start)
[2026-08-30T08:48:28.887Z] branch flow: no plan.md, nothing to keep in step
[2026-08-30T08:48:30.806Z] chat: no plan.md here, offered to plan
```

The `plan.md` lookup is a `vscode.workspace.fs` read against the real workspace root, and it
answered correctly (there is none). So the read path works under this host.

**Containment is still ungraded, and that is the cell.** `isInside()`/realpath refusals only
run when the *agent* is asked to touch a path, which needs the chat webview — and the webview
could not be driven in the browser used for this pass (see the webview cells). A deliberate
`../` and a symlink out of the root remain untried, so nothing here says the gate refuses
them. Graded `NOT_TESTED` rather than `PASS` for that reason: the escape attempt is the test.

#### Prior reasoning — workspace FS

No workspace folder had been opened in this code-server: /Users/mathias/.local/share/code-server/User/workspaceStorage/ contains only `empty-window`, and all three activations logged `branch flow: watching (0 repository/ies at start)` and `branch flow: no plan.md, nothing to keep in step` (clarvis.log in logs/20260829T132709/exthost1|2|3). All ~30 vscode.workspace.fs.* call sites (src/planning/*, src/agent/*, src/chat/*, src/voice/FishAudioProvider.ts, src/memory/PatternStore.ts) and the isInside()/realpath containment logic therefore never ran.

**To settle.** Open a real folder in code-server (?folder=/Users/mathias/Documents/coding/clarvis), then exercise a read, an edit and a deliberate escape attempt (../ and a symlink out of the root) and confirm the gate refuses; check clarvis.log for the containment refusals.

### `PASS` — §7.1 SecretStorage persistence

**Settled 30 August 2026 from the logs of two separate sessions.** A key stored on 29 August
was read back on 30 August, in a different code-server process, and used:

```text
logs/20260829T141317/…/clarvis.log   voice: rendered … (s2.1-pro)
logs/20260830T104315/…/clarvis.log   voice: rendered 32808 bytes in 1182ms (s2.1-pro)
```

Rendering through Fish Audio requires `context.secrets.get(FISH_KEY_SECRET)` to return a key
(FishAudioProvider.ts:57,91). The 30 August session contains **no key-storing event** — no
`a key was just set` line, no `Key stored` message — so the key it used was written by an
earlier session and survived both a browser reload and a server restart.

The limitation graded elsewhere still stands and is not weakened by this: the backing is the
browser's `localStorage`, not a keychain, so persistence is per browser profile and per
origin. A second browser sees no key, and moving code-server to a different origin empties it.

The evidence below is what stood before that reading.

#### Prior reasoning (was `NOT_TESTED`) — SecretStorage persistence

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

**Attempted 30 August 2026 and deliberately not graded — the browser was the wrong
instrument.** The Clarvis panel failed to load with `Could not register service worker`, and
the temptation is to record that as a code-server or Clarvis failure. It is neither. Checked
before concluding: the service-worker script returns **200** with `content-type:
text/javascript` and 20 189 bytes, the page is a **secure context**, the frame is
**top-level**, and `'serviceWorker' in navigator` is true — yet `register()` fails with
*"An unknown error occurred when fetching the script"* for **every** script, including
`/manifest.json`. Service workers are blocked at the browser-agent level in that pane.

VS Code serves all webview content through that service worker, so a browser without one
cannot host any webview at all — Clarvis's or anyone's. The operator confirms Firefox works.

That makes this a **browser-axis** fact and not a verdict: the axis now has two known points
(Firefox: webviews load; a service-worker-less agent: no webview can), and this cell still
needs a run in Firefox to be graded. Recording the failure as Clarvis's would be precisely
the "graded from reading rather than running" error this document exists to prevent.

#### Prior reasoning — webview messaging

No browser available, and the described environment did not actually have Clarvis loaded. /Users/mathias/Documents/coding/NERVIS-ecosystem/.run/code-server.log records the running server using extensions folder `file:///Users/mathias/Documents/coding/NERVIS-ecosystem/.run/code-server-data/code-server/extensions`; at 13:29 that folder's extensions.json read exactly `[]`, while Clarvis 0.0.1 was installed into a DIFFERENT directory, ~/.local/share/code-server/extensions/krimkerre.clarvis-0.0.1 (listed in ~/.local/share/code-server/extensions/extensions.json). The same log shows two `Failed login attempt` entries and no successful workbench load. The server data dir and code-server.yaml have since been deleted and nothing is listening on 8741. Source read: host->webview via webviewView.webview.postMessage (ButlerViewProvider.ts:156, :183), webview->host via a handler table (:75-105) against vscode.postMessage calls in chat.js.

**To settle.** Start code-server with the SAME data dir used for `--install-extension` (or install with XDG_DATA_HOME set to /Users/mathias/Documents/coding/NERVIS-ecosystem/.run/code-server-data), confirm the server-side extensions.json actually lists krimkerre.clarvis, open http://127.0.0.1:8741, reveal the Clarvis view, and in browser devtools confirm (a) the `webview-ready` message reaches the outer frame and (b) a host-sent `{type:'chat-turn'}` / `{type:'state'}` arrives at chat.js's `window.addEventListener('message')` while an `{type:'ask'}` posted from the textarea reaches ButlerViewProvider.dispatch.

### `NOT_TESTED` — webview focus

**Attempted 30 August 2026 and deliberately not graded — the browser was the wrong
instrument.** The Clarvis panel failed to load with `Could not register service worker`, and
the temptation is to record that as a code-server or Clarvis failure. It is neither. Checked
before concluding: the service-worker script returns **200** with `content-type:
text/javascript` and 20 189 bytes, the page is a **secure context**, the frame is
**top-level**, and `'serviceWorker' in navigator` is true — yet `register()` fails with
*"An unknown error occurred when fetching the script"* for **every** script, including
`/manifest.json`. Service workers are blocked at the browser-agent level in that pane.

VS Code serves all webview content through that service worker, so a browser without one
cannot host any webview at all — Clarvis's or anyone's. The operator confirms Firefox works.

That makes this a **browser-axis** fact and not a verdict: the axis now has two known points
(Firefox: webviews load; a service-worker-less agent: no webview can), and this cell still
needs a run in Firefox to be graded. Recording the failure as Clarvis's would be precisely
the "graded from reading rather than running" error this document exists to prevent.

#### Prior reasoning — webview focus

Requires a real UI interaction. The only programmatic focus in the whole extension is inside the webview: chat.js:231-235 handles `prefill` with `input.focus(); input.setSelectionRange(...)`. The extension never calls webviewView.show() or a `clarvis.butler.focus` command (no `.show(` / focus hits in src/ other than that). Whether focus lands and keystrokes route correctly depends on VS Code's keyboard forwarding into the sandboxed content iframe (pre/index.html:1038 sandbox = allow-same-origin allow-pointer-lock allow-scripts allow-downloads; :1058-1059 installs keydown/keyup forwarders on the inner contentWindow) — browser behaviour, not readable from the extension source.

**To settle.** In a browser at http://127.0.0.1:8741 with the extension actually loaded: click into the Clarvis textarea and confirm typing goes to it (not to the workbench), Enter sends while Shift+Enter newlines (chat.js:150-152), and after a host `prefill` message the caret sits at end-of-text in the textarea rather than focus staying in the editor.

### `PASS` · observed — webview streaming

The operator's own sessions: the panel answers in the Clarvis tab and did so again through the
spike proxy, which means text streamed from the extension host into the webview and rendered as
it arrived. Not a claim about long streams or reconnection — a reply arriving is what was seen.

### `PASS` · observed — webview rendering under code-server (the service-worker gate)

**Settled by the operator, not by me.** Every ServiceWorker registration fails in the browser I
drive — including an unrelated script at root scope, with `isSecureContext` true and the script
fetching 200 — so the Clarvis panel never rendered on my side and the gate could not be
distinguished from a code-server problem. The operator opened the same code-server in Firefox and
the panel rendered; it has since answered, streamed and been used through a proxy as well.

**Limitation on the axis, not on the verdict.** One browser. Chrome, Safari and a browser with
service workers disabled are ungraded, and the failure mode is known to be silent: the panel
simply does not appear.

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

### `PASS_WITH_LIMITATION` — audio playback — Tier 1 (Fish Audio) under code-server, browser on the same machine as the server

**Settled 30 August 2026: it plays, and it plays from the server.** From
`logs/20260830T104315/exthost1/Krimkerre.clarvis/clarvis.log`:

```text
[2026-08-30T08:44:12.894Z] voice: rendered 42839 bytes in 1194ms (s2.1-pro)
[2026-08-30T08:44:12.922Z] voice: playing 27208a237db1557c3419fca085355e44
[2026-08-30T08:44:12.927Z] play: spawned afplay pid=9307
[2026-08-30T08:44:18.603Z] play: exit code=0 signal=null after 5680ms
```

The subprocess path works unchanged under code-server: `afplay` spawned from the extension
host, ran the full clip, exited 0. Nothing about being a server-side host prevents it.

**The limitation is the whole point of this cell.** The audio came out of the *server's*
audio device. On this machine the browser and the server are the same box, so the operator
heard it — which is why this grades PASS here and why the split-host cell remains a `FAIL`.
The two cells describe one behaviour under two deployments, and only the coincidence of
machines makes this one work.

The evidence below is what stood before that reading.

#### Prior reasoning (was `NOT_TESTED`) — Tier 1 audio

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

### `PASS_WITH_LIMITATION` · observed — a reverse proxy in front of code-server

**Measured through a spike proxy, not through NERVIS's own route, which still does not exist.**
The spike (`proxy_spike.py`, ~150 lines of Starlette + httpx + websockets) forwards HTTP and
WebSockets to `127.0.0.1:8080` under a base path, and does none of §13.3's security work — no
auth, no CSRF, no redaction, no timeouts. It exists to answer the questions this matrix asks
about *Clarvis under a proxy*, and those are answered by forwarding bytes faithfully.

What it establishes: the workbench's static surface serves correctly under a prefix, large
streams survive, and the WebSocket upgrade proxies. What it cannot establish is anything behind
the login, which is the operator's password to type.

**Limitation.** A NERVIS-side statement about NERVIS's proxy still requires NERVIS's proxy. The
Code tab embeds code-server *directly* at `127.0.0.1:8080` today, so nothing in production is
proxied and none of this is load-bearing yet.

### `PASS` · observed — base path other than `/`

Served at `/code/` through the spike and it needs no rewriting at all: code-server emits relative
URLs. The login page carries `"base": "."` and `csStaticBase: "./_static"`, every asset href is
`./_static/...`, and the one redirect observed is `location: ./login` — relative, so a prefix
cannot break it. Assets resolve: `/code/_static/src/browser/pages/login.css` → 200, 1,097 bytes,
`text/css`, identical to the direct fetch.

**And Clarvis adds no base-path dependency**, which was previously an argument and is now
measured alongside it: the webview addresses resources only through `webview.cspSource` and
`localResourceRoots`, and there is no `asExternalUri` anywhere in the extension.

### `PASS` · observed — large streams through a proxy

`workbench.web.main.internal.js` — 18,538,728 bytes — fetched directly and through the proxy.
`cmp` reports the two files byte-identical. A workbench that loads its main bundle through a hop
is the case worth checking, because a proxy that truncates at a buffer boundary produces a blank
editor rather than an error.

### `PASS_WITH_LIMITATION` · observed — WebSocket upgrade through a proxy

The upgrade proxies, and finding out cost two defects in the spike that are worth recording
because both are the ordinary way to write it:

- **Accepting before dialling upstream.** The first version accepted the client socket and then
  connected to code-server, so an upstream `401` became a socket that opened and closed
  immediately. A browser reports that as a dropped connection: "you are logged out" arrives
  looking like "the server fell over". Connecting first and accepting only on success makes the
  proxy relay the refusal instead of inventing a connection.
- **Forwarding every path.** Mounted at `/code`, it still answered `/healthz` — a proxy that
  answers outside its own prefix is an open proxy to its upstream on every path, which is
  §13.3's "no arbitrary upstream proxying" in one line. And `/code/../healthz` walked out of the
  prefix because uvicorn does not collapse `..` before routing, so the prefix test has to
  normalise first. Both fixed; `/healthz` → 404, `/code/../healthz` → 404, `/code/healthz` → 200.

**Limitation.** With the fix, an unauthenticated upgrade is refused — but as `403`, not the
upstream's `401`, because a pre-accept close at the ASGI layer cannot choose the status. The
difference matters to a browser: `401` says re-authenticate, `403` says stop asking. A
production proxy has to handle the handshake lower down to relay it faithfully.

### `PASS` · observed — the authenticated workbench, the Clarvis panel and the terminal through a proxy

Driven by the operator, who holds the password. Through the spike at
`http://127.0.0.1:8795/code/`: the workbench rendered, the Clarvis panel appeared and answered,
and a terminal opened — which is the WebSocket carrying real traffic rather than merely
upgrading. That is the three things the proxied axis exists to ask.

### `FAIL` — origin validation was not being performed, and that is why it worked

**The terminal connected partly because the spike had disabled code-server's CSRF defence.** The
proxy forwarded `Cookie` on the WebSocket hop and nothing else, so the upstream saw no `Origin`
header at all — and code-server's own words for that case are in
`~/.local/lib/code-server-4.135.0/out/node/http.js:323`:

```js
// A missing origin probably means the source is non-browser.  Not sure we
// have a use case for this but let it through.
const originRaw = getFirstHeader(req, "origin");
if (!originRaw) { return; }
```

So the check did not fail; it did not run. A proxy that strips `Origin` silently removes the
protection §13.3 requires it to *perform* — and the symptom of getting it right is a `403` that
the naive version never sees.

**Fixed in the spike, and the fix is the shape a real proxy needs.** `Origin` now travels, and
the browser's host travels as RFC 7239 `Forwarded: host=…;proto=http`, which `getHost` reads
before the `Host` header. That keeps the comparison running *and* passing, rather than passing by
absence.

**To settle.** Re-run the authenticated pass with the fixed spike: the workbench and terminal
should behave identically, and code-server's log should carry no `host "…" does not match origin
"…"`. A failure there is the real answer to whether NERVIS can proxy at all.

### `PASS_WITH_LIMITATION` — SecretStorage is scoped to the origin, so reaching code-server a different way loses every key

**Observed the moment the proxy was used: none of the operator's API keys were there.** Nothing
was deleted. Under code-server `context.secrets` is backed by the browser's own storage —
`secret://<key>` through the workbench storage service — and browser storage is partitioned by
origin. `http://127.0.0.1:8080` and `http://127.0.0.1:8795` are different origins, so a key
stored while using one is invisible from the other and remains readable at the first.

**Limitation, and it is a migration hazard rather than a bug.** Any change to *how* code-server
is reached — a proxy prefix, a different port, a hostname instead of `127.0.0.1` — presents an
empty keychain. Today the Code tab embeds `127.0.0.1:8080` directly, so moving it behind a NERVIS
route would empty every user's keys on upgrade while the old ones linger in the old origin's
storage.

**What blunts it.** RAVIS holding provider credentials is the mitigation this matrix already
names, and this is the sharpest argument for it: a Clarvis pointed at `ravis/*` stores no
provider key in the browser at all, so an origin change costs nothing.

### `PASS` · observed — origin validation runs through the proxy and refuses a bad origin

**Settled by falsification, because "it worked" is what made the previous pass worthless.** The
operator reloaded the fixed spike and the workbench and terminal still worked — which on its own
is equally consistent with the check running and with the check being skipped again. So the
mechanism was driven directly, on a throwaway `--auth none` code-server on `127.0.0.1:8081` with
its own proxy at `8796`, keeping the operator's password out of it entirely:

| what was tried | result |
|---|---|
| direct, no `Origin` | connected — the "let it through" branch |
| direct, `Origin: http://127.0.0.1:8081` | connected |
| direct, `Origin: http://evil.example` | **refused, HTTP 403** |
| **proxied**, `Origin: http://127.0.0.1:8796` | **connected** |
| **proxied**, `Origin: http://evil.example` | **refused, HTTP 403** |

The last two are the answer: through the proxy, a matching origin passes and a mismatched one is
refused. The check is running rather than being skipped, and RFC 7239 `Forwarded: host=…` is what
makes the browser's host visible to `getHost` so the comparison can succeed. Both throwaway
processes were stopped afterwards.

### `PASS` · observed — localhost RAVIS

Reached from inside the code-server extension host. Clarvis's log carries RAVIS's own 503 body verbatim (`upstream_not_configured`), which proves the loopback request was made and answered; after the launcher bug behind that 503 was fixed, `ravis/clarvis-chat` resolved to a local `meta-llama-3.1-8b-instruct` and answered.

### `PASS` · observed — Clarvis Bridge under code-server

The Bridge bound 127.0.0.1 on an OS-assigned port from inside the extension host, registered with NERVIS, held its lease, and NERVIS read `/v1/status` back through M8b. Observed repeatedly across restarts; the registry lists each window separately with its own port.

### `PASS` — code-server port proxy (/proxy/{port}/, /absproxy/{port}/) on the Bridge's path

Source is the evidence: the API is not used, so it cannot fail. `grep -rn 'asExternalUri|openExternal|proxy' /Users/mathias/Documents/coding/clarvis/src` finds no `vscode.env.asExternalUri` anywhere — 'proxy' appears only in comments and in src/bridge/server.ts:38. The Bridge binds 127.0.0.1 with port 0 (src/bridge/server.ts, `server.listen(0, '127.0.0.1', ...)`, address read back from the OS) and registers a bare integer port (src/bridge/registration.ts, `Claim.port`), and NERVIS builds the endpoint itself as `http://127.0.0.1:{port}` (/Users/mathias/Documents/coding/NERVIS-ecosystem/nervis/src/nervis/instances.py:219). NERVIS therefore reaches the Bridge by direct loopback and never traverses code-server's proxy. The proxy routes exist (~/.local/lib/code-server-4.135.0/out/node/routes/index.js:140-160) and would in any case require code-server's password cookie (routes/pathProxy.js calls `authenticated(req)`), which NERVIS does not hold.


## Trust, Git and containment

### `PASS_WITH_LIMITATION` · observed — Git, worktree, checkpoint and undo flows

code-server opens a folder in Restricted Mode by default. VS Code's own Workspace Trust dialog states extensions are activated only "In a Trusted Folder", and `vscode.git` is absent from the extension host's activation log entirely while `vscode.git-base` is present — so `getExtension('vscode.git')` returns undefined and every branch, worktree, checkpoint and undo flow silently does not run. git 2.55.0 is on PATH and `vscode.git` ships in the install; neither is the cause.

**Now observed rather than inferred, and the message is right.** A fresh instance's Clarvis log
carries: `branch flow: this folder is not trusted, so the Git extension is switched off — trust
it to get branch, checkpoint and undo back`. That is the message this spike caused to be written:
the previous one said "no Git extension" and sent people to install one they already had.

**Limitation.** Works once the folder is trusted. Trust was not granted during this spike — it is
a security consent belonging to the operator — so the trusted path is inferred from VS Code's own
dialog rather than observed.

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

- **No *NERVIS* proxy.** The proxied cells above were measured through a spike — Starlette,
  httpx and websockets, forwarding bytes under a `/code/` prefix — which answers what Clarvis and
  code-server do behind a proxy and says nothing about NERVIS's own route, which does not exist.
  §13.3's security work (auth, CSRF, origin validation, redaction, timeouts, a published browser
  matrix) is entirely unbuilt.
- **Nothing behind the login.** The workbench, the Clarvis panel, the terminal and an agent run
  through a proxy are ungraded: code-server runs with password auth and the password is the
  operator's to type.
- **Two browsers now, and only one of them can show a webview.** The workbench itself renders in
  a Chromium-based browser as well as Firefox — the isolated probe above was driven in one. But
  every ServiceWorker registration fails there, and that gate is what the Clarvis panel needs, so
  the webview cells rest on Firefox alone. Chrome proper, Safari and a browser with service
  workers disabled are still ungraded.
- **Trust was never granted**, so the trusted-folder path is inferred from VS Code's own
  dialog rather than observed.
- **No fork was proposed**, and none is justified: the runbook permits one only after a
  failure is reproduced that the extension API cannot reach, and neither of the two named
  candidates qualifies. SecretStorage is weaker but present and working. Audio is a real
  limitation and a fork would not fix it — in a browser the speaker belongs to the browser,
  so only routing audio through the webview would, which is a Clarvis change.
