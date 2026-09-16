import * as assert from 'assert';
import * as vscode from 'vscode';
import type { WatchedCall } from '../model/callWatch';
import { ModelService } from '../model/ModelService';

/**
 * §6.4's `clarvis.model.*` from the real `ModelService` (CLARVIS.md, Clarvis 0.17.11). What is told and when is
 * unit-tested in `callWatch.test.ts`, and the id reaching the wire in `lineage.test.ts`; this checks the glue only an
 * extension host can run: a request made through the service is told when it is made and when it ends, under the
 * request id it actually sent, its role's session and the caller's trace. No model is called — `fetch` answers.
 * Settings are written at user scope only, as `engineChoice.spec.ts` does.
 */
const TRACE = 'a'.repeat(32);

suite('model request events in the extension host (CLARVIS.md §6.4)', () => {
  const set = (key: string, value: unknown) =>
    vscode.workspace.getConfiguration('clarvis').update(key, value, vscode.ConfigurationTarget.Global);

  teardown(async () => {
    for (const key of ['chat.provider', 'chat.model', 'chat.baseUrl.custom']) await set(key, undefined);
  });

  test('a chat request is told when made and when answered, under the request id it sent', async () => {
    await set('chat.provider', 'custom');
    await set('chat.model', 'ravis/clarvis-chat');
    await set('chat.baseUrl.custom', 'http://runtime.invalid');
    const context = { secrets: { get: async () => undefined } } as unknown as vscode.ExtensionContext;
    const models = new ModelService(context, () => undefined);
    const told: WatchedCall[] = [];
    const stop = models.watchCalls((call) => told.push(call));

    const sent: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers as Record<string, string>).get('x-request-id') ?? '');
      return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;

    const reply: string[] = [];
    // No prompt worth the name: the stand-in answers whatever is asked.
    const prompt = 's';
    const messages = [{ role: 'user' as const, content: 'hello' }];
    try {
      for await (const fragment of models.stream({ system: prompt, messages, traceId: TRACE })) {
        reply.push(fragment);
      }
    } finally {
      globalThis.fetch = real;
      stop();
    }

    assert.deepStrictEqual(reply, ['hi'], 'the reply is unchanged');
    assert.deepStrictEqual(told.map((call) => call.phase), ['requested', 'completed']);
    assert.strictEqual(sent.length, 1);
    for (const call of told) {
      assert.strictEqual(call.requestId, sent[0], 'the id told is the id sent');
      assert.strictEqual(call.traceId, TRACE);
      assert.strictEqual(call.sessionId, models.sessionFor('chat'));
      assert.deepStrictEqual([call.role, call.provider, call.model], ['chat', 'custom', 'ravis/clarvis-chat']);
    }
    assert.strictEqual(told[1].result, 'answered');
    assert.strictEqual(told[1].textChunks, 1);
  });
});
