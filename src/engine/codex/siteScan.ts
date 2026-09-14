/**
 * The sites a Codex task will likely need, found before it starts (plan.md M15, C2b+; the ecosystem's build notes,
 * "Owner decisions 14 Sep 2026", option 1).
 *
 * **Why look first.** Codex's commands reach only the sites RAVIS allows, and Codex reads that list when it loads a
 * task: a site allowed before the task starts works from its first step, while one allowed mid-task needs the task
 * reopened, which takes about a minute. So before a task starts, Clarvis reads the places a project names the
 * servers its tools will fetch from, drops the hosts already allowed, and — if any remain — asks the owner once
 * (`siteAsks.ts`, `preTaskAsk`).
 *
 * **Where it looks** — the owner's list, exactly:
 * - `.npmrc`: `registry` and `@scope:registry`. Never the `_authToken` lines beside them;
 * - `pip.conf`: `index-url`, `extra-index-url` and `find-links`;
 * - `requirements*.txt` in the project folder: `-i`/`--index-url`, `--extra-index-url` and `-f`/`--find-links`,
 *   following `-r` and `-c` includes that stay inside the project;
 * - `pyproject.toml`: the index and source settings of uv, Poetry, PDM and Rye;
 * - `Cargo.toml`: a dependency's `registry-index`; `.cargo/config.toml` (or the older `.cargo/config`): registries'
 *   `index`, `registry.index`, and a source replacement's `registry` or `git`;
 * - `Gemfile`: `source`;
 * - `.gitmodules`: each submodule's `url`, including the `git@host:path` form;
 * - the task's own text: every URL in it.
 * A package's own dependency URLs aren't looked for: a site a command is blocked from mid-task is still asked then.
 *
 * **The same host rules RAVIS applies** (`ravis/src/ravis/agent/sites.py`, `plain_site`): an exact, lower-cased host
 * name made of dotted labels ending in a name — never an IP address, `localhost`, a local name (`.local`,
 * `.localhost`, `.internal`, `.home.arpa`, `.lan`), a wildcard, a port or a path. A host RAVIS would refuse is never
 * asked about: allowing it could only fail.
 *
 * **Only hosts leave this module.** It reads files that can hold registry passwords (`.npmrc`, `pip.conf`); nothing
 * but the host names it finds is returned, and nothing is logged.
 *
 * Pure, given the files (`ProjectFiles`); `projectFiles` is the reader for a real folder.
 */

import * as fs from 'fs';
import { isIP } from 'net';
import * as path from 'path';

/** A project's files, by path relative to its root: a file's text (undefined when missing or unreadable), a folder's file names. */
export interface ProjectFiles {
  read(relativePath: string): string | undefined;
  list(relativeFolder: string): string[];
}

/** A host the task will likely need, and where it was found — file names, or `BRIEF` for the task's text. */
export interface FoundSite {
  host: string;
  foundIn: string[];
}

export const BRIEF = 'the task';

/** The biggest file read: a registry setting lives in a small file, and a huge one isn't worth the wait. */
export const MAX_FILE_BYTES = 512 * 1024;

/** How deep `-r` includes are followed. */
const MAX_INCLUDE_DEPTH = 3;

/** Every host the project's settings and the task name, each once, in the order they were first found. */
export function scanSites(files: ProjectFiles, brief: string): FoundSite[] {
  const found = new Map<string, string[]>();
  const note = (value: string, where: string) => {
    const host = hostOf(value);
    if (!host) return;
    const places = found.get(host) ?? [];
    if (!places.includes(where)) places.push(where);
    found.set(host, places);
  };
  for (const [where, values] of settingsIn(files)) for (const value of values) note(value, where);
  for (const url of urlsIn(brief)) note(url, BRIEF);
  return [...found].map(([host, foundIn]) => ({ host, foundIn }));
}

/** The hosts found that no allowed site covers: an exact match, or a `*.example.com` entry for one of its subdomains. */
export function notYetAllowed(found: readonly FoundSite[], allowed: readonly string[]): FoundSite[] {
  return found.filter((site) => !allowed.some((entry) => covers(entry, site.host)));
}

function covers(entry: string, host: string): boolean {
  const pattern = entry.trim().toLowerCase();
  return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : pattern === host;
}

// ── The host rules RAVIS applies ─────────────────────────────────────────────

