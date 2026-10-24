/**
 * AI Gateway (dsh-ai-gateway-provider) — Host half.
 *
 *   - Gateways ("channels"): address + token, saved only after a successful probe.
 *     Exactly one is active and serves the `ai-gateway` model route.
 *   - The model route is registered only while at least one gateway is saved, so an
 *     empty install adds nothing to the model picker.
 *   - Quota is read with the one adapter the probe found for that gateway; a gateway
 *     without a quota endpoint simply has no quota, never an error state.
 *   - A session-checked JSON API under /ai-gateway/api/ serves the settings page.
 *     Config writes go through the DSH settings service, tokens through the DSH
 *     credential service; no token is ever returned to the page.
 */
import z from '@deepseek-ai/schemastery';
import { LlmError, RetryPolicySchema, assertUsableApiKey, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { GatewayAdapter, DEFAULT_ENDPOINT_PRIORITY } from './lib/adapter.js';
import { Catalog, chatModels, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './lib/catalog.js';
import { ModelsDev } from './lib/modelsdev.js';
import { fingerprint, redact } from './lib/util.js';
import { probe, readQuota, gatewayRoot } from './lib/probe.js';
import { ChannelService, resolveChannels } from './lib/channels.js';

export const name = 'ai-gateway';
export const inject = ['llm'];

const ROUTE_PREFIX = '/ai-gateway/api/';
const VERSION = '0.2.0';
const ENDPOINT_TYPES = ['openai', 'anthropic', 'openai-response', 'gemini'];
const MAX_BODY_BYTES = 16 * 1024;

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
  headers: z.dict(z.string()).description('Extra HTTP headers for this gateway only.'),
  backend: Backend.description('What the probe found when this gateway was saved.'),
});

