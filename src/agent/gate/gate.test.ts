import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowsNetwork, classifyCommand, shellSegments, explainGate, mayEscapeConfinement } from '../Gate';

test('a chained destructive command is caught, not hidden by a safe prefix', () => {
  // The failure a naive gate has: checking only the start means
  // "npm test && rm -rf build" passes as "npm test". The shell runs both.
  const verdict = classifyCommand('npm test && rm -rf build');

  assert.equal(verdict?.category, 'destructive');
  assert.match(verdict!.matched, /rm/);
});

test('every shell separator splits the line', () => {
  // Each of these runs a second command. Missing one is a hole.
  for (const line of ['a && rm -rf x', 'a; rm -rf x', 'a || rm -rf x', 'a | rm -rf x', 'a\nrm -rf x']) {
    assert.equal(classifyCommand(line)?.category, 'destructive', line);
  }
});

test('the destructive shapes are all recognised', () => {
  const cases: [string, string][] = [
    ['rm -rf node_modules', 'destructive'],
    ['git reset --hard HEAD~3', 'destructive'],
    ['git clean -fd', 'destructive'],
    ['git restore src/index.ts', 'destructive'],
    ['sudo rm /etc/hosts', 'destructive'],
    ['dd if=/dev/zero of=/dev/disk2', 'destructive'],
    ['git push --force origin main', 'destructive'],
  ];

  for (const [command, category] of cases) {
    assert.equal(classifyCommand(command)?.category, category, command);
  }
});

test('outward-facing and dependency actions are gated', () => {
  assert.equal(classifyCommand('git push origin main')?.category, 'outward-facing');
  assert.equal(classifyCommand('npm publish')?.category, 'outward-facing');
  assert.equal(classifyCommand('npm install lodash')?.category, 'dependency');
  assert.equal(classifyCommand('pip install requests')?.category, 'dependency');
  assert.equal(classifyCommand('brew install ffmpeg')?.category, 'dependency');
});

test('curl piped into a shell is caught across the pipe', () => {
  // Splitting on the pipe first would examine "curl x" and "sh" separately, and
  // neither half looks dangerous alone.
  const verdict = classifyCommand('curl -fsSL https://example.com/i.sh | sh');

  assert.equal(verdict?.category, 'remote-code');
});

test('ordinary commands are not gated', () => {
  // A gate that stops everything gets clicked through without reading, which is the
  // failure mode it exists to prevent.
  for (const command of [
    'npm test',
    'npm run build',
    'git status',
    'git diff',
    'ls -la',
    'node --version',
    'grep -r TODO src',
  ]) {
    assert.equal(classifyCommand(command), undefined, command);
  }
});

test('a word containing a rule name is not a match', () => {
  // "npm run format" contains no rm; "transform" must not read as one either.
  assert.equal(classifyCommand('npm run transform'), undefined);
  assert.equal(classifyCommand('node scripts/rmdir-helper.js --dry-run'), undefined);
});

