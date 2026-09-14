import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { BRIEF, hostOf, MAX_FILE_BYTES, notYetAllowed, plainSite, projectFiles, scanSites, tomlStrings, urlsIn, type ProjectFiles } from './siteScan';

/**
 * The sites a Codex task will likely need, found before it starts (plan.md M15, C2b+): the host rules RAVIS applies,
 * case for case; each place the owner listed, read from a real folder; the task's own URLs; the hosts already
 * allowed dropped; and a reader that never leaves the project or returns anything but host names.
 */

function withProject(files: Record<string, string>, run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-site-scan-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), text);
    }
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** A project held in memory, for paths a real folder shouldn't have (a file above the project). */
function memory(files: Record<string, string>): ProjectFiles {
  return {
    read: (relative) => files[relative],
    list: (folder) => Object.keys(files).filter((name) => path.posix.dirname(name) === (folder || '.')).map((name) => path.posix.basename(name)),
  };
}

const hostsIn = (root: string, brief = '') => scanSites(projectFiles(root), brief).map((site) => site.host);

test("a site is plain by RAVIS's own rule, case for case (ravis/tests/test_agent_store.py)", () => {
  assert.equal(plainSite(' PyPI.org. '), 'pypi.org');
  for (const refused of ['127.0.0.1', '10.0.0.1', '::1', 'localhost', 'printer.local', 'box.lan', '*.github.com', 'pypi.org:443', 'https://pypi.org', 'pypi', 'pypi.org/simple', '']) {
    assert.equal(plainSite(refused), undefined, refused);
  }
  const defaults = [
    'registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com', 'pypi.org', 'files.pythonhosted.org', 'crates.io', 'static.rust-lang.org',
    'proxy.golang.org', 'sum.golang.org', 'rubygems.org', 'index.rubygems.org', 'repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org',
    'services.gradle.org', 'downloads.gradle.org', 'github.com', 'api.github.com', 'codeload.github.com', 'nodejs.org', 'deno.land', 'jsr.io',
  ];
  for (const site of defaults) assert.equal(plainSite(site), site, "RAVIS's default sites are plain");

  for (const refused of ['api.internal', 'nas.home.arpa', 'dev.localhost', 'a.b.lan', 'my_host.example.com', '-bad.example.com', 'example.123', 'pypi.org\u200b']) {
    assert.equal(plainSite(refused), undefined, JSON.stringify(refused));
  }
  assert.equal(plainSite('\x1cpypi.org\u3000'), 'pypi.org', "Python's strip() takes these off, which JavaScript's trim() doesn't");
  assert.equal(plainSite('\ufeffpypi.org'), undefined, "and it keeps a byte-order mark, which trim() would take off");
  assert.equal(plainSite(42), undefined);
});

test('a URL, a registry URL or a git remote gives its plain host; anything else gives none', () => {
  const cases: [string, string | undefined][] = [
    ['https://registry.example.com/', 'registry.example.com'],
    ['https://user:secret@npm.pkg.github.com:443/org', 'npm.pkg.github.com'],
    ['sparse+https://index.example.org/', 'index.example.org'],
    ['registry+https://github.com/rust-lang/crates.io-index', 'github.com'],
    ['git+https://gitlab.example.com/team/lib.git', 'gitlab.example.com'],
    ['git@github.com:org/repo.git', 'github.com'],
    ['ssh://git@git.example.net:2222/org/repo.git', 'git.example.net'],
    ['"https://quoted.example.com/simple"', 'quoted.example.com'],
    ['http://localhost:4873/', undefined],
    ['http://127.0.0.1:8080/simple', undefined],
    ['http://[::1]:3000/', undefined],
    ['https://${NPM_HOST}/', undefined],
    ['file:///Users/owner/wheels', undefined],
    ['../sibling.git', undefined],
    ['pypi.org', undefined],
  ];
  for (const [value, host] of cases) assert.equal(hostOf(value), host, value);
});

