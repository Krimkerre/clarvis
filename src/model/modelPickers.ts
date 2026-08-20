import * as vscode from 'vscode';
import { ModelService } from './ModelService';
import { ModelChoice } from './ModelProvider';
import { PROVIDERS, ProviderId, providerSpec, acceptableOverride, providerNotRespondingLine, providerListedNothingLine } from './providers';
import { ModelRole } from './roles';
import { phrase } from '../personality/Voice';

/** Cached model lists, per provider. */
const CATALOG_KEY = 'clarvis.model.catalog';
const CATALOG_FETCHED_KEY = 'clarvis.model.catalogFetchedAt';

/**
 * How long a cached list is reused before it refetches on its own.
 *
 * Model line-ups change weekly, not hourly. Fetching on every picker open would be
 * rude to the provider and slow for the user; a day is comfortably inside "current"
 * and well outside "hammering them". Refresh is always available regardless.
 */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

type CatalogStore = Partial<Record<ProviderId, ModelChoice[]>>;
type FetchedStore = Partial<Record<ProviderId, number>>;

/**
 * Chooses the provider.
 *
 * Separate from choosing a model, because they are different decisions: the provider
 * is *who you have an account with*, the model is *which one you want today*.
 */
export async function chooseProvider(
  context: vscode.ExtensionContext,
  models: ModelService,
  log: (m: string) => void,
  role: ModelRole = 'chat'
): Promise<void> {
  const current = models.spec(role).id;
  const keyed = await models.keyedProviders();

  const picked = await vscode.window.showQuickPick(
    PROVIDERS.map((spec) => ({
      label: `${spec.id === current ? '$(check) ' : ''}${spec.label}`,
      detail: spec.detail,
      // The single thing that prevents "why won't it answer?" — said here, not later.
      description: spec.needsKey ? (keyed[spec.id] ? 'key set' : 'no key yet') : 'no key needed',
      id: spec.id,
    })),
    { placeHolder: 'Which provider should I use?', matchOnDetail: true }
  );
  if (!picked) return;

  await writeSetting(`${role}.provider`, picked.id);
  // A model belongs to the provider that offered it. Carrying one across means asking
  // OpenAI for a Claude model and getting a 404 nobody can explain.
  await writeSetting(`${role}.model`, '');
  log(`model: ${role} provider set to ${picked.id}`);

  const spec = providerSpec(picked.id)!;
  if (spec.needsKey && !keyed[picked.id]) {
    await promptForKey(models, picked.id, log);
  }

  // **A URL is to this provider what a key is to Anthropic**, so it is asked for in the
  // same breath. Without it the model list cannot be fetched and the next picker would
  // open empty, which is the failure F13 describes from the other direction.
  if (spec.needsUrl) {
    await promptForBaseUrl(picked.id, log);
  }

  // **Straight on to the models.** Choosing a provider clears the model — carrying one
  // across means asking OpenAI for a Claude model and getting a 404 nobody can explain —
  // so stopping here left the user with a provider and nothing to answer with, and no
  // sign that a second picker existed. The key prompt comes first, because the list
  // cannot be fetched without it.
  await chooseModel(context, models, log, role);
}

/**
 * Chooses the model, offering only ones that will actually work.
 *
 * Identical flow for every provider — the differences live in how each list is
 * *fetched and filtered* (see the catalogue modules), not in how it is presented.
 * Refresh sits inside the list rather than in a separate command, because the moment
 * someone wants it is the moment the model they are looking for isn't there.
 */
export async function chooseModel(
  context: vscode.ExtensionContext,
  models: ModelService,
  log: (m: string) => void,
  role: ModelRole = 'chat'
): Promise<void> {
  const spec = models.spec(role);
  const current = models.model(role);
  let catalog = await cachedModels(context, models, log, role);

  for (;;) {
    const items: (vscode.QuickPickItem & { id: string })[] = [
      { label: '$(refresh) Refresh the list', detail: `Re-fetch from ${spec.label}`, id: '\0refresh' },
      { label: '$(edit) Type a model name…', detail: 'Anything, including models not listed', id: '\0type' },
    ];

    if (catalog.length > 0) {
      items.push({
        label: `${catalog.length} usable model${catalog.length === 1 ? '' : 's'}`,
        kind: vscode.QuickPickItemKind.Separator,
        id: '\0sep',
      });
      items.push(
        ...catalog.map((entry) => ({
          label: entry.id === current ? `$(check) ${entry.label}` : entry.label,
          description: entry.label === entry.id ? '' : entry.id,
          detail: entry.detail,
          id: entry.id,
        }))
      );
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder:
        catalog.length > 0
          ? role === 'agent'
            ? `${spec.label} — the model that writes code`
            : `${spec.label} — the model that answers questions`
          : `${spec.label} listed nothing. Type a name, or refresh.`,
      matchOnDetail: true,
      matchOnDescription: true,
    });
    if (!picked) return;

    if (picked.id === '\0refresh') {
      catalog = await refreshedModels(context, models, log, role);
      continue;
    }

    if (picked.id === '\0type') {
      await promptForModelName(current, log, role);
      return;
    }

    await writeSetting(`${role}.model`, picked.id);
    log(`model: ${role} model set to ${picked.id}`);
    return;
  }
}