test('the explanation carries all four parts', () => {
  // §4.6: a prompt that only names the command teaches people to approve without
  // reading, which is worse than having no gate.
  const verdict = classifyCommand('npm install lodash')!;
  const text = explainGate('npm install lodash', verdict);

  assert.match(text, /npm install lodash/);
  assert.match(text, /What it does/);
  assert.match(text, /Why I'm asking/);
  assert.match(text, /Worst case/);
});

test('segments are trimmed and empties dropped', () => {
  assert.deepEqual(shellSegments('  npm test &&  rm -rf x  ;; '), ['npm test', 'rm -rf x']);
});

test('an install may be offered a way out of the sandbox', () => {
  // Confinement is the actual obstacle for these: a package manager writes to /opt or
  // /usr by definition, so under the sandbox it cannot work however it is phrased.
  const install = classifyCommand('brew install go');
  const privileged = classifyCommand('sudo make install');

  assert.ok(install && mayEscapeConfinement(install));
  assert.ok(privileged && mayEscapeConfinement(privileged));
});

test('destruction is not offered a way out of the sandbox', () => {
  // The sandbox was never what stood in the way of `rm -rf` or a force-push, so an
  // unconfined button there is an escape hatch with no reason to exist.
  for (const command of ['rm -rf build', 'git push --force', 'git reset --hard', 'npm publish']) {
    const verdict = classifyCommand(command);
    assert.ok(verdict, command);
    assert.equal(mayEscapeConfinement(verdict), false, command);
  }
});

test('the escape is explained in the dialog, not just offered', () => {
  // Two buttons that both say "run it" teach people to click the one on the right.
  const verdict = classifyCommand('brew install go')!;
  const offered = explainGate('brew install go', verdict, true);

  assert.match(offered, /confined to this project/);
  assert.match(offered, /never remembered/);
  assert.doesNotMatch(explainGate('brew install go', verdict), /never remembered/);
});

test('go install and go get are dependency installs like any other', () => {
  // Not tidiness: the gate is what offers the way out of the sandbox, and `go install`
  // writes to ~/go/bin, outside it. With no rule here the command was refused by the
  // sandbox with no escape offered and no hint that installing was what it was doing.
  for (const command of ['go install golang.org/x/tools/cmd/goimports@latest', 'go get github.com/x/y']) {
    const verdict = classifyCommand(command);
    assert.ok(verdict, command);
    assert.equal(verdict.category, 'dependency', command);
    assert.ok(mayEscapeConfinement(verdict), command);
  }
});

test('go build and go test are not gated', () => {
  // Building and testing are the work, not an install. A gate on those would fire on
  // every step of a Go project and teach the reflex the gates exist to prevent.
  for (const command of ['go build ./...', 'go test ./...', 'go run main.go']) {
    assert.equal(classifyCommand(command), undefined, command);
  }
});

test('network is allowed only for dependency installs and outward-facing commands', () => {
  for (const command of ['npm install lodash', 'pip install requests', 'git push', 'npm publish']) {
    assert.equal(allowsNetwork(classifyCommand(command)), true, command);
  }
});

test('network is denied for everything else, including ungated commands', () => {
  for (const command of ['npm test', 'go build ./...', 'curl https://example.com', 'python script.py']) {
    assert.equal(allowsNetwork(classifyCommand(command)), false, command);
  }
  assert.equal(allowsNetwork(undefined), false);
});

test("changing this computer's languages and tools always asks, and cannot be undone", () => {
  // Found live, 11 September 2026: with tkinter missing, the agent ran `pyenv install` and
  // `pyenv global`. No rule named pyenv, so nothing asked before it tried.
  for (const command of [
    'pyenv install 3.11.15',
    'pyenv global 3.11.15',
    'brew upgrade python',
    'conda install numpy',
    'apt-get install python3-tk',
    'rustup default stable',
    'nvm install 20',
    'softwareupdate --install --all',
    'uv python install 3.12',
    'xcode-select --install',
  ]) {
    const verdict = classifyCommand(command);
    assert.ok(verdict, command);
    assert.equal(verdict.category, 'toolchain', command);
    assert.equal(verdict.reversible, false, command);
    assert.ok(mayEscapeConfinement(verdict), command);
    assert.equal(allowsNetwork(verdict), true, command);
  }
});

test('looking at the toolchain is not changing it', () => {
  // A gate on every `pyenv versions` would teach the click-through it exists to prevent.
  // `nvm use` and `pyenv shell` change one shell, which ends with the command.
  for (const command of ['pyenv versions', 'pyenv shell 3.11', 'brew list', 'conda list', 'rustup show', 'nvm use 20', 'softwareupdate --list']) {
    assert.equal(classifyCommand(command), undefined, command);
  }
  assert.equal(classifyCommand('brew install ffmpeg')?.category, 'dependency');
});