test('.npmrc: its registries, never an auth token line or a comment, and nothing but hosts comes back', () =>
  withProject(
    {
      '.npmrc': [
        'registry=https://registry.corp.example.com/npm/',
        '@acme:registry = https://npm.pkg.github.com',
        '//registry.corp.example.com/npm/:_authToken=npm_SECRET_TOKEN_VALUE',
        '; https://semicolon-comment.example.com',
        '# https://hash-comment.example.com',
        'always-auth=true',
        'homepage=https://not-a-registry.example.com/',
        '@local:registry=http://localhost:4873',
      ].join('\n'),
    },
    (root) => {
      const found = scanSites(projectFiles(root), '');
      assert.deepEqual(found, [
        { host: 'registry.corp.example.com', foundIn: ['.npmrc'] },
        { host: 'npm.pkg.github.com', foundIn: ['.npmrc'] },
      ]);
      assert.doesNotMatch(JSON.stringify(found), /SECRET/);
    }
  ));

test('pip.conf: every index setting, in any section, several URLs over continuation lines', () =>
  withProject(
    {
      'pip.conf': [
        '[global]',
        'index-url = https://pypi.corp.example.com/simple',
        'extra-index-url =',
        '    https://download.pytorch.org/whl/cpu',
        '    https://extra.example.org/simple',
        'trusted-host = not-an-index.example.com',
        '[install]',
        'find_links = https://wheels.example.net/',
        'timeout = 60',
      ].join('\n'),
    },
    (root) => assert.deepEqual(hostsIn(root), ['pypi.corp.example.com', 'download.pytorch.org', 'extra.example.org', 'wheels.example.net'])
  ));

test('requirements*.txt: the index options of each, and of the files they include, each file once', () =>
  withProject(
    {
      'requirements.txt': [
        '--index-url https://pypi.corp.example.com/simple',
        '-r requirements/base.txt',
        '-c constraints.txt   # pinned',
        'requests==2.32.0 # http://a-comment.example.com',
        '--extra-index-url=https://extra.example.org/simple \\',
        '  --find-links https://wheels.example.net/',
      ].join('\n'),
      'requirements-dev.txt': '--extra-index-url https://dev.example.com/simple\n',
      'requirements/base.txt': '-i https://base-index.example.com/simple\n-r ../requirements-dev.txt\n',
      'constraints.txt': '--find-links https://constraints.example.com/\n',
    },
    (root) => {
      const found = scanSites(projectFiles(root), '');
      assert.deepEqual(found.map((site) => site.host), [
        'dev.example.com',
        'pypi.corp.example.com',
        'extra.example.org',
        'wheels.example.net',
        'base-index.example.com',
        'constraints.example.com',
      ]);
      assert.deepEqual(found.find((site) => site.host === 'base-index.example.com')?.foundIn, ['requirements/base.txt']);
    }
  ));

test('an include that leaves the project is never followed', () => {
  const project = memory({
    'requirements.txt': '-r ../outside.txt\n--requirement /etc/requirements.txt\n',
    '../outside.txt': '--index-url https://outside.example.com/simple\n',
    'etc/requirements.txt': '--index-url https://absolute.example.com/simple\n',
  });
  assert.deepEqual(scanSites(project, ''), []);
});