/**
 * The model list, from cache or freshly fetched.
 *
 * Falls back to whatever is cached when a fetch fails: a stale list beats an empty
 * one, and a provider being briefly unreachable should not stop someone changing
 * models. Cached per provider, so switching back and forth doesn't refetch.
 */
/** What is already stored for a provider, and whether it is still worth trusting. */
function storedCatalogue(
  context: vscode.ExtensionContext,
  provider: ProviderId
): { cached: ModelChoice[]; fresh: boolean } {
  const store = context.globalState.get<CatalogStore>(CATALOG_KEY) ?? {};
  const fetched = context.globalState.get<FetchedStore>(CATALOG_FETCHED_KEY) ?? {};

  return {
    cached: store[provider] ?? [],
    fresh: Date.now() - (fetched[provider] ?? 0) < CATALOG_TTL_MS,
  };
}

/**
 * Asks the provider and stores what came back.
 *
 * `undefined` rather than an empty array when nothing usable arrived, so the two
 * callers can each fall back to the cache — a stale list beats an empty one, and a
 * provider being briefly unreachable should not stop someone changing models.
 */
async function fetchCatalogue(
  context: vscode.ExtensionContext,
  models: ModelService,
  log: (m: string) => void,
  role: ModelRole
): Promise<ModelChoice[] | undefined> {
  const provider = models.spec(role).id;

  try {
    const listed = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Clarvis: asking ${models.spec(role).label}…` },
      () => models.listModels(role)
    );

    if (listed.length === 0) {
      log(`model: ${provider} listed no usable models`);
      await diagnoseEmptyLocalCatalog(models, role, log);
      return undefined;
    }

    const store = context.globalState.get<CatalogStore>(CATALOG_KEY) ?? {};
    const fetched = context.globalState.get<FetchedStore>(CATALOG_FETCHED_KEY) ?? {};
    await context.globalState.update(CATALOG_KEY, { ...store, [provider]: listed });
    await context.globalState.update(CATALOG_FETCHED_KEY, { ...fetched, [provider]: Date.now() });
    log(`model: ${provider} catalogue refreshed, ${listed.length} usable models`);
    return listed;
  } catch (error) {
    log(`model: ${provider} catalogue fetch failed (${String(error)})`);
    return undefined;
  }
}

/**
 * The model list, from cache when it is fresh and from the provider when it is not.
 *
 * **Was `cachedModels(…, force: boolean, …)`**, five arguments with a flag in the
 * middle that decided two separate things: whether to consult the cache at all, and
 * whether to tell the user how many models turned up. Opening a picker and deliberately
 * refreshing one are different acts, and they are two functions now. Cached per
 * provider, so switching back and forth doesn't refetch.
 */
async function cachedModels(
  context: vscode.ExtensionContext,
  models: ModelService,
  log: (m: string) => void,
  role: ModelRole = 'chat'
): Promise<ModelChoice[]> {
  const { cached, fresh } = storedCatalogue(context, models.spec(role).id);
  if (fresh && cached.length > 0) return cached;

  return (await fetchCatalogue(context, models, log, role)) ?? cached;
}

/** The list, asked for again on purpose — and said out loud, since someone asked. */
async function refreshedModels(
  context: vscode.ExtensionContext,
  models: ModelService,
  log: (m: string) => void,
  role: ModelRole = 'chat'
): Promise<ModelChoice[]> {
  const listed = await fetchCatalogue(context, models, log, role);
  if (!listed) return storedCatalogue(context, models.spec(role).id).cached;

  void vscode.window.showInformationMessage(
    `Clarvis: ${listed.length} usable ${models.spec(role).label} models.`
  );
  return listed;
}

/**
 * Tells the user why a local provider's picker just opened empty (F13).
 *
 * **Only for providers with no key.** A keyed provider listing nothing is already
 * covered by `chooseProvider`'s own key prompt — this is specifically the case that
 * had no explanation at all: a refused connection to a known local port, logged and
 * shown to nobody. "Not running" and "running with nothing loaded" get different
 * sentences, because they have different fixes and a wrong one sends someone looking
 * for a problem they don't have.
 */
async function diagnoseEmptyLocalCatalog(models: ModelService, role: ModelRole, log: (m: string) => void): Promise<void> {
  const spec = models.spec(role);
  if (spec.needsKey) return;

  const baseUrl = models.baseUrl(role);
  const reachable = await models.isReady(role);
  const line = reachable
    ? providerListedNothingLine(spec.label, baseUrl)
    : providerNotRespondingLine(spec.label, baseUrl);

  log(`model: ${spec.id} — ${line}`);
  void vscode.window.showWarningMessage(`Clarvis: ${line}`);
}

/** Refreshes the current provider's list from the command palette. */
export async function refreshModelCatalog(
  context: vscode.ExtensionContext,
  models: ModelService,
  log: (m: string) => void
): Promise<void> {
  const listed = await refreshedModels(context, models, log);
  if (listed.length === 0) {
    void vscode.window.showWarningMessage(
      `Clarvis: couldn't get a model list from ${models.spec().label} just now.`
    );
  }
}

