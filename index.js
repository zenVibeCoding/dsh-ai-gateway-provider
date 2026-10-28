/**
 * AI Gateway (dsh-ai-gateway-provider) — Host half.
 *
 * Model management is ported from dsh-newapi-provider unchanged: per-gateway model
 * lists, discovery, manual add, per-model overrides (name, mapping, context, output
 * cap, modalities, reasoning levels, protocol) and single/batch model tests. What
 * differs is the part a generic gateway cannot share with New API:
 *
 *   - a gateway is saved only after a successful probe, and the probe decides which
 *     quota adapter (if any) it gets — a gateway without one simply shows no quota;
 *   - the plugin may have no gateway at all, and then registers no model route;
 *   - no image/video tools (they are New API-specific) and no sidebar balance.
 *
 * A session-checked JSON API under /ai-gateway/api/ serves the settings page. Config
 * writes go through the DSH settings service, tokens through the DSH credential
 * service; no token is ever returned to the page.
 */
import z from '@deepseek-ai/schemastery';
import { LlmError, RetryPolicySchema, assertUsableApiKey, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { GatewayAdapter, DEFAULT_ENDPOINT_PRIORITY } from './lib/adapter.js';
import { Catalog, chatModels, upstreamModelOf, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './lib/catalog.js';
import { ModelsDev } from './lib/modelsdev.js';
import { fingerprint, redact } from './lib/util.js';
import { probe, identify, readQuota, gatewayRoot } from './lib/probe.js';
import { ChannelService, resolveChannels, validateBaseURL } from './lib/channels.js';
import { SiteFactsCache } from './lib/site-cache.js';
import { ModelTester } from './lib/model-test.js';
import { SERVICE_TIERS, composerSpeedTiers } from './lib/service-tiers.js';
import { SessionTiers } from './lib/session-tiers.js';

export const name = 'ai-gateway';
export const inject = ['llm'];

const ROUTE_PREFIX = '/ai-gateway/api/';
const VERSION = '0.7.0';
const ENDPOINT_TYPES = ['openai', 'anthropic', 'openai-response', 'gemini'];
const KINDS = ['chat', 'image', 'video', 'audio', 'embedding', 'other'];
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODALITIES = ['text', 'image', 'audio', 'video', 'pdf'];
const MAX_BODY_BYTES = 64 * 1024;

// Same override shape as dsh-newapi-provider, so both plugins describe a model alike.
const ModelOverride = z.object({
  name: z.string().description('Display name in the model picker.'),
  upstreamModel: z.string().default(undefined).description('Upstream wire model id; omitted uses the stable local model id.'),
  kind: z.union(KINDS).description('Force how the model is used: only chat models appear in the picker.'),
  hidden: z.boolean().description('Hide this model everywhere.'),
  contextWindow: z.number().step(1).min(1).description('Context window in tokens (overrides models.dev).'),
  maxTokens: z.number().step(1).min(1).description('Maximum output tokens (overrides models.dev).'),
  input: z.array(z.union(MODALITIES)).default(undefined).description('Input modalities the model accepts.'),
  reasoning: z.boolean().description('Whether the model supports reasoning effort.'),
  reasoningLevels: z.array(z.union(LEVELS)).default(undefined).description('Reasoning effort levels to offer.'),
  thinkingLevelMap: z.dict(z.union([z.string(), z.const(null)])).default(undefined)
    .description('Per-level wire value: a string is sent upstream, null hides the level. Omitted levels fall back to the detected value.'),
  protocol: z.union(ENDPOINT_TYPES).description('Force the wire protocol for this model.'),
  speedEnabled: z.boolean().default(undefined).description('Enable speed controls for this model; false suppresses service_tier and session overrides.'),
  allowedServiceTiers: z.array(z.string()).default(undefined).description('Speed tiers the user permits for this model.'),
  defaultReasoningEffort: z.string().default(undefined).description('Default reasoning level, selected from the enabled levels.'),
  serviceTierMap: z.dict(z.string()).default(undefined).description('Local speed tier id to wire service_tier string; explicit mappings override presets.'),
  serviceTier: z.string().default(undefined).description('Local OpenAI Chat/Responses speed tier id, including configured custom ids. Unset sends nothing. Gateway declarations are not verified support; accelerated tiers may cost more.'),
  custom: z.boolean().description('Add this model even if the gateway does not list it.'),
});

const Backend = z.object({
  family: z.string().description('Backend family found by the last probe (new-api, unknown, …).'),
  name: z.string().description('Name the backend reported about itself.'),
  version: z.string().description('Backend version, when reported.'),
  quotaKind: z.string().description('Quota adapter that answered at save time; absent when none did.'),
  modelCount: z.number().description('Models listed at save time.'),
  checkedAt: z.number().description('When the probe ran (ms since epoch).'),
});

const Channel = z.object({
  id: z.string().required().description('Stable gateway id.'),
  name: z.string().description('Display name.'),
  baseURL: z.string().required().description('Gateway address, with or without /v1.'),
  apiKeyEnv: z.string().role('credential-ref').description('Credential holding this gateway\'s token.'),
  providerId: z.string().description('Model-picker route for this gateway. Assigned once; changing it orphans sessions that used the old route.'),
  hidden: z.boolean().description('Keep the gateway configured but show none of its models in the model picker.'),
  headers: z.dict(z.string()).description('Extra HTTP headers for this gateway only.'),
  backend: Backend.description('What the probe found when this gateway was saved.'),
  models: z.dict(ModelOverride).description('Per-model overrides keyed by model id.'),
  enabledModels: z.array(z.string()).default(undefined).description('Models enabled on this gateway. Unset offers every model the gateway lists.'),
});

export const Config = z.object({
  channels: z.array(Channel).default([]).description('Saved gateways. Each one is its own group in the model picker.'),
  activeChannel: z.string().description('Legacy, ignored: every saved gateway is registered and usable at once.'),
  providerId: z.string().default('ai-gateway').description('Legacy route id for the first gateway. Later gateways get their own derived route.'),
  displayName: z.string().default('AI Gateway').description('Provider name shown in the model picker.'),
  endpointPriority: z.array(z.union(ENDPOINT_TYPES)).default([...DEFAULT_ENDPOINT_PRIORITY]).description('Preferred wire protocol when a model supports several.'),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).description('Context window when models.dev has no data for a model.'),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS).description('Output cap when models.dev has no data for a model.'),
  useModelsDev: z.boolean().default(true).description('Fill context window, output cap and modalities from models.dev.'),
  streamIdleTimeoutMs: z.number().min(1000).max(2147483647).default(300_000).description('Abort a model stream that stays silent this long.'),
  retryPolicy: RetryPolicySchema,
}).volatile();

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
}