test('pyproject.toml: where uv, Poetry, PDM and Rye name their indexes, and nothing else that holds a URL', () =>
  withProject(
    {
      'pyproject.toml': [
        '[project]',
        'name = "demo"',
        'dependencies = ["requests>=2", "internal-lib @ https://direct.example.com/lib.whl"]  # a direct URL, not an index',
        '',
        '[tool.uv]',
        'index-url = "https://uv-index.example.com/simple"',
        'extra-index-url = [',
        '  "https://uv-extra-1.example.com/simple",  # first',
        "  'https://uv-extra-2.example.com/simple',",
        ']',
        '',
        '[[tool.uv.index]]',
        'name = "pytorch"',
        'url = "https://download.pytorch.org/whl/cu121"',
        '',
        '[[tool.poetry.source]]',
        'name = "corp"',
        'url = "https://poetry.corp.example.com/simple/"',
        'priority = "primary"',
        '',
        '[tool.pdm]',
        '[[tool.pdm.source]]',
        'url = "https://pdm.example.org/simple"',
        'verify_ssl = true',
        '',
        '[[tool.rye.sources]]',
        'name = "default"',
        'url = "https://rye.example.net/simple"',
        '',
        '[tool.something-else]',
        'url = "https://not-an-index.example.com"',
      ].join('\n'),
    },
    (root) =>
      assert.deepEqual(hostsIn(root), [
        'uv-index.example.com',
        'uv-extra-1.example.com',
        'uv-extra-2.example.com',
        'download.pytorch.org',
        'poetry.corp.example.com',
        'pdm.example.org',
        'rye.example.net',
      ])
  ));

test("Cargo.toml's registry indexes and .cargo/config.toml's registries and source replacements; a git dependency is not a registry", () =>
  withProject(
    {
      'Cargo.toml': [
        '[package]',
        'name = "demo"',
        '',
        '[dependencies]',
        'serde = "1"',
        'internal = { version = "0.3", registry-index = "sparse+https://cargo-index.corp.example.com/" }',
        'git-dep = { git = "https://github.com/org/dep.git" }',
        '',
        '[dependencies.other]',
        'version = "1"',
        'registry-index = "https://other-index.example.org/git/index"',
      ].join('\n'),
      '.cargo/config.toml': [
        '[registries]',
        'corp = { index = "sparse+https://registry.corp.example.com/index/" }',
        '',
        '[registries.mirror]',
        'index = "https://mirror.example.net/crates.io-index"',
        '',
        '[source.crates-io]',
        'replace-with = "vendored"',
        '',
        '[source.vendored]',
        'registry = "sparse+https://vendor.example.org/"',
        '',
        '[source.from-git]',
        'git = "https://git.example.com/crates-index"',
        '',
        '[net]',
        'git-fetch-with-cli = true',
        '',
        '[http]',
        'proxy = "http://proxy.corp.example.com:3128"',
      ].join('\n'),
    },
    (root) =>
      assert.deepEqual(hostsIn(root), [
        'cargo-index.corp.example.com',
        'other-index.example.org',
        'registry.corp.example.com',
        'mirror.example.net',
        'vendor.example.org',
        'git.example.com',
      ])
  ));

test("the older .cargo/config is read too, the Gemfile's sources, and each submodule's URL — git@ remotes included", () =>
  withProject(
    {
      '.cargo/config': '[registry]\nindex = "https://default-registry.example.com/index"\n',
      Gemfile: [
        'source "https://rubygems.org"',
        "source 'https://gems.corp.example.com' do",
        "  gem 'internal'",
        'end',
        'source("https://gems.other.example.org")',
        "gem 'rails', git: 'https://github.com/rails/rails.git'",
      ].join('\n'),
      '.gitmodules': [
        '[submodule "vendor/lib"]',
        '\tpath = vendor/lib',
        '\turl = https://gitlab.example.com/team/lib.git',
        '[submodule "tools"]',
        '\tpath = tools',
        '\turl = git@github.com:org/tools.git',
        '[submodule "relative"]',
        '\turl = ../relative.git',
      ].join('\n'),
    },
    (root) =>
      assert.deepEqual(hostsIn(root), [
        'default-registry.example.com',
        'rubygems.org',
        'gems.corp.example.com',
        'gems.other.example.org',
        'gitlab.example.com',
        'github.com',
      ])
  ));

