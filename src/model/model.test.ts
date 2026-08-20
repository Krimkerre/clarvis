import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser } from './sse';
import { PROVIDERS, providerSpec, resolveBaseUrl, acceptableOverride } from './providers';
import { describeHttpFailure, ModelError } from './ModelProvider';

test('an event split across chunks is not lost', () => {
  // The bug this exists for: chunk boundaries fall wherever the network puts them.
  // A parser that assumes one chunk is one event passes every local test and drops
  // tokens against a real connection.
  const parser = new SseParser();

  assert.deepEqual(parser.push('data: {"a":'), []);
  assert.deepEqual(parser.push('1}\n'), ['{"a":1}']);
});

test('several events in one chunk all arrive, in order', () => {
  const parser = new SseParser();

  assert.deepEqual(parser.push('data: one\ndata: two\ndata: three\n'), ['one', 'two', 'three']);
});

test('keep-alive comments and blank lines are skipped', () => {
  // Some providers send `:` pings to hold the connection open. Parsing one as data
  // would inject an empty fragment into the middle of a reply.
  const parser = new SseParser();

  assert.deepEqual(parser.push(': ping\n\ndata: real\n'), ['real']);
});

test('\\r\\n line endings parse the same as \\n', () => {
  const parser = new SseParser();

  assert.deepEqual(parser.push('data: value\r\n'), ['value']);
});

test('a trailing partial line waits rather than being emitted half-formed', () => {
  const parser = new SseParser();

  assert.deepEqual(parser.push('data: complete\ndata: incomp'), ['complete']);
  assert.deepEqual(parser.push('lete\n'), ['incomplete']);
});

test('every provider either ships an address or asks for one', () => {
  // Was "every provider has a usable spec", asserting a baseUrl starting with http.
  // `custom` broke that on purpose: it exists because the address is unknowable, and a
  // default would connect to whatever happened to be on that port. The invariant it
  // replaces is stricter, not looser — no provider may end up with nowhere to send a
  // request and no way to be told where.
  for (const provider of PROVIDERS) {
    assert.ok(provider.baseUrl.startsWith('http') || provider.needsUrl === true, provider.id);
    assert.ok(provider.defaultModel.length > 0, provider.id);
    assert.ok(provider.detail.length > 0, provider.id);
  }
});

test('local providers need no key, hosted ones do', () => {
  // Getting this backwards would either demand a key for localhost or silently send
  // an unauthenticated request to a paid endpoint.
  assert.equal(providerSpec('ollama')!.needsKey, false);
  assert.equal(providerSpec('lmstudio')!.needsKey, false);
  assert.equal(providerSpec('anthropic')!.needsKey, true);
  assert.equal(providerSpec('openai')!.needsKey, true);
});

test('no provider offers a Claude subscription login', () => {
  // M8b0: not permitted for third-party products without prior Anthropic approval.
  // A test rather than a comment, because this is the kind of row someone adds back
  // in six months because it would be convenient.
  const ids = PROVIDERS.map((provider) => provider.id);

  assert.ok(!ids.some((id) => /subscription|claude-?ai|oauth/i.test(id)));
  assert.equal(providerSpec('anthropic')!.needsKey, true);
});

test('a base URL override wins, and trailing slashes never double up', () => {
  const spec = providerSpec('ollama')!;

  assert.equal(resolveBaseUrl(spec), 'http://localhost:11434');
  assert.equal(resolveBaseUrl(spec, 'http://box:1234/'), 'http://box:1234');
  assert.equal(resolveBaseUrl(spec, '   '), 'http://localhost:11434');
});

test('HTTP failures say what to do about them', () => {
  // "Request failed" is what makes an unconfigured integration feel broken. Each of
  // these has a different fix, so each gets a different sentence.
  const auth = describeHttpFailure(401, 'nope', 'OpenAI');
  const limited = describeHttpFailure(429, 'slow down', 'OpenAI');
  const missing = describeHttpFailure(404, 'no model', 'OpenAI');
  const broken = describeHttpFailure(503, 'oops', 'OpenAI');

  assert.match(auth.friendly, /key/i);
  assert.match(missing.friendly, /model/i);
  assert.equal(limited.retryable, true);
  assert.equal(broken.retryable, true);
  assert.equal(auth.retryable, false);
  assert.ok(auth instanceof ModelError);
});

test('failure detail is kept out of the friendly sentence', () => {
  // §4.6: an in-character error in the transcript, the raw detail in the log — a
  // response body pasted into chat is how a key ends up on someone's screen share.
  const error = describeHttpFailure(401, 'sk-secret-looking-body', 'Anthropic');

  assert.ok(!error.friendly.includes('sk-secret-looking-body'));
  assert.ok(error.detail.includes('sk-secret-looking-body'));
});