export function apply(ctx, config) {
  const settingsNs = ctx.fiber.entry?.options.id ?? 'ai-gateway';
  const current = () => (typeof config?.get === 'function' ? config.get() : config) ?? {};
  const errors = new Map();
  const reportError = (scope, error) => errors.set(scope, { at: Date.now(), code: error?.code ?? 'ERROR', message: String(error?.message ?? error) });

  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber));
  });

  let channelsMemo;
  const channels = () => {
    const raw = current();
    if (channelsMemo?.raw !== raw) channelsMemo = { raw, value: resolveChannels(raw) };
    return channelsMemo.value;
  };

  const connFor = (ch) => {
    const raw = current();
    const overrides = ch.models ?? {};
    return {
      channelId: ch.id,
      channelName: ch.name,
      providerId: ch.providerId || raw.providerId || 'ai-gateway',
      // The group heading in the model picker is this gateway's own name.
      displayName: ch.name || raw.displayName || 'AI Gateway',
      hidden: ch.hidden === true,
      baseURL: ch.baseURL,
      apiKeyRef: credentialRef(ch.apiKeyEnv),
      overrides,
      enabledModels: Array.isArray(ch.enabledModels) ? ch.enabledModels : undefined,
      overridesRev: fingerprint(`${ch.id}|${JSON.stringify(overrides)}|${JSON.stringify(ch.enabledModels ?? null)}`),
      // Only gateways known to serve the pricing page are asked for it.
      fetchPricing: ch.backend?.family === 'new-api',
      // CLIProxyAPI declares speed tiers only in its client catalog. New API never serves
      // one, so it is not asked; an unrecognised gateway might, and the read is optional.
      fetchTierCatalog: ch.backend?.family !== 'new-api' && ch.backend?.family !== 'litellm',
      endpointPriority: raw.endpointPriority?.length ? raw.endpointPriority : DEFAULT_ENDPOINT_PRIORITY,
      defaultContextWindow: raw.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
      defaultMaxTokens: raw.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
      headers: { ...(ch.headers ?? {}) },
      streamIdleTimeoutMs: raw.streamIdleTimeoutMs ?? 300_000,
      retryPolicy: resolveRetryPolicy(raw.retryPolicy, 'ai-gateway retryPolicy'),
    };
  };

  const keyFor = async (ch) => {
    const credentials = ctx.get('credentials');
    const ref = credentialRef(ch.apiKeyEnv);
    const hit = credentials ? (await credentials.resolve(ref))?.value : undefined;
    if (!hit) throw new LlmError(`ai-gateway: no token stored for gateway "${ch.name}"; add it in Settings → AI Gateway`, 'MISSING_CREDENTIAL');
    return assertUsableApiKey(hit, 'ai-gateway', ref);
  };
  const keyConfigured = async (ch) => {
    try { await keyFor(ch); return true; } catch { return false; }
  };

  const modelsDev = new ModelsDev({ enabled: current().useModelsDev !== false, logger: ctx.logger });
  const catalogs = new Catalog({ modelsDev, logger: ctx.logger });
  modelsDev.onUpdated = () => catalogs.invalidate();

  const requireActive = () => {
    const { active } = channels();
    if (!active) throw new LlmError('ai-gateway: no gateway is saved yet; add one in Settings → AI Gateway', 'NOT_CONFIGURED');
    return active;
  };

  const catalogFor = async (ch, { signal, force = false } = {}, captured = connFor(ch)) => {
    const apiKey = await keyFor(ch);
    const conn = { ...captured, keyFingerprint: fingerprint(apiKey) };
    try {
      return await catalogs.get(conn, apiKey, { signal, force });
    } catch (error) {
      const stale = catalogs.peek(conn);
      if (stale) return stale;
      throw new LlmError(redact(`ai-gateway: cannot read the model list from ${gatewayRoot(conn.baseURL)}: ${error.message}`, apiKey), error.code === 'AUTH' ? 'AUTH' : 'TRANSPORT', { cause: error });
    }
  };

  // Capture gateway, address, headers, overrides and credential reference before any await.
  const capture = (id) => {
    const ch = structuredClone(id ? channels().list.find((c) => c.id === id) : requireActive());
    if (!ch) throw Object.assign(new Error(`unknown gateway "${id}"`), { status: 404 });
    const conn = connFor(ch);
    let key;
    const requireApiKey = () => key ??= keyFor(ch);
    return {
      connection: conn,
      requireApiKey,
      catalog: async (opts) => catalogFor(ch, opts ?? {}, conn),
    };
  };

  // Per-conversation speed choices from the composer; the model editor default is the fallback.
  const sessionTiers = new SessionTiers({ logger: ctx.logger });

  const adapter = new GatewayAdapter({
    sessionTier: (sessionId, channelId, modelId) => sessionTiers.get(sessionId, channelId, modelId),
    connection: (provider) => connectionFor(provider),
    capture: (provider) => captureRoute(provider),
    reportError,
    logger: ctx.logger,
    piAuth: undefined,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
  });

  // ------------------------------------------------------------ provider routes
  // One picker route per gateway: every gateway becomes its own group, so two gateways
  // serving the same model id stay distinct, and hiding one leaves the others untouched.
  const routeOfChannel = (ch) => connFor(ch).providerId;
  const channelForRoute = (provider) => channels().list.find((c) => routeOfChannel(c) === provider);
  const connectionFor = (provider) => {
    const ch = channelForRoute(provider);
    return connFor(ch ?? requireActive());
  };
  const captureRoute = (provider) => {
    const ch = channelForRoute(provider);
    if (!ch) throw new LlmError(`ai-gateway: no gateway owns the provider route "${provider}"`, 'UNKNOWN_PROVIDER');
    return capture(ch.id);
  };

  let registration;
  let registeredRoutes = [];
  let directory;
  let directoryKey;
  const routeState = { status: 'idle', routes: [], error: null };
  const ensureRegistration = () => {
    const { list } = channels();
    const conns = list.map((ch) => connFor(ch));
    const routes = conns.map((conn) => conn.providerId);
    if (!routes.length) {
      registration?.(); registration = undefined; registeredRoutes = [];
      directory?.(); directory = undefined; directoryKey = undefined;
      Object.assign(routeState, { status: 'idle', routes: [], error: null });
      return;
    }
    const entries = conns.map((conn) => ({
      provider: conn.providerId,
      displayName: conn.displayName,
      settingsNs,
      settingsPath: [],
      declared: true,
      defaultBaseURL: gatewayRoot(conn.baseURL),
    }));
    const key = JSON.stringify(entries);
    try {
      if (directoryKey !== key) {
        if (directory) directory.replace(entries); else directory = ctx.llm.registerConfigurableProviders(entries);
        directoryKey = key;
      }
    } catch (error) {
      routeState.error = `directory: ${error.message}`;
    }
    if (registeredRoutes.length === routes.length && registeredRoutes.every((r, i) => r === routes[i])) return;
    try {
      if (registration) registration.replace(routes); else registration = ctx.llm.registerAdapter(routes, adapter);
      registeredRoutes = routes;
      Object.assign(routeState, { status: 'registered', routes: conns.map((conn) => ({ route: conn.providerId, name: conn.displayName, channelId: conn.channelId, hidden: conn.hidden })), error: null });
    } catch (error) {
      Object.assign(routeState, { status: 'waiting', error: String(error?.message ?? error) });
      ctx.logger.warn(`ai-gateway: provider routes are not all available yet (${error.code ?? error.message}); will retry when they are released`);
    }
  };
  ensureRegistration();
  ctx.effect(() => () => {
    registration?.(); registration = undefined; registeredRoutes = [];
    directory?.(); directory = undefined;
  });
  ctx.on('llm/adapters-updated', () => {
    const routes = channels().list.map(routeOfChannel);
    if (routes.length !== registeredRoutes.length || routes.some((r, i) => r !== registeredRoutes[i])) ensureRegistration();
  });

  // ------------------------------------------------------------ quota
  // In the same shape as dsh-newapi-provider's balance state, so the ported page reads
  // it unchanged. Gateways without a quota adapter report `status: 'none'`.
  const quotas = new Map();
  const quotaOf = async (ch, { force = false } = {}) => {
    const kind = ch.backend?.quotaKind;
    if (!kind) return { status: 'none' };
    const cached = quotas.get(ch.id);
    if (!force && cached && Date.now() - cached.at < 60_000) return cached.value;
    let value;
    try {
      const apiKey = await keyFor(ch);
      const r = await readQuota({ baseURL: ch.baseURL, apiKey, kind, headers: ch.headers });
      if (r.ok) {
        const q = r.quota;
        const unit = q.unit === 'CNY' ? { unit: 'CNY', symbol: '¥' } : q.unit === 'TOKENS' ? { unit: 'TOKENS', symbol: '' } : q.unit === 'USD' ? { unit: 'USD', symbol: '$' } : { unit: String(q.unit), symbol: '' };
        value = {
          status: 'ok', at: Date.now(), kind,
          currency: { ...unit, estimated: false },
          token: { unlimited: Boolean(q.unlimited), used: q.used ?? null, remaining: q.remaining ?? null, granted: q.limit ?? null },
          user: q.account ? { remaining: q.account.remaining ?? null, used: q.account.used ?? null } : null,
        };
      } else {
        value = { status: 'error', code: r.code ?? 'error', message: redact(r.error, apiKey), errorAt: Date.now() };
      }
    } catch (error) {
      value = { status: 'error', code: error.code ?? 'error', message: String(error.message ?? error), errorAt: Date.now() };
    }
    quotas.set(ch.id, { at: Date.now(), value });
    return value;
  };

  const identities = new Map();
  const IDENTITY_TTL_MS = 30 * 60 * 1000;
  const originOf = (url) => { try { return new URL(gatewayRoot(url)).origin; } catch { return gatewayRoot(url); } };
  // Identification outlives the process: two requests per gateway, and its answer
  // (family, version, icon, title) changes rarely.
  const siteFacts = new SiteFactsCache({ logger: ctx.logger });
  const identityOf = async (ch, { force = false } = {}) => {
    const root = gatewayRoot(ch.baseURL);
    const origin = originOf(root);
    const hit = identities.get(root);
    if (!force && hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.value;
    if (!force) {
      const cached = siteFacts.get(origin);
      if (cached) { identities.set(root, { at: Date.now(), value: cached }); return cached; }
    }
    try {
      const value = await identify({ baseURL: root, headers: { ...(ch.headers ?? {}) } });
      identities.set(root, { at: Date.now(), value });
      siteFacts.set(origin, value);
      return value;
    } catch {
      return hit?.value ?? siteFacts.get(origin);
    }
  };
  /** What the page shows: the live identity when known, the saved probe facts otherwise. */
  const backendView = (ch, live) => {
    const saved = ch.backend ?? {};
    const known = live && live.family !== 'unknown' ? live : null;
    return {
      family: known?.family ?? saved.family ?? 'unknown',
      name: known?.name ?? saved.name ?? null,
      version: known?.version ?? saved.version ?? null,
      quotaKind: saved.quotaKind ?? null,
      modelCount: saved.modelCount ?? null,
      checkedAt: saved.checkedAt ?? null,
      info: known?.info ?? {},
      evidence: known?.evidence ?? null,
      title: known?.title ?? saved.title ?? null,
      // The site's own favicon when it has one; the page falls back to the type icon.
      icon: known?.icon?.dataUrl ?? null,
    };
  };

  ctx.on('loader/volatile-update', () => {
    channelsMemo = undefined;
    catalogs.invalidate();
    quotas.clear();
    modelsDev.enabled = current().useModelsDev !== false;
    try { ensureRegistration(); } catch (error) { ctx.logger.error(error); }
  });
  void modelsDev.refresh();

  // ------------------------------------------------------------ model list & tests
  const channelById = (id) => {
    const ch = channels().list.find((c) => c.id === id);
    if (!ch) throw Object.assign(new Error('unknown gateway'), { status: 404 });
    return ch;
  };

  /** Gateway catalog for one channel, ignoring its saved list (what the gateway offers). */
  const gatewayCatalog = async (ch, opts = {}) => {
    const snapshotCh = structuredClone(ch);
    const conn = { ...connFor(snapshotCh), enabledModels: undefined, channelId: `${snapshotCh.id}#gateway` };
    const apiKey = await keyFor(snapshotCh);
    return catalogs.get({ ...conn, keyFingerprint: fingerprint(apiKey) }, apiKey, opts);
  };

  const tester = new ModelTester({
    channelFacts: async (channelId) => {
      const bound = capture(channelId);
      const conn = bound.connection;
      return {
        baseURL: conn.baseURL, headers: conn.headers, endpointPriority: conn.endpointPriority,
        apiKey: bound.requireApiKey,
        entryFor: async (modelId) => (await bound.catalog()).entries.find((e) => e.id === modelId),
      };
    },
  });

  const discoverModels = async ({ channelId }) => {
    const ch = channelById(channelId);
    const value = await gatewayCatalog(ch, { force: true });
    const enabled = Array.isArray(ch.enabledModels) ? new Set(ch.enabledModels) : undefined;
    const gatewayIds = new Set(value.gatewayIds ?? value.entries.filter((e) => e.source?.gateway).map((e) => e.id));
    return {
      channelId: ch.id,
      fetchedAt: value.fetchedAt,
      listMode: enabled ? 'list' : 'auto',
      models: value.entries.filter((e) => gatewayIds.has(e.upstreamModel ?? e.id)).map((e) => ({
        id: e.id, upstreamModel: e.upstreamModel ?? e.id, kind: e.kind, vendor: e.vendor, input: e.input,
        contextWindow: e.contextWindow ?? null, maxTokens: e.maxTokens ?? null,
        reasoning: e.reasoning, pricing: e.pricing,
        status: !enabled || enabled.has(e.id) || e.upstreamModel !== e.id ? 'enabled' : 'new',
      })),
      missing: enabled
        ? [...enabled].filter((id) => !gatewayIds.has(upstreamModelOf({ id, upstreamModel: ch.models?.[id]?.upstreamModel }))).map((id) => ({ id, custom: ch.models?.[id]?.custom === true }))
        : [],
    };
  };

  // ------------------------------------------------------------ config writes
  // Address-only inspection: public endpoints only, no token and no model call, so the
  // editor can preview a gateway's icon, name and type before any credential is entered.
  const identifyGateway = async ({ baseURL }) => {
    const root = gatewayRoot(validateBaseURL(baseURL));
    const started = Date.now();
    const found = await identify({ baseURL: root, headers: {} });
    const value = { ...found, family: found.family ?? 'unknown' };
    siteFacts.set(originOf(root), { ...(siteFacts.get(originOf(root)) ?? {}), ...value });
    identities.set(root, { at: Date.now(), value });
    return {
      ok: value.reachable !== false,
      baseURL: root,
      latencyMs: Date.now() - started,
      family: value.family,
      familyName: value.name ?? null,
      version: value.version ?? null,
      siteTitle: value.title ?? null,
      suggestedName: value.suggestedName ?? null,
      icon: value.icon?.dataUrl ?? null,
      info: value.info ?? {},
      evidence: value.evidence ?? null,
    };
  };

  const channelService = new ChannelService({
    ns: settingsNs,
    current,
    settings: () => ctx.get('settings'),
    keyFor,
    keyConfigured,
    probe: (args) => probe(args),
    onProbed: (report) => {
      const origin = originOf(report.root ?? '');
      if (!origin) return;
      const known = siteFacts.get(origin);
      siteFacts.set(origin, {
        ...(known ?? {}),
        family: report.backend?.family ?? known?.family ?? 'unknown',
        name: report.backend?.name ?? known?.name ?? null,
        version: report.backend?.version ?? known?.version ?? null,
        info: report.backend?.info ?? known?.info ?? {},
        suggestedName: report.backend?.suggestedName ?? known?.suggestedName,
        ...(report.backend?.title ? { title: report.backend.title } : {}),
        ...(report.backend?.icon ? { icon: report.backend.icon } : {}),
      });
    },
    storeKey: async (keyName, apiKey) => {
      const credentials = ctx.get('credentials');
      if (!credentials) throw Object.assign(new Error('the DSH credential service is unavailable'), { status: 503 });
      await credentials.set(credentialRef(keyName), String(apiKey).trim());
    },
    unsetKey: async (keyName) => ctx.get('credentials')?.unset(credentialRef(keyName)),
    // The page's "test connection": the same probe the save runs, without saving.
    testGateway: async ({ baseURL, apiKey, headers }) => {
      const started = Date.now();
      const report = await probe({ baseURL, apiKey, headers });
      return {
        ok: report.usable,
        baseURL: report.root,
        latencyMs: Date.now() - started,
        systemName: report.backend?.name ?? null,
        siteTitle: report.backend?.title ?? null,
        suggestedName: report.backend?.suggestedName ?? null,
        icon: report.backend?.icon?.dataUrl ?? null,
        version: report.backend?.version ?? null,
        family: report.backend?.family ?? 'unknown',
        quotaKind: report.quota?.kind ?? null,
        models: report.models?.count != null ? {
          total: report.models.count,
          image: report.media?.imageModels?.length ?? 0,
          video: report.media?.videoModels?.length ?? 0,
          chat: Math.max(0, report.models.count - (report.media?.imageModels?.length ?? 0) - (report.media?.videoModels?.length ?? 0)),
          other: 0,
        } : undefined,
        ...(report.usable ? {} : { error: report.models?.error ?? 'the gateway did not list its models', code: report.models?.code ?? 'ERROR' }),
      };
    },
    headersFor: (ch, baseURL) => (ch && gatewayRoot(ch.baseURL) === gatewayRoot(baseURL) ? { ...(ch.headers ?? {}) } : {}),
    // First list edit on an automatic-mode gateway starts from what the gateway lists now.
    gatewayModelIds: async (ch) => (await gatewayCatalog(ch, { force: true })).entries.map((e) => e.id),
    changed: () => {
      channelsMemo = undefined; catalogs.invalidate(); quotas.clear(); ensureRegistration();
      const ids = new Set(channels().list.map((c) => c.id));
      for (const id of new Set([...tester.results.keys()].map((k) => k.split('\u0000')[0]))) if (!ids.has(id)) tester.forget(id);
      for (const id of new Set([...sessionTiers.map.keys()].map((k) => k.split('\u0000')[1]))) if (!ids.has(id)) sessionTiers.forgetChannel(id);
    },
  });

  // ------------------------------------------------------------ snapshot
  const withDeadline = async (p, ms, message) => {
    let timer;
    try {
      return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(message), { status: 504 })), ms); })]);
    } finally { clearTimeout(timer); }
  };

  const withTimeout = async (p, ms, fallback) => {
    let timer;
    try { return await Promise.race([p, new Promise((r) => { timer = setTimeout(() => r(fallback), ms); })]); }
    finally { clearTimeout(timer); }
  };

  /** One gateway's own model list, with its own overrides and test results. */
  const modelsOf = async (ch, { force = false } = {}) => {
    const captured = structuredClone(ch);
    const conn = connFor(captured);
    const value = await catalogFor(captured, { force }, conn);
    if (captured.id === channels().active?.id) errors.delete('catalog');
    return {
      channelId: captured.id,
      listMode: Array.isArray(captured.enabledModels) ? 'list' : 'auto',
      fetchedAt: value.fetchedAt,
      pricingAvailable: value.pricingAvailable,
      pricingError: value.pricingError,
      entries: value.entries.map(({ thinkingLevelMap, ...e }) => ({
        ...e,
        automaticThinkingLevelMap: e.automaticThinkingLevelMap ?? null,
        override: structuredClone(Object.hasOwn(captured.models ?? {}, e.id) ? captured.models[e.id] : {}),
        automaticContextWindow: e.automaticContextWindow ?? conn.defaultContextWindow,
        automaticMaxTokens: e.automaticMaxTokens ?? conn.defaultMaxTokens,
        lastTest: tester.last(captured.id, e.id) ?? null,
        effectiveContextWindow: e.contextWindow ?? conn.defaultContextWindow,
        effectiveMaxTokens: e.maxTokens ?? conn.defaultMaxTokens,
      })),
    };
  };

  /**
   * Speed choices the composer may offer for one model in one conversation.
   * Offered only for OpenAI-protocol chat models on the active gateway, and only tiers
   * that have evidence: declared by the gateway, or verified by a test, or already
   * chosen in the model editor. Nothing is offered for an unknown model.
   */
  const sessionTierView = async ({ sessionId, modelId, provider } = {}) => {
    if (typeof sessionId !== 'string' || !sessionId || typeof modelId !== 'string' || !modelId) throw Object.assign(new Error('sessionId and modelId are required'), { status: 400 });
    // Only this plugin's own routes are ours to annotate.
    const active = provider === undefined ? channels().active : channelForRoute(provider);
    if (!active) return { available: false, reason: 'not an AI Gateway model' };
    if (active.hidden === true) return { available: false, reason: 'this gateway is hidden from the model picker' };
    const catalog = await catalogFor(active, {}, connFor(active));
    const entry = catalog.entries.find((e) => e.id === modelId && e.kind === 'chat');
    if (!entry || !entry.speedTiers?.compatible) return { available: false, reason: 'not an OpenAI-protocol chat model on this gateway' };
    const last = tester.last(active.id, modelId);
    const offered = composerSpeedTiers(entry, last, true);
    if (!offered.some((option) => option.evidence !== 'standard')) return { available: false, reason: 'no speed tier declared, verified or configured for this model' };
    const savedChoice = sessionTiers.get(sessionId, active.id, modelId);
    const choice = savedChoice && entry.allowedServiceTiers?.includes(savedChoice) ? savedChoice : undefined;
    const fallback = entry.allowedServiceTiers?.includes(entry.serviceTier) ? entry.serviceTier : null;
    return {
      available: true,
      channelId: active.id,
      modelId,
      modelDefault: fallback,
      choice: choice ?? null,
      effective: choice ?? fallback,
      options: offered,
    };
  };

  const snapshot = async ({ force = false } = {}) => {
    const state = channels();
    const raw = current();
    // No catalog is read here: the page loads one gateway's model list on demand, so a
    // periodic refresh never fetches every gateway just to render the channel list.
    const list = await Promise.all(state.list.map(async (c) => ({
      id: c.id,
      name: c.name,
      route: routeOfChannel(c),
      hidden: c.hidden === true,
      baseURL: gatewayRoot(c.baseURL),
      keyName: c.apiKeyEnv,
      keyConfigured: await keyConfigured(c),
      backend: backendView(c, await withTimeout(identityOf(c, { force }), 5_000, identities.get(gatewayRoot(c.baseURL))?.value)),
      overrideCount: Object.keys(c.models ?? {}).length,
      enabledCount: Array.isArray(c.enabledModels) ? c.enabledModels.length : null,
      listMode: Array.isArray(c.enabledModels) ? 'list' : 'auto',
      balance: c.hidden === true ? { status: 'none' } : await withTimeout(quotaOf(c, { force }), 6_000, { status: 'idle' }),
    })));
    return {
      plugin: 'dsh-ai-gateway-provider',
      version: VERSION,
      revision: channelService.revision(),
      channels: list,
      route: { ...routeState, displayName: raw.displayName || 'AI Gateway' },
      defaults: { contextWindow: raw.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW, maxTokens: raw.defaultMaxTokens ?? DEFAULT_MAX_TOKENS },
      modelsDev: modelsDev.status(),
      errors: Object.fromEntries(errors),
    };
  };

  // ------------------------------------------------------------ page API
  const routes = {
    'GET state': async () => snapshot(),
    'POST refresh': async () => {
      catalogs.invalidate();
      await modelsDev.refresh({ force: true });
      return snapshot({ force: true });
    },
    ...Object.fromEntries([
['channel/test', 'test'], ['channel/save', 'save'],
      ['channel/delete', 'delete'], ['channel/visibility', 'visibility'],
      ['model/override', 'model_override'], ['models/set', 'models_set'],
      ['models/hidden', 'models_hidden'],
    ].map(([route, action]) => [`POST ${route}`, async (body) => {
      const result = await channelService.run(action, body);
      return action === 'test' ? result : snapshot();
    }])),
    'POST channel/identify': async (body) => {
      if (typeof body?.baseURL !== 'string' || !body.baseURL.trim()) throw Object.assign(new Error('baseURL is required'), { status: 400 });
      return withDeadline(identifyGateway({ baseURL: body.baseURL }), 12_000, 'the gateway did not answer in time');
    },
    'POST models/discover': async (body) => discoverModels(body),
    'POST models/list': async (body) => {
      if (typeof body?.channelId !== 'string' || !body.channelId) throw Object.assign(new Error('channelId is required'), { status: 400 });
      return modelsOf(channelById(body.channelId), { force: body.force === true });
    },
    'POST model/test': async (body) => tester.run(body),
    // Composer speed control: what the session's own gateway offers for one model, plus
    // this conversation's choice.
    'POST session/tier': async (body) => sessionTierView(body),
    'POST session/tier/set': async (body) => {
      const { sessionId, modelId, tier, provider, channelId } = body ?? {};
      const active = requireActive();
      const view = await sessionTierView({ sessionId, modelId, provider });
      if (channels().active?.id !== active.id || view.channelId !== active.id || (channelId && channelId !== active.id)) throw Object.assign(new Error('gateway changed; reopen the speed menu'), { status: 409 });
      if (!view.available) throw Object.assign(new Error(view.reason ?? 'this model has no speed tiers'), { status: 400 });
      if (tier !== null && !view.options.some((o) => o.tier === tier)) throw Object.assign(new Error('that tier is not offered for this model'), { status: 400 });
      sessionTiers.set(sessionId, active.id, modelId, tier);
      return sessionTierView({ sessionId, modelId });
    },
  };

  ctx.inject(['webServer'], (wctx) => {
    wctx.effect(() => wctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX.slice(0, -1),
      async handler(req, res) {
        // `/api/` belongs to DSH; this plugin uses its own prefix with the same session check.
        const conn = ctx.get('connection');
        if (!conn || conn.requestRejection(req) !== undefined) return sendJson(res, 403, { error: 'forbidden' });
        const url = new URL(req.url ?? '/', 'http://local');
        const route = url.pathname.startsWith(ROUTE_PREFIX) ? routes[`${req.method} ${url.pathname.slice(ROUTE_PREFIX.length)}`] : undefined;
        if (!route) return sendJson(res, 404, { error: 'not found' });
        try {
          let body = {};
          if (req.method === 'POST') {
            // A JSON content type forces a CORS preflight for cross-site callers.
            if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return sendJson(res, 415, { error: 'expected application/json' });
            body = await readBody(req);
          }
          return sendJson(res, 200, await route(body));
        } catch (error) {
          return sendJson(res, error?.status ?? 500, { error: String(error?.message ?? error), code: error?.code ?? null });
        }
      },
    }));
  });
}