test("the task's own URLs count too; each host is listed once, with every place it was found", () =>
  withProject({ '.npmrc': 'registry=https://registry.corp.example.com/\n', Gemfile: 'source "https://rubygems.org"\n' }, (root) => {
    const brief =
      'Use the API at https://api.stripe.com/v1 (see https://docs.example.com/guide), and the registry https://registry.corp.example.com/pkg. ' +
      'Webhooks come from https://api.stripe.com/webhooks. Not http://localhost:3000.';
    assert.deepEqual(scanSites(projectFiles(root), brief), [
      { host: 'registry.corp.example.com', foundIn: ['.npmrc', BRIEF] },
      { host: 'rubygems.org', foundIn: ['Gemfile'] },
      { host: 'api.stripe.com', foundIn: [BRIEF] },
      { host: 'docs.example.com', foundIn: [BRIEF] },
    ]);
    assert.deepEqual(urlsIn('see [the docs](https://docs.example.com/a) and <https://b.example.org>.'), ['https://docs.example.com/a', 'https://b.example.org']);
  }));

test('hosts already allowed are dropped: an exact entry, or a wildcard for a subdomain — never for the name itself', () => {
  const found = ['registry.npmjs.org', 'index.crates.io', 'crates.io', 'objects.githubusercontent.com', 'api.stripe.com', 'evilgithubusercontent.com', 'githubusercontent.com'].map(
    (host) => ({ host, foundIn: [BRIEF] })
  );
  const allowed = ['registry.npmjs.org', 'crates.io', '*.crates.io', '*.githubusercontent.com'];
  assert.deepEqual(notYetAllowed(found, allowed).map((site) => site.host), ['api.stripe.com', 'evilgithubusercontent.com', 'githubusercontent.com']);
});

test('TOML: quoted keys, comments, literal and escaped strings, nested inline tables and arrays', () => {
  const strings = tomlStrings(
    [
      '# comment = "https://ignored.example.com"',
      '[registries."my-reg"]',
      'index = "https://quoted-key.example.com/index" # trailing comment',
      "literal = 'https://literal.example.com/a#not-a-comment'",
      'escaped = "https://escaped.example.com/\\"quote\\""',
      'nested = { inner = { url = "https://nested.example.com" }, list = ["https://list.example.com", "x,y"] }',
    ].join('\n')
  );
  assert.deepEqual(
    strings.map((entry) => [entry.path.join('.'), entry.value]),
    [
      ['registries.my-reg.index', 'https://quoted-key.example.com/index'],
      ['registries.my-reg.literal', 'https://literal.example.com/a#not-a-comment'],
      ['registries.my-reg.escaped', 'https://escaped.example.com/\\"quote\\"'],
      ['registries.my-reg.nested.inner.url', 'https://nested.example.com'],
      ['registries.my-reg.nested.list', 'https://list.example.com'],
      ['registries.my-reg.nested.list', 'x,y'],
    ]
  );
});

test('the reader never follows a link out of the project, skips a file past the size cap, and a missing folder finds only the task\'s URLs', () =>
  withProject({ 'elsewhere/.npmrc': 'registry=https://outside-the-project.example.com/\n' }, (base) => {
    const root = path.join(base, 'project');
    fs.mkdirSync(root);
    fs.symlinkSync(path.join(base, 'elsewhere', '.npmrc'), path.join(root, '.npmrc'));
    fs.writeFileSync(path.join(root, 'Gemfile'), `source "https://rubygems.org"\n${'#'.repeat(MAX_FILE_BYTES)}\n`);
    fs.writeFileSync(path.join(base, 'elsewhere', 'Cargo.toml'), '[dependencies]\nx = { registry-index = "https://linked-inside.example.com/" }\n');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.symlinkSync(path.join(base, 'elsewhere', 'Cargo.toml'), path.join(root, 'Cargo.toml'));

    assert.deepEqual(hostsIn(root), [], 'a link out of the project, and a file past the size cap, are not read');
    assert.deepEqual(scanSites(projectFiles(path.join(base, 'no-such-folder')), 'https://api.example.com').map((site) => site.host), ['api.example.com']);
  }));
