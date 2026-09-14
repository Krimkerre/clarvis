import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as path from 'path';
import * as vm from 'vm';

/**
 * The bowtie's fold-out, run as the webview runs it (plan.md M15, C2b+): `media/bowtieMenu.js` loaded into a fresh
 * script context over a small stand-in for the document — enough of the DOM for what the menu touches, with an
 * `innerHTML` that throws, so markup can never be how anything reaches the page. Opening and closing, API config's
 * unchanged `models` message, the Codex section enabled or disabled, each model's own efforts, RAVIS not answering,
 * the keyboard, and RAVIS's words kept as text.
 */

interface FakeEvent {
  type: string;
  key?: string;
  shiftKey?: boolean;
  target?: FakeElement;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function fakeEvent(type: string, fields: Partial<FakeEvent> = {}): FakeEvent {
  const fired: FakeEvent = { type, defaultPrevented: false, preventDefault: () => void (fired.defaultPrevented = true), ...fields };
  return fired;
}

class Listeners {
  private readonly byType = new Map<string, ((event: FakeEvent) => void)[]>();

  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.byType.set(type, [...(this.byType.get(type) ?? []), listener]);
  }

  fire(fired: FakeEvent): FakeEvent {
    for (const listener of this.byType.get(fired.type) ?? []) listener(fired);
    return fired;
  }
}

class FakeElement extends Listeners {
  children: FakeElement[] = [];
  parentNode: FakeElement | undefined;
  className = '';
  hidden = false;
  disabled = false;
  type = '';
  id = '';
  title = '';
  private text = '';
  private readonly attributes = new Map<string, string>();

  constructor(
    readonly tagName: string,
    private readonly owner: FakeDocument
  ) {
    super();
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.children = [];
    this.text = String(value);
  }

  set innerHTML(_markup: string) {
    throw new Error('the menu never sets markup: everything RAVIS sends is text');
  }

  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (name: string) => names().includes(name),
      toggle: (name: string, on: boolean) => {
        this.className = [...names().filter((existing) => existing !== name), ...(on ? [name] : [])].join(' ');
        return on;
      },
    };
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children = [];
    this.text = '';
    for (const node of nodes) this.appendChild(node);
  }

  contains(node: FakeElement | undefined): boolean {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  }

  focus(): void {
    this.owner.activeElement = this;
  }

  /** A person's click: a disabled button gets none, as in a browser. */
  click(): void {
    if (!this.disabled) this.fire(fakeEvent('click', { target: this }));
  }

  /** Every element under this one, in document order. */
  all(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.all()]);
  }
}

class FakeDocument extends Listeners {
  activeElement: FakeElement | undefined;

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  key(key: string, shiftKey = false): FakeEvent {
    return this.fire(fakeEvent('keydown', { key, shiftKey }));
  }

  pointerDown(target: FakeElement): void {
    this.fire(fakeEvent('pointerdown', { target }));
  }
}

interface Menu {
  open(): void;
  close(returnFocus: boolean): void;
  render(state: unknown): void;
  readonly isOpen: boolean;
}

const SOURCE = fs.readFileSync(path.join(repoRoot(__dirname), 'media', 'bowtieMenu.js'), 'utf8');

/** The menu over a fresh document, with everything it posts kept in `posts`. */
function mount() {
  const context: { ClarvisBowtieMenu?: { createBowtieMenu(env: unknown): Menu } } = {};
  vm.runInNewContext(SOURCE, context);
  const document = new FakeDocument();
  const button = document.createElement('button');
  const icon = button.appendChild(document.createElement('svg'));
  const panel = document.createElement('div');
  const transcript = document.createElement('div');
  const posts: Record<string, unknown>[] = [];
  const create = context.ClarvisBowtieMenu?.createBowtieMenu;
  if (!create) throw new Error('media/bowtieMenu.js defined no ClarvisBowtieMenu');
  const menu = create({ document, button, panel, post: (message: Record<string, unknown>) => posts.push(structuredClone(message)) });
  const part = (name: string) => {
    const found = panel.all().find((node) => node.getAttribute('data-part') === name);
    if (!found) throw new Error(`no ${name} in the menu`);
    return found;
  };
  return { menu, document, button, icon, panel, transcript, posts, part, apiConfig: part('api-config') };
}

const labelsOf = (group: FakeElement) => group.children.map((option) => option.children.map((child) => child.textContent));