import { resolveRole, RoleSettings } from './roles';

function settings(overrides: Partial<RoleSettings> = {}): RoleSettings {
  return { chatProvider: 'ollama', chatModel: 'llama3.2:3b', agentProvider: '', agentModel: '', ...overrides };
}

test('unset agent settings follow chat, so one model stays one model', () => {
  // Someone who never touches this must not suddenly be running two configurations.
  const resolved = resolveRole('agent', settings());

  assert.equal(resolved.provider, 'ollama');
  assert.equal(resolved.model, 'llama3.2:3b');
  assert.equal(resolved.inherited, true);
});

test('an agent model alone means same account, better model', () => {
  // The common split: one provider, a cheaper model for chat.
  const resolved = resolveRole('agent', settings({ agentModel: 'llama3.1:70b' }));

  assert.equal(resolved.provider, 'ollama');
  assert.equal(resolved.model, 'llama3.1:70b');
  assert.equal(resolved.inherited, false);
});

test('a different agent provider does not inherit the chat model name', () => {
  // "llama3.2:3b" means nothing to Anthropic. Carrying it across produces a 404 that
  // looks like a Clarvis bug rather than a configuration one.
  const resolved = resolveRole('agent', settings({ agentProvider: 'anthropic' }));

  assert.equal(resolved.provider, 'anthropic');
  assert.equal(resolved.model, '');
});

test('the chat role never inherits from the agent', () => {
  const resolved = resolveRole('chat', settings({ agentProvider: 'anthropic', agentModel: 'claude-opus-5' }));

  assert.equal(resolved.provider, 'ollama');
  assert.equal(resolved.model, 'llama3.2:3b');
});

test('whitespace-only settings count as unset', () => {
  const resolved = resolveRole('agent', settings({ agentProvider: '   ', agentModel: '  ' }));

  assert.equal(resolved.provider, 'ollama');
  assert.equal(resolved.inherited, true);
});

test('Anthropic stays at the head of the provider list', () => {
  // Not cosmetic: ModelService.spec() falls back to PROVIDERS[0] when it cannot resolve a
  // configured provider, so reordering this array changes the default.
  assert.equal(PROVIDERS[0].id, 'anthropic');
});

test('the local providers are offered easiest-first', () => {
  // The order is the recommendation. §6 budgets one install step and says that needing a
  // config file is a failure: LM Studio picks a model in a search box, Ollama needs
  // `ollama pull` in a terminal, and Custom needs you to know a URL. All three ship —
  // order and wording are the intervention, not removal.
  const local = PROVIDERS.filter((spec) => !spec.needsKey).map((spec) => spec.id);
  assert.deepEqual(local, ['lmstudio', 'ollama', 'custom']);
});

test('only the custom provider has to ask for an address', () => {
  // Every other row knows where its server is. Asking anyway would be a question with a
  // right answer already in the code.
  const asking = PROVIDERS.filter((spec) => spec.needsUrl).map((spec) => spec.id);
  assert.deepEqual(asking, ['custom']);
});

test('the custom provider ships no address to guess with', () => {
  // A default would be a lie about a server we cannot know the location of, and worse, a
  // silent one: it would connect to whatever happened to be on that port.
  assert.equal(PROVIDERS.find((spec) => spec.id === 'custom')?.baseUrl, '');
});

test('a keyless provider accepts a plain-http address anywhere', () => {
  // The loopback-or-https rule exists to stop a key crossing the wire in clear text.
  // There is no key here, and a local server on another machine is an ordinary setup.
  assert.equal(acceptableOverride('http://192.168.1.50:8080', false), 'http://192.168.1.50:8080');
  assert.equal(acceptableOverride('http://192.168.1.50:8080', true), undefined);
});

test('a custom address still has to be a real http address', () => {
  for (const nonsense of ['localhost:8080', 'ftp://box/v1', 'not a url', '']) {
    assert.equal(acceptableOverride(nonsense, false), undefined, nonsense);
  }
});

test('neither local provider describes itself in terms of the other', () => {
  // "Same as Ollama, different port" told a new user nothing about which to pick, and
  // presented a GUI and a terminal as equivalent.
  for (const spec of PROVIDERS.filter((s) => !s.needsKey)) {
    assert.doesNotMatch(spec.detail ?? '', /same as/i, spec.id);
  }
});

test('both local providers still say the work stays on the machine', () => {
  // The demotion must not cost Ollama the privacy claim, which is the reason either of
  // them is offered.
  for (const spec of PROVIDERS.filter((s) => !s.needsKey)) {
    assert.match(spec.detail ?? '', /local|nothing leaves it/i, spec.id);
  }
});
