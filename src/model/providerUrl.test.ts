import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptableOverride, providerSpec, resolveBaseUrl, providerNotRespondingLine, providerListedNothingLine } from './providers';

/**
 * Raised in a security review: a workspace could set this and the API key would
 * follow. The setting is machine-scoped now so a project cannot write it at all —
 * this is the second layer, for when it is set legitimately and wrongly.
 */

test('https anywhere is allowed, because that is the point of the setting', () => {
  assert.equal(acceptableOverride('https://my-gateway.internal/v1'), 'https://my-gateway.internal/v1');
});

test('a keyed provider may use plain http only to this machine', () => {
  // A proxy on your own machine is normal; off-machine http would put the key on the
  // wire in clear text.
  assert.equal(acceptableOverride('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.equal(acceptableOverride('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1');
  assert.equal(acceptableOverride('http://evil.example/v1'), undefined);
});

test('a keyless provider may point anywhere over http', () => {
  // There is no credential to leak, and a model server on the machine under the desk
  // is exactly what this setting was added for. Banning it would cost a real setup to
  // prevent nothing.
  assert.equal(acceptableOverride('http://box:1234', false), 'http://box:1234');
  assert.equal(acceptableOverride('http://192.168.1.40:11434', false), 'http://192.168.1.40:11434');
});

test('a hostname that merely contains localhost is not localhost', () => {
  // `https://localhost.evil.example` passes a substring check and resolves to
  // someone else's server. Exact matches only.
  assert.equal(acceptableOverride('http://localhost.evil.example/v1'), undefined);
  assert.equal(acceptableOverride('http://notlocalhost/v1'), undefined);
});

test('anything unparseable is ignored rather than trusted', () => {
  assert.equal(acceptableOverride('not a url'), undefined);
  assert.equal(acceptableOverride('file:///etc/passwd'), undefined);
  assert.equal(acceptableOverride('file:///etc/passwd', false), undefined, 'even keyless is http(s) only');
  assert.equal(acceptableOverride(''), undefined);
  assert.equal(acceptableOverride(undefined), undefined);
});

test('a rejected override falls back to the real provider, silently', () => {
  // The safe outcome is a working request to the right place. Breaking the extension
  // over a settings value nobody remembers writing would be worse.
  const spec = providerSpec('openai')!;
  assert.equal(resolveBaseUrl(spec, 'http://evil.example/v1'), spec.baseUrl.replace(/\/+$/, ''));
});

test('a legitimate override still wins', () => {
  assert.equal(resolveBaseUrl(providerSpec('ollama')!, 'http://localhost:11434'), 'http://localhost:11434');
});

// F13 -- a local provider that isn't running used to say nothing at all.

test('a refused connection gets a specific, actionable sentence', () => {
  const line = providerNotRespondingLine('Ollama', 'http://localhost:11434');
  assert.match(line, /Ollama/);
  assert.match(line, /http:\/\/localhost:11434/);
  assert.match(line, /Is it running\?/);
});

test('an unreachable provider and a reachable-but-empty one get different sentences', () => {
  const notRunning = providerNotRespondingLine('LM Studio', 'http://localhost:1234');
  const nothingLoaded = providerListedNothingLine('LM Studio', 'http://localhost:1234');
  assert.notEqual(notRunning, nothingLoaded);
  assert.match(nothingLoaded, /has one been loaded yet\?/);
});