/**
 * Asks which job is being configured, then configures it.
 *
 * One entry point rather than four separate commands: most people never split the two,
 * and those who do think in terms of "the coding one costs more", not in terms of
 * which setting key holds it.
 */
export async function configureModels(
  context: vscode.ExtensionContext,
  models: ModelService,
  log: (m: string) => void
): Promise<void> {
  const chatSpec = models.spec('chat');
  const agentSpec = models.spec('agent');
  const separate = models.agentIsSeparate();

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: '$(comment-discussion) Chat model',
        description: `${chatSpec.label} · ${models.model('chat')}`,
        detail: 'Answers questions. Every reply you read costs this one.',
        id: 'chat',
      },
      {
        label: '$(tools) Coding model',
        description: separate
          ? `${agentSpec.label} · ${models.model('agent')}`
          : 'same as chat',
        detail: separate
          ? 'Writes code and runs the agent.'
          : 'Writes code and runs the agent. Set it separately to keep a cheap model for chat.',
        id: 'agent',
      },
      { label: '$(key) API keys', detail: 'One per provider, all kept', id: 'keys' },
    ],
    { placeHolder: 'What would you like to change?', matchOnDetail: true }
  );
  if (!picked) return;

  if (picked.id === 'keys') {
    await manageKeys(models, log);
    return;
  }

  const role = picked.id as ModelRole;
  const next = await vscode.window.showQuickPick(
    [
      { label: '$(server) Provider', detail: 'Which account or local runtime', id: 'provider' },
      { label: '$(list-selection) Model', detail: 'Which model at that provider', id: 'model' },
      ...(role === 'agent' && separate
        ? [{ label: '$(discard) Follow the chat model again', detail: 'Stop using a separate coding model', id: 'reset' }]
        : []),
    ],
    { placeHolder: role === 'agent' ? 'Coding model' : 'Chat model' }
  );
  if (!next) return;

  if (next.id === 'reset') {
    await writeSetting('agent.provider', '');
    await writeSetting('agent.model', '');
    log('model: agent follows the chat model again');
    return;
  }

  if (next.id === 'provider') await chooseProvider(context, models, log, role);
  else await chooseModel(context, models, log, role);
}

/**
 * Manages every provider's key in one place.
 *
 * Keys are stored **per provider and kept**, so switching provider is a one-click
 * change rather than re-entering a key each time. Someone comparing a local model
 * against a hosted one does that ten times in an afternoon.
 */
