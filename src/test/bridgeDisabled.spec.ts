import * as assert from 'assert';
import * as net from 'net';
import * as vscode from 'vscode';

import { Activity } from '../bridge/activity';
import { startBridge } from '../bridge/wire';

/**
 * Stage 8's last exit clause: disabling the Bridge restores exact standalone
 * behaviour.
 *
 * This existed only as a reading of the source. `startBridge` returns at its
 * settings check before constructing anything, so "off means nothing is bound
 * rather than a socket that refuses" was true by inspection — but the line doing
 * the returning is `vscode.workspace.getConfiguration`, which cannot run outside
 * a real extension host. Every other Bridge test drives the compiled output from
 * node, which is the same code and not the same environment.
 *
 * The off case alone would be a test that passes when the function is broken,
 * renamed, or never called — "nothing happened" is what a no-op does too. So the
 * on case runs in the same file, against the same real settings object, and has
 * to bind for the off case to mean anything.
 */
suite('bridge disabled restores standalone behaviour', () => {
  const settings = () => vscode.workspace.getConfiguration('clarvis.bridge');

  /** Whatever the fixture workspace had, so the suite leaves no setting changed. */
  let original: boolean | undefined;
  let originalUrl: string | undefined;

  suiteSetup(async () => {
    original = settings().get<boolean>('enabled');
    originalUrl = settings().get<string>('nervisUrl');
  });

  suiteTeardown(async () => {
    await settings().update('enabled', original, vscode.ConfigurationTarget.Global);
    await settings().update('nervisUrl', originalUrl, vscode.ConfigurationTarget.Global);
  });

  /**
   * A context with its own `globalState`, so the Bridge mints a throwaway
   * identity instead of reading — or worse, writing — the real installation's.
   */
  const scratchContext = (): vscode.ExtensionContext => {
    const store = new Map<string, unknown>();
    return {
      subscriptions: [],
      globalState: {
        get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
        update: async (key: string, value: unknown) => void store.set(key, value),
        keys: () => [...store.keys()],
        setKeysForSync: () => {},
      },
    } as unknown as vscode.ExtensionContext;
  };

  /** Resolves true if something accepts a TCP connection on `port`. */
  const answers = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net
        .connect({ host: '127.0.0.1', port })
        .on('connect', () => {
          socket.destroy();
          resolve(true);
        })
        .on('error', () => resolve(false));
      socket.setTimeout(1_000, () => {
        socket.destroy();
        resolve(false);
      });
    });

  test('the shipped default is off', () => {
    // The clause is about what an untouched install does, so the default is part
    // of the claim rather than a detail of the fixture.
    const declared = vscode.extensions.getExtension('Krimkerre.clarvis')!.packageJSON.contributes
      .configuration.properties['clarvis.bridge.enabled'].default;
    assert.equal(declared, false, 'package.json must ship the Bridge off');
  });

  test('off binds nothing, registers nothing, and says nothing', async () => {
    await settings().update('enabled', false, vscode.ConfigurationTarget.Global);

    const said: string[] = [];
    const handle = await startBridge(
      scratchContext(),
      new Activity(),
      (line) => said.push(line)
    );

    assert.equal(handle, undefined, 'a handle means something was constructed');
    // No log line at all: a Bridge that announces itself declining is still a
    // difference from standalone, and this clause is about *exact* behaviour.
    assert.deepEqual(said, [], `standalone must be silent, said: ${said.join(' | ')}`);
  });

  test('on binds a real port — so the off case above could have failed', async () => {
    // Pointed at a port nothing listens on, so registration fails harmlessly and
    // this test never creates a real lease in the operator's running NERVIS. The
    // socket still binds, which is the part being demonstrated.
    await settings().update('nervisUrl', 'http://127.0.0.1:9', vscode.ConfigurationTarget.Global);
    await settings().update('enabled', true, vscode.ConfigurationTarget.Global);

    const handle = await startBridge(scratchContext(), new Activity(), () => {});

    assert.ok(handle, 'enabled must produce a handle, or the off assertion proves nothing');
    const port = handle.bridge.port;
    assert.ok(port > 0, 'a started Bridge must report the port the OS gave it');
    assert.equal(await answers(port), true, 'the port a started Bridge reports must accept a connection');

    await handle.stop();
    assert.equal(await answers(port), false, 'stop() must release the port');
  });
});