export const Config = z.object({
  channels: z.array(Channel).default([]).description('Saved gateways. Exactly one is active at a time.'),
  activeChannel: z.string().description('Id of the active gateway; the first one when unset.'),
  providerId: z.string().default('ai-gateway').description('Provider route id in the model picker. Changing it orphans sessions that use the old id.'),
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
  const reportError = (scope, error) => errors.set(scope, { at: Date.now(), message: String(error?.message ?? error) });

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
    return {
      channelId: ch.id,
      providerId: raw.providerId || 'ai-gateway',
      displayName: raw.displayName || 'AI Gateway',
      baseURL: ch.baseURL,
      apiKeyRef: credentialRef(ch.apiKeyEnv),
      overrides: {},
      enabledModels: undefined,
      overridesRev: fingerprint(ch.id),
      // Only gateways known to serve the pricing page are asked for it.
      fetchPricing: ch.backend?.family === 'new-api',
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

  // Capture gateway, address, headers and credential reference before any await.
  const capture = (id) => {
    const ch = structuredClone(id ? channels().list.find((c) => c.id === id) : requireActive());
    if (!ch) throw Object.assign(new Error('unknown gateway'), { status: 404 });
    const conn = connFor(ch);
    let key;
    const requireApiKey = () => key ??= keyFor(ch);
    return {
      connection: conn,
      requireApiKey,
      catalog: async (opts) => {
        const apiKey = await requireApiKey();
        const keyed = { ...conn, keyFingerprint: fingerprint(apiKey) };
        try {
          return await catalogs.get(keyed, apiKey, opts);
        } catch (error) {
          const stale = catalogs.peek(keyed);
          if (stale) return stale;
          throw new LlmError(redact(`ai-gateway: cannot read the model list from ${gatewayRoot(conn.baseURL)}: ${error.message}`, apiKey), error.code === 'AUTH' ? 'AUTH' : 'TRANSPORT', { cause: error });
        }
      },
    };
  };

  const adapter = new GatewayAdapter({
    connection: () => connFor(requireActive()),
    capture,
    reportError,
    logger: ctx.logger,
    piAuth: undefined,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
  });

  // ------------------------------------------------------------ provider route
  // Present only while a gateway is saved; withdrawn when the last one is removed.
  let registration;
  let registeredRoute;
  let directory;
  let directoryKey;
  const routeState = { status: 'idle', route: null, error: null };
  const ensureRegistration = () => {
    const { active } = channels();
    if (!active) {
      registration?.(); registration = undefined; registeredRoute = undefined;
      directory?.(); directory = undefined; directoryKey = undefined;
      Object.assign(routeState, { status: 'idle', route: null, error: null });
      return;
    }
    const conn = connFor(active);
    const entries = [{
      provider: conn.providerId,
      displayName: conn.displayName,
      settingsNs,
      settingsPath: [],
      declared: true,
      defaultBaseURL: gatewayRoot(conn.baseURL),
    }];
    const key = JSON.stringify(entries);
    try {
      if (directoryKey !== key) {
        if (directory) directory.replace(entries); else directory = ctx.llm.registerConfigurableProviders(entries);
        directoryKey = key;
      }
    } catch (error) {
      routeState.error = `directory: ${error.message}`;
    }
    if (registeredRoute === conn.providerId) return;
    try {
      if (registration) registration.replace([conn.providerId]); else registration = ctx.llm.registerAdapter([conn.providerId], adapter);
      registeredRoute = conn.providerId;
      Object.assign(routeState, { status: 'registered', route: conn.providerId, error: null });
    } catch (error) {
      Object.assign(routeState, { status: 'waiting', route: conn.providerId, error: String(error?.message ?? error) });
      ctx.logger.warn(`ai-gateway: provider route "${conn.providerId}" is not available yet (${error.code ?? error.message}); will retry when it is released`);
    }
  };
  ensureRegistration();
  ctx.effect(() => () => {
    registration?.(); registration = undefined;
    directory?.(); directory = undefined;
  });
  ctx.on('llm/adapters-updated', () => {
    const { active } = channels();
    if (active && registeredRoute !== connFor(active).providerId) ensureRegistration();
  });

  // ------------------------------------------------------------ quota
  // Cached per gateway; refreshed on demand and after edits. Never blocks the page long.
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
      value = r.ok ? { status: 'ok', ...r.quota, at: Date.now() } : { status: 'error', code: r.code ?? 'error', message: redact(r.error, apiKey) };
    } catch (error) {
      value = { status: 'error', code: error.code ?? 'error', message: String(error.message ?? error) };
    }
    quotas.set(ch.id, { at: Date.now(), value });
    return value;
  };

  ctx.on('loader/volatile-update', () => {
    channelsMemo = undefined;
    catalogs.invalidate();
    quotas.clear();
    modelsDev.enabled = current().useModelsDev !== false;
    try { ensureRegistration(); } catch (error) { ctx.logger.error(error); }
  });
  void modelsDev.refresh();

  // ------------------------------------------------------------ writes
  const channelService = new ChannelService({
    ns: settingsNs,
    current,
    settings: () => ctx.get('settings'),
    keyFor,
    probe: ({ baseURL, apiKey, headers }) => probe({ baseURL, apiKey, headers }),
    storeKey: async (keyName, apiKey) => {
      const credentials = ctx.get('credentials');
      if (!credentials) throw Object.assign(new Error('the DSH credential service is unavailable'), { status: 503 });
      await credentials.set(credentialRef(keyName), apiKey);
    },
    unsetKey: async (keyName) => ctx.get('credentials')?.unset(credentialRef(keyName)),
    changed: () => { channelsMemo = undefined; catalogs.invalidate(); quotas.clear(); errors.clear(); ensureRegistration(); },
  });

  // ------------------------------------------------------------ snapshot
  const withTimeout = async (p, ms, fallback) => {
    let timer;
    try { return await Promise.race([p, new Promise((r) => { timer = setTimeout(() => r(fallback), ms); })]); }
    finally { clearTimeout(timer); }
  };

  const snapshot = async ({ force = false } = {}) => {
    const state = channels();
    const raw = current();
    let models = null;
    if (state.active) {
      try {
        const catalog = await withTimeout(capture().catalog({ force }), 12_000, undefined);
        if (catalog) {
          errors.delete('catalog');
          models = {
            fetchedAt: catalog.fetchedAt,
            chat: chatModels(catalog).map((e) => ({
              id: e.id, name: e.name, endpointTypes: e.endpointTypes, input: e.input, reasoning: e.reasoning,
              contextWindow: e.contextWindow ?? raw.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
            })),
            other: catalog.entries.filter((e) => e.kind !== 'chat' && !e.hidden).map((e) => ({ id: e.id, kind: e.kind })),
          };
        }
      } catch (error) {
        reportError('catalog', error);
      }
    }
    const list = await Promise.all(state.list.map(async (c) => ({
      id: c.id,
      name: c.name,
      baseURL: gatewayRoot(c.baseURL),
      backend: c.backend ?? null,
      keyConfigured: await keyConfigured(c),
      active: c.id === state.active?.id,
      quota: await withTimeout(quotaOf(c, { force }), 6_000, { status: 'pending' }),
    })));
    return {
      plugin: 'dsh-ai-gateway-provider',
      version: VERSION,
      revision: channelService.revision(),
      channels: list,
      activeChannel: state.active?.id ?? null,
      route: { ...routeState, displayName: raw.displayName || 'AI Gateway' },
      models,
      errors: Object.fromEntries(errors),
    };
  };

  // ------------------------------------------------------------ page API
  const routes = {
    'GET state': () => snapshot(),
    'POST refresh': () => snapshot({ force: true }),
    'POST check': (body) => channelService.check(body),
    'POST channel/save': (body) => channelService.run('save', body),
    'POST channel/activate': (body) => channelService.run('activate', body),
    'POST channel/delete': (body) => channelService.run('delete', body),
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
