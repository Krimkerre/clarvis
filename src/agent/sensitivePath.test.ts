import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPath } from './sensitivePath';

test('ordinary source files are not flagged', () => {
  for (const p of ['README.md', 'src/index.ts', 'package.json', 'plan.md', '.gitignore']) {
    assert.equal(classifyPath(p), undefined, p);
  }
});

test('.env files are flagged as secrets, at any depth', () => {
  for (const p of ['.env', '.env.local', '.env.production', 'server/.env']) {
    assert.equal(classifyPath(p)?.category, 'secret', p);
  }
});

test('cloud and database credential files are flagged', () => {
  for (const p of ['credentials.json', '.aws/credentials', 'service-account-prod.json', '.pgpass', '.npmrc']) {
    assert.equal(classifyPath(p)?.category, 'secret', p);
  }
});

test('private key material is flagged as the stronger category', () => {
  for (const p of ['id_rsa', 'id_ed25519', '.ssh/id_rsa', 'server.pem', 'client.p12']) {
    assert.equal(classifyPath(p)?.category, 'key', p);
  }
});

test('a filename that merely contains "env" is not flagged', () => {
  // Substring matching would catch environment.ts, envConfig.js — real source files.
  assert.equal(classifyPath('src/environment.ts'), undefined);
  assert.equal(classifyPath('envConfig.js'), undefined);
});