/** `sites.py`'s `HOST`: dotted labels ending in a name, lower-case; no port, path, scheme or wildcard. */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Names that only ever mean this Mac or its local network (`sites.py`'s `LOCAL_SUFFIXES`). */
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.lan'];

/** The characters Python's `str.strip()` takes off, which differ from JavaScript's `trim()`: no BOM, and \x1c–\x1f and \x85 too. */
const PYTHON_SPACE = /^[\t\n\x0b\x0c\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\x0b\x0c\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/** `value` as a site the owner may allow — a plain public host name, lower-cased — or undefined: `plain_site`, rule for rule. */
export function plainSite(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const host = value.replace(PYTHON_SPACE, '').toLowerCase().replace(/\.+$/, '');
  if (!HOST.test(host) || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return undefined;
  return isIP(host) === 0 ? host : undefined;
}

/** The plain host a URL, a `sparse+https://` registry or a `git@host:path` remote names; undefined for anything else. */
export function hostOf(value: string): string | undefined {
  const text = value.trim().replace(/^["']|["']$/g, '');
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]*)/i.exec(text);
  if (url) return plainSite(authorityHost(url[1]));
  const remote = /^[^\s@/:]+@([^\s:/]+):(?!\/)/.exec(text);
  return remote ? plainSite(remote[1]) : undefined;
}

/** The host part of `user:password@host:port`. */
function authorityHost(authority: string): string {
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  return host.startsWith('[') ? host : host.replace(/:\d*$/, '');
}

// ── Where the settings are ───────────────────────────────────────────────────

type Found = [where: string, values: string[]];

function settingsIn(files: ProjectFiles): Found[] {
  return [
    ...fileValues(files, '.npmrc', npmrcValues),
    ...fileValues(files, 'pip.conf', pipConfValues),
    ...requirementsValues(files),
    ...fileValues(files, 'pyproject.toml', pyprojectValues),
    ...fileValues(files, 'Cargo.toml', cargoTomlValues),
    ...fileValues(files, '.cargo/config.toml', cargoConfigValues),
    ...fileValues(files, '.cargo/config', cargoConfigValues),
    ...fileValues(files, 'Gemfile', gemfileValues),
    ...fileValues(files, '.gitmodules', gitmodulesValues),
  ];
}

function fileValues(files: ProjectFiles, name: string, read: (text: string) => string[]): Found[] {
  const text = files.read(name);
  return text === undefined ? [] : [[name, read(text)]];
}

/** Every URL in some text: a scheme, `://`, and what follows up to a space, a quote or a closing bracket. */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)\]}]+/gi)].map((match) => match[0]);
}

/** `.npmrc`: `registry=` and `@scope:registry=`. An `_authToken` line names a host too, but is never read. */
function npmrcValues(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const setting = /^\s*([^=\s#;][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (!setting) return [];
    return setting[1] === 'registry' || /^@[^:\s]+:registry$/.test(setting[1]) ? [setting[2]] : [];
  });
}

const PIP_CONF_KEYS = new Set(['index-url', 'extra-index-url', 'find-links']);

/** `pip.conf`: the index settings, in any section, each possibly several URLs over continuation lines. */
function pipConfValues(text: string): string[] {
  return iniSettings(text)
    .filter((setting) => PIP_CONF_KEYS.has(setting.key))
    .flatMap((setting) => setting.value.split(/\s+/).filter(Boolean));
}

/** `.gitmodules`: every submodule's `url`. */
function gitmodulesValues(text: string): string[] {
  return iniSettings(text)
    .filter((setting) => setting.section.startsWith('submodule') && setting.key === 'url')
    .map((setting) => setting.value);
}