const ASTRA = {
  id: 'gpt-6-astra',
  label: 'gpt-6-astra',
  isDefault: true,
  efforts: [
    { id: 'low', isDefault: true },
    { id: 'medium', isDefault: false },
    { id: 'high', isDefault: false },
  ],
};
const NOVA = { id: 'gpt-6-nova', label: 'GPT-6 Nova', isDefault: false, efforts: [{ id: 'medium', isDefault: true }, { id: 'high', isDefault: false }] };
const ENABLED = {
  enabled: true,
  models: [ASTRA, NOVA],
  chosen: { model: 'gpt-6-astra', effort: 'medium' },
  note: "A bigger model or higher effort uses the ChatGPT plan's allowance faster.",
  allowance: { line: 'Allowance: 25% left · resets Fri 00:43', tooltip: 'weekly window: 75% used, 25% left, resets Fri 00:43' },
};

test('the bowtie opens the menu with focus on API config and asks for the Codex section; Escape closes it and puts focus back', () => {
  const m = mount();
  assert.deepEqual([m.panel.hidden, m.button.getAttribute('aria-expanded'), m.button.getAttribute('aria-haspopup')], [true, 'false', 'dialog']);

  m.button.click();
  assert.equal(m.menu.isOpen, true);
  assert.deepEqual([m.panel.hidden, m.button.getAttribute('aria-expanded')], [false, 'true']);
  assert.deepEqual(m.posts, [{ type: 'bowtie-menu' }]);
  assert.equal(m.document.activeElement, m.apiConfig);
  assert.equal(m.part('status').textContent, 'Asking RAVIS…');

  const escape = m.document.key('Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.deepEqual([m.menu.isOpen, m.panel.hidden], [false, true]);
  assert.equal(m.document.activeElement, m.button);

  m.button.click();
  m.button.click();
  assert.equal(m.menu.isOpen, false, 'the bowtie closes it again');
  assert.deepEqual(m.posts, [{ type: 'bowtie-menu' }, { type: 'bowtie-menu' }], 'asked each time it opens, and never while it is closed');
});

test('API config posts the same models message the bowtie did, and closes the menu', () => {
  const m = mount();
  m.button.click();
  assert.equal(m.apiConfig.children[0].textContent, 'API config');

  m.apiConfig.click();
  assert.deepEqual(m.posts, [{ type: 'bowtie-menu' }, { type: 'models' }]);
  assert.equal(m.menu.isOpen, false);
});

test('a click outside closes it; a click inside it, or on the bowtie, does not', () => {
  const m = mount();
  m.button.click();
  m.document.pointerDown(m.apiConfig);
  m.document.pointerDown(m.icon);
  assert.equal(m.menu.isOpen, true);

  m.document.pointerDown(m.transcript);
  assert.equal(m.menu.isOpen, false);
  assert.notEqual(m.document.activeElement, m.button, 'a click elsewhere leaves focus to where it went');
});

test("the Codex section: RAVIS's models, the default marked and the chosen one checked, that model's own efforts, the note and the allowance", () => {
  const m = mount();
  m.button.click();
  m.menu.render(ENABLED);

  assert.equal(m.part('status').hidden, true);
  assert.deepEqual(labelsOf(m.part('models')), [['gpt-6-astra', 'default'], ['GPT-6 Nova']]);
  assert.deepEqual(m.part('models').children.map((option) => option.getAttribute('aria-checked')), ['true', 'false']);
  assert.deepEqual(labelsOf(m.part('efforts')), [['low', 'default'], ['medium'], ['high']]);
  assert.deepEqual(m.part('efforts').children.map((option) => option.getAttribute('aria-checked')), ['false', 'true', 'false']);
  assert.equal(m.part('note').textContent, ENABLED.note);
  assert.deepEqual([m.part('allowance').textContent, m.part('allowance').title], [ENABLED.allowance.line, ENABLED.allowance.tooltip]);
  assert.equal(m.part('running').hidden, true);

  m.menu.render({ ...ENABLED, chosen: { model: 'gpt-6-nova', effort: 'high' }, running: 'A Codex task is running.' });
  assert.deepEqual(labelsOf(m.part('efforts')), [['medium', 'default'], ['high']], "the chosen model's own efforts");
  assert.equal(m.part('running').textContent, 'A Codex task is running.');
});

test('picking an effort or a model posts it and closes the menu, focus back on the bowtie', () => {
  const m = mount();
  m.button.click();
  m.menu.render(ENABLED);
  m.part('efforts').children[2].click();
  assert.deepEqual(m.posts.at(-1), { type: 'codex-choice', model: 'gpt-6-astra', effort: 'high' });
  assert.deepEqual([m.menu.isOpen, m.document.activeElement], [false, m.button]);

  m.button.click();
  m.menu.render(ENABLED);
  m.part('models').children[1].click();
  assert.deepEqual(m.posts.at(-1), { type: 'codex-choice', model: 'gpt-6-nova', effort: undefined });
  assert.equal(m.menu.isOpen, false);
});

test('with another coding model the controls are disabled with one short line, nothing can be chosen, and the allowance still shows', () => {
  const m = mount();
  m.button.click();
  const line = 'These apply only to Codex: choose ravis/clarvis-codex under API config.';
  m.menu.render({ ...ENABLED, enabled: false, line });

  assert.equal(m.part('status').textContent, line);
  assert.equal(m.part('codex').getAttribute('aria-disabled'), 'true');
  const options = [...m.part('models').children, ...m.part('efforts').children];
  assert.ok(options.every((option) => option.disabled));
  for (const option of options) option.fire(fakeEvent('click', { target: option })); // even a click that got through
  assert.deepEqual(m.posts, [{ type: 'bowtie-menu' }], 'nothing chosen');
  assert.deepEqual([m.part('allowance').hidden, m.menu.isOpen], [false, true]);
});

test("RAVIS not answering: its line, instead of an empty list", () => {
  const m = mount();
  m.button.click();
  const down = "RAVIS isn't answering, so Codex's models and allowance can't be shown right now.";
  m.menu.render({ enabled: true, line: down, models: [], note: ENABLED.note });

  assert.equal(m.part('status').textContent, down);
  for (const name of ['models', 'model-label', 'efforts', 'effort-label', 'note', 'allowance']) assert.equal(m.part(name).hidden, true, name);
});

test('Tab and Shift+Tab stay inside the open menu, disabled options skipped; closed, Tab is the page’s again', () => {
  const m = mount();
  m.button.click();
  m.menu.render(ENABLED);
  const [astra, nova] = m.part('models').children;
  const [low, medium, high] = m.part('efforts').children;
  for (const expected of [m.apiConfig, astra, nova, low, medium, high]) {
    assert.equal(m.document.activeElement, expected);
    assert.equal(m.document.key('Tab').defaultPrevented, true);
  }
  assert.equal(m.document.activeElement, m.apiConfig, 'Tab from the last wraps to the first');
  m.document.key('Tab', true);
  assert.equal(m.document.activeElement, high, 'Shift+Tab from the first wraps to the last');

  m.menu.render({ ...ENABLED, enabled: false, line: 'These apply only to Codex.' });
  m.apiConfig.focus();
  m.document.key('Tab');
  assert.equal(m.document.activeElement, m.apiConfig, 'with the controls disabled, API config is all there is to reach');

  m.menu.close(true);
  assert.equal(m.document.key('Tab').defaultPrevented, false);
});

test("RAVIS's words stay text: a model name or an allowance that looks like markup is shown as written", () => {
  const m = mount();
  m.button.click();
  const hostile = '<img src=x onerror="alert(1)">';
  m.menu.render({ ...ENABLED, models: [{ ...ASTRA, label: hostile }], allowance: { line: 'Allowance: <b>25%</b>', tooltip: '<script>x</script>' } });

  assert.equal(labelsOf(m.part('models'))[0][0], hostile);
  assert.deepEqual([m.part('allowance').textContent, m.part('allowance').title], ['Allowance: <b>25%</b>', '<script>x</script>']);
});

test('an answer that arrives after the menu closed is only kept: opening again asks again, and shows that it is asking', () => {
  const m = mount();
  m.button.click();
  m.document.key('Escape');
  m.menu.render(ENABLED);
  assert.equal(m.part('models').children.length, 0, 'not drawn while closed');

  m.button.click();
  assert.equal(m.part('status').textContent, 'Asking RAVIS…');
  assert.deepEqual(m.posts, [{ type: 'bowtie-menu' }, { type: 'bowtie-menu' }]);
});

function repoRoot(start: string): string {
  for (let current = start; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    if (path.dirname(current) === current) throw new Error(`no package.json above ${start}`);
  }
}