export async function manageKeys(models: ModelService, log: (m: string) => void): Promise<void> {
  for (;;) {
    const keyed = await models.keyedProviders();

    const picked = await vscode.window.showQuickPick(
      PROVIDERS.filter((spec) => spec.needsKey).map((spec) => ({
        label: `${keyed[spec.id] ? '$(key) ' : '$(circle-outline) '}${spec.label}`,
        description: keyed[spec.id] ? 'key stored' : 'no key',
        detail: keyed[spec.id] ? 'Choose to replace or remove it' : 'Choose to add one',
        id: spec.id,
      })),
      { placeHolder: 'API keys — stored in your OS keychain, one per provider' }
    );
    if (!picked) return;

    if (!keyed[picked.id]) {
      await promptForKey(models, picked.id, log);
      continue;
    }

    const action = await vscode.window.showQuickPick(
      [
        { label: '$(edit) Replace the key', id: 'replace' },
        { label: '$(trash) Remove the key', id: 'remove' },
      ],
      { placeHolder: `${providerSpec(picked.id)!.label}` }
    );
    if (!action) continue;

    if (action.id === 'replace') await promptForKey(models, picked.id, log);
    else {
      await models.clearKey(picked.id);
      void vscode.window.showInformationMessage(
        `Clarvis: ${providerSpec(picked.id)!.label} key removed.`
      );
    }
  }
}

/** Free-text model entry, for anything a provider doesn't list. */
async function promptForModelName(
  current: string,
  log: (m: string) => void,
  role: ModelRole = 'chat'
): Promise<void> {
  const name = await vscode.window.showInputBox({
    prompt: 'Model name, exactly as the provider spells it',
    value: current,
    ignoreFocusOut: true,
  });
  if (!name?.trim()) return;

  await writeSetting(`${role}.model`, name.trim());
  log(`model: ${role} model set to ${name.trim()} (typed)`);
}

/** Captures a key into the OS keychain. Never settings, never the log. */
/**
 * Asks for the address of a server Clarvis has no way to guess.
 *
 * Validated with `acceptableOverride()` — the same rule the stored override already goes
 * through, rather than a second opinion about what a safe URL is. For a keyless provider
 * that means any http or https address, since nothing secret travels to it; the tighter
 * loopback-or-https rule exists to stop a key leaving over plain http, and there is no key
 * here.
 *
 * Rejection re-asks rather than failing, with what was typed still in the box. A URL is
 * easy to typo and losing it to a dismissed dialog is the kind of small rudeness §6 counts.
 */
export async function promptForBaseUrl(provider: ProviderId, log: (m: string) => void): Promise<void> {
  const spec = providerSpec(provider)!;
  const stored = vscode.workspace.getConfiguration('clarvis').get<string>(`chat.baseUrl.${provider}`, '');

  const value = await vscode.window.showInputBox({
    prompt: `Address of your ${spec.label} server`,
    placeHolder: 'http://localhost:8080',
    value: stored,
    ignoreFocusOut: true,
    validateInput: (typed) =>
      !typed.trim() || acceptableOverride(typed, spec.needsKey)
        ? undefined
        : 'That is not an http or https address I can reach.',
  });
  if (!value?.trim()) {
    log(`model: no address given for ${provider}`);
    // Said, not just logged. Dismissing this prompt leaves a provider with nowhere to
    // send a request, and the next picker would open empty with no explanation — which
    // is precisely the silence F13 is about, self-inflicted.
    void vscode.window.showWarningMessage(
      await phrase(
        'report',
        `No address, so ${spec.label} has nowhere to send anything. Run "Clarvis: Choose Model Provider" again when you have one.`,
        [spec.label]
      )
    );
    return;
  }

  await writeSetting(`chat.baseUrl.${provider}`, value.trim());
  log(`model: ${provider} address set to ${value.trim()}`);
}

export async function promptForKey(
  models: ModelService,
  provider: ProviderId,
  log: (m: string) => void
): Promise<void> {
  const spec = providerSpec(provider)!;

  const key = await vscode.window.showInputBox({
    prompt: `${spec.label} API key`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!key?.trim()) return;

  await models.setKey(provider, key);
  log(`model: key stored for ${provider}`);
  void vscode.window.showInformationMessage(
    await phrase('report', `${spec.label} key stored in the system keychain.`, [spec.label])
  );
}

/**
 * Writes to the scope that will actually take effect.
 *
 * Same trap the voice picker hit: writing Global unconditionally succeeds and does
 * nothing whenever a workspace value exists, and the setting appears to snap back.
 */
async function writeSetting(key: string, value: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('clarvis');
  const scope =
    config.inspect(key)?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

  await config.update(key, value, scope);
}