/** `Gemfile`: `source "…"`, `source('…')`, `source '…' do`. */
function gemfileValues(text: string): string[] {
  return [...text.matchAll(/^\s*source\s*\(?\s*(["'])([^"'\n]+)\1/gm)].map((match) => match[2]);
}

interface IniSetting {
  section: string;
  key: string;
  value: string;
}

/** `key = value` settings under `[sections]`, a URL on an indented line after one joined to it. Keys lower-cased, `_` read as `-`. */
function iniSettings(text: string): IniSetting[] {
  const settings: IniSetting[] = [];
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[(.+)\]\s*$/.exec(line);
    if (header) section = header[1].trim().toLowerCase();
    else readIniLine(line, section, settings);
  }
  return settings;
}

function readIniLine(line: string, section: string, settings: IniSetting[]): void {
  if (/^\s*([#;]|$)/.test(line)) return;
  const last = settings[settings.length - 1];
  // pip's continuation lines: indented, and a URL rather than another `key = value`.
  if (last && /^\s+[a-z][a-z0-9+.-]*:\/\//i.test(line)) {
    last.value = `${last.value} ${line.trim()}`;
    return;
  }
  const setting = /^\s*([A-Za-z0-9_.-]+)\s*[=:]\s*(.*)$/.exec(line);
  if (setting) settings.push({ section, key: setting[1].toLowerCase().replace(/_/g, '-'), value: setting[2].trim() });
}

// ── requirements*.txt ────────────────────────────────────────────────────────

const PIP_URL_OPTIONS = new Set(['-i', '--index-url', '--extra-index-url', '-f', '--find-links']);
const PIP_INCLUDE_OPTIONS = new Set(['-r', '--requirement', '-c', '--constraint']);

/** The index options of every `requirements*.txt` in the project folder, and of the files they include, each file once. */
function requirementsValues(files: ProjectFiles): Found[] {
  const seen = new Set<string>();
  const found: Found[] = [];
  const visit = (name: string, depth: number) => {
    const file = path.posix.normalize(name);
    if (depth > MAX_INCLUDE_DEPTH || seen.has(file) || !staysInside(file)) return;
    seen.add(file);
    const text = files.read(file);
    if (text === undefined) return;
    const options = requirementsOptions(text);
    found.push([file, options.urls]);
    // An absolute include names a file outside the project; `join` would quietly make it a project path.
    for (const include of options.includes.filter((named) => !path.posix.isAbsolute(named))) visit(path.posix.join(path.posix.dirname(file), include), depth + 1);
  };
  for (const name of files.list('').filter((entry) => /^requirements.*\.txt$/i.test(entry)).sort()) visit(name, 0);
  return found;
}

/** A relative path that stays inside the project once normalised. */
function staysInside(file: string): boolean {
  return !path.posix.isAbsolute(file) && file !== '..' && !file.startsWith('../');
}

/** `--index-url URL`, `--index-url=URL`, `-i URL`, and the same for the other options, on any logical line. */
function requirementsOptions(text: string): { urls: string[]; includes: string[] } {
  const urls: string[] = [];
  const includes: string[] = [];
  for (const line of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const tokens = line.replace(/(^|\s)#.*$/, '').split(/\s+/).filter(Boolean);
    tokens.forEach((token, index) => {
      const [name, inline] = token.startsWith('--') && token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined];
      const value = inline ?? tokens[index + 1];
      if (value !== undefined && PIP_URL_OPTIONS.has(name)) urls.push(value);
      if (value !== undefined && PIP_INCLUDE_OPTIONS.has(name)) includes.push(value);
    });
  }
  return { urls, includes };
}

// ── TOML ─────────────────────────────────────────────────────────────────────

/** A string value in a TOML file, and the dotted path of tables and keys it sits under. */
export interface TomlString {
  path: string[];
  value: string;
}

/** Every string value in TOML text, with its path — enough of TOML to find registry settings, and no more. */
export function tomlStrings(text: string): TomlString[] {
  const found: TomlString[] = [];
  let table: string[] = [];
  for (const statement of tomlStatements(text)) {
    const header = /^\[\[?(.+?)\]\]?$/.exec(statement);
    if (header) {
      table = splitKey(header[1]);
      continue;
    }
    const equals = outsideStrings(statement, '=');
    if (equals !== -1) collectStrings(statement.slice(equals + 1).trim(), [...table, ...splitKey(statement.slice(0, equals))], found);
  }
  return found;
}

/** Statements: comments dropped, and an array or inline table spread over lines joined into one. */
function tomlStatements(text: string): string[] {
  const statements: string[] = [];
  let current = '';
  const scan = new TomlScan();
  for (const char of text) {
    const kept = scan.step(char);
    if (kept === '\n' && scan.depth === 0) {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else if (kept !== undefined) {
      current += kept === '\n' ? ' ' : kept;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** Walks TOML a character at a time: which characters are inside strings, which are comments, and how deep the brackets go. */
class TomlScan {
  depth = 0;
  private quote: string | undefined;
  private escaped = false;
  private comment = false;

  /** Inside a string, before the next character is read. */
  get quoted(): boolean {
    return this.quote !== undefined;
  }

  /** The character to keep, or undefined for a comment's. */
  step(char: string): string | undefined {
    if (this.comment) return this.endComment(char);
    if (this.quote) return this.inString(char);
    return this.outsideString(char);
  }

  private outsideString(char: string): string | undefined {
    if (char === '#') {
      this.comment = true;
      return undefined;
    }
    if (char === '"' || char === "'") this.quote = char;
    this.depth += bracketStep(char);
    return char;
  }

  private endComment(char: string): string | undefined {
    if (char !== '\n') return undefined;
    this.comment = false;
    return char;
  }

  private inString(char: string): string {
    if (this.escaped) this.escaped = false;
    else if (char === '\\' && this.quote === '"') this.escaped = true;
    else if (char === this.quote) this.quote = undefined;
    return char;
  }
}

/** An opening bracket goes one deeper, a closing one comes back out. */
function bracketStep(char: string): number {
  if (char === '[' || char === '{') return 1;
  return char === ']' || char === '}' ? -1 : 0;
}

/** Where `char` first appears outside a string and outside brackets, or -1. */
function outsideStrings(text: string, char: string): number {
  const scan = new TomlScan();
  for (let at = 0; at < text.length; at++) {
    const nested = scan.depth > 0 || scan.quoted;
    if (scan.step(text[at]) === char && !nested) return at;
  }
  return -1;
}

/** `tool.uv`, `registries."my-reg"`: the key's parts, quotes removed. */
function splitKey(key: string): string[] {
  return (key.match(/"[^"]*"|'[^']*'|[^.]+/g) ?? []).map((part) => part.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function collectStrings(value: string, at: string[], found: TomlString[]): void {
  const string = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/.exec(value);
  if (string) found.push({ path: at, value: string[1] ?? string[2] });
  else if (value.startsWith('[') && value.endsWith(']')) for (const item of splitTopLevel(value.slice(1, -1))) collectStrings(item, at, found);
  else if (value.startsWith('{') && value.endsWith('}')) collectInlineTable(value.slice(1, -1), at, found);
}

function collectInlineTable(body: string, at: string[], found: TomlString[]): void {
  for (const pair of splitTopLevel(body)) {
    const equals = outsideStrings(pair, '=');
    if (equals !== -1) collectStrings(pair.slice(equals + 1).trim(), [...at, ...splitKey(pair.slice(0, equals))], found);
  }
}

/** A list's items: split at the commas that aren't inside a string or a nested bracket. */
function splitTopLevel(body: string): string[] {
  const items: string[] = [];
  const scan = new TomlScan();
  let current = '';
  for (const char of body) {
    const nested = scan.depth > 0 || scan.quoted;
    const kept = scan.step(char) ?? '';
    if (kept === ',' && !nested) {
      items.push(current.trim());
      current = '';
    } else current += kept;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/** Whether a dotted path matches a pattern, `*` standing for any one part. */
function pathIs(parts: string[], pattern: string): boolean {
  const wanted = pattern.split('.');
  return parts.length === wanted.length && wanted.every((part, index) => part === '*' || part === parts[index]);
}

const PYPROJECT_SETTINGS = [
  'tool.uv.index-url',
  'tool.uv.extra-index-url',
  'tool.uv.find-links',
  'tool.uv.index.url',
  'tool.uv.pip.index-url',
  'tool.uv.pip.extra-index-url',
  'tool.poetry.source.url',
  'tool.pdm.source.url',
  'tool.rye.sources.url',
];

/** `pyproject.toml`: where uv, Poetry, PDM and Rye name their package indexes. */
function pyprojectValues(text: string): string[] {
  return tomlStrings(text)
    .filter((entry) => PYPROJECT_SETTINGS.some((pattern) => pathIs(entry.path, pattern)))
    .map((entry) => entry.value);
}

/** `Cargo.toml`: a dependency fetched from another registry's index (`registry-index`), wherever it is declared. */
function cargoTomlValues(text: string): string[] {
  return tomlStrings(text)
    .filter((entry) => entry.path[entry.path.length - 1] === 'registry-index')
    .map((entry) => entry.value);
}

const CARGO_CONFIG_SETTINGS = ['registries.*.index', 'registry.index', 'source.*.registry', 'source.*.git'];

/** `.cargo/config.toml`: named registries, the default registry, and source replacements. */
function cargoConfigValues(text: string): string[] {
  return tomlStrings(text)
    .filter((entry) => CARGO_CONFIG_SETTINGS.some((pattern) => pathIs(entry.path, pattern)))
    .map((entry) => entry.value);
}

// ── Reading a real folder ────────────────────────────────────────────────────

/**
 * A project folder as the scan reads it: only regular files, at most `MAX_FILE_BYTES`, and never through a link that
 * leads out of the project.
 */
export function projectFiles(root: string): ProjectFiles {
  const realRoot = realpathOrUndefined(root);
  return {
    read: (relative) => (realRoot === undefined ? undefined : readInside(realRoot, relative)),
    list: (folder) => (realRoot === undefined ? [] : listInside(realRoot, folder)),
  };
}

function readInside(root: string, relative: string): string | undefined {
  const file = realpathOrUndefined(path.join(root, relative));
  if (file === undefined || !file.startsWith(root + path.sep)) return undefined;
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size <= MAX_FILE_BYTES ? fs.readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function listInside(root: string, folder: string): string[] {
  try {
    return fs.readdirSync(path.join(root, folder), { withFileTypes: true }).filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function realpathOrUndefined(file: string): string | undefined {
  try {
    return fs.realpathSync(file);
  } catch {
    return undefined;
  }
}
