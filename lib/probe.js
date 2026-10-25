/**
 * Gateway capability probe.
 *
 * Given only a base URL and a token, find out what an OpenAI-compatible gateway can
 * do. Every probe is a read-only GET that costs nothing; a failure only removes that
 * capability, it never stops the run. Only `/v1/models` is required for the gateway
 * to be usable — everything else decides what extra UI to show.
 *
 * Safety rules, enforced here rather than by callers:
 *   - redirects are never followed, so the token cannot be forwarded to another host;
 *   - response bodies are read up to a fixed size;
 *   - the token never appears in results or error text.
 */

export const PROBE_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 1024 * 1024;
/** New API reports an unlimited token as this many "dollars" on the OpenAI billing route. */
const UNLIMITED_SENTINEL = 100_000_000;

/** Accept a site root or an address ending in /v1; probes always build from the root. */
export function gatewayRoot(baseURL) {
  const url = new URL(String(baseURL).trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('use an http(s) address');
  if (url.username || url.password) throw new Error('put the token in the key field, not in the address');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  url.search = '';
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

export function redact(text, secret) {
  let out = String(text ?? '');
  if (secret) out = out.split(secret).join('<redacted>');
  return out.replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-<redacted>');
}

async function readBounded(res, limit = MAX_BODY_BYTES) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw Object.assign(new Error('response too large'), { code: 'TOO_LARGE' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * One GET. Resolves to a plain record instead of throwing, so every probe can be
 * judged on its own. `json` is set only for a JSON body: an HTML 200 (a SPA fallback
 * page) must never count as an API answer.
 */
async function get(url, { apiKey, headers = {}, signal, fetchImpl = fetch } = {}) {
  const started = Date.now();
  const signals = [AbortSignal.timeout(PROBE_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  try {
    const res = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.any(signals),
      headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...headers },
    });
    const ms = Date.now() - started;
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel?.();
      return { ok: false, status: res.status, ms, error: 'redirected; not followed so the token stays with this host' };
    }
    const text = await readBounded(res);
    const contentType = res.headers.get('content-type') || '';
    let json;
    if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
      try { json = JSON.parse(text); } catch { json = undefined; }
    }
    return { ok: res.ok, status: res.status, ms, json, html: /^\s*</.test(text), text: redact(text.slice(0, 200), apiKey) };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR';
    return { ok: false, status: 0, ms: Date.now() - started, error: redact(timedOut ? 'timed out' : (error?.cause?.code ?? error?.message ?? String(error)), apiKey) };
  }
}

/** Stable, locale-free failure code; the page turns it into text. */
export function codeOf(r) {
  if (r.status >= 300 && r.status < 400) return 'redirect';
  if (r.error === 'timed out') return 'timeout';
  if (r.status === 0) return 'network';
  if (r.status === 401 || r.status === 403) return 'unauthorized';
  if (r.status === 404) return 'not-found';
  if (r.html) return 'html';
  return 'http';
}

/** Short reason for a failed probe, in English; kept as the technical detail. */
function reason(r) {
  if (r.error) return r.error;
  if (r.status === 401 || r.status === 403) return `token rejected (${r.status})`;
  if (r.status === 404) return 'not found (404)';
  if (r.html) return `returned a web page, not an API (${r.status})`;
  const message = r.json?.error?.message ?? r.json?.message ?? r.json?.detail;
  return message ? `${r.status}: ${String(message).slice(0, 120)}` : `HTTP ${r.status}`;
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v) => (v == null ? null : Math.round(v * 10_000) / 10_000);

/** New API display rules: USD = quota / quota_per_unit; CNY multiplies by the site's rate. */
function newApiDisplay(status) {
  const perUnit = Number(status?.quota_per_unit) > 0 ? Number(status.quota_per_unit) : 500_000;
  const type = String(status?.quota_display_type ?? (status?.display_in_currency === false ? 'TOKENS' : 'USD')).toUpperCase();
  const rate = Number(status?.usd_exchange_rate) > 0 ? Number(status.usd_exchange_rate) : 7.3;
  if (type === 'CNY') return { unit: 'CNY', factor: rate / perUnit };
  if (type === 'TOKENS') return { unit: 'TOKENS', factor: 1 };
  if (type === 'CUSTOM') {
    const custom = Number(status?.custom_currency_exchange_rate) > 0 ? Number(status.custom_currency_exchange_rate) : 1;
    return { unit: status?.custom_currency_symbol || 'CUSTOM', factor: custom / perUnit };
  }
  return { unit: 'USD', factor: 1 / perUnit };
}

/**
 * Quota adapters. Each turns one backend's own answer into the same shape:
 * `{ unit, remaining, used, limit, unlimited }`, numbers in `unit` or null.
 * `applies` keeps an adapter from being tried where it cannot answer.
 */
export const QUOTA_ADAPTERS = [
  {
    kind: 'new-api',
    label: 'New API token quota',
    applies: (ctx) => ctx.family === 'new-api',
    async read({ root, apiKey, headers, status, signal, fetchImpl }) {
      const r = await get(`${root}/api/usage/token/`, { apiKey, headers, signal, fetchImpl });
      const d = r.json?.data;
      if (!r.ok || r.json?.code === false || !d || typeof d !== 'object') return { ok: false, status: r.status, code: codeOf(r), error: reason(r) };
      const display = newApiDisplay(status);
      const unlimited = d.unlimited_quota === true;
      const at = (v) => (finite(v) == null ? null : round(v * display.factor));
      // Present only when the token allows user-quota queries; an unlimited token
      // still has a finite account behind it, which is the number users care about.
      const account = d.user_quota && typeof d.user_quota === 'object'
        ? { remaining: at(d.user_quota.total_available), used: at(d.user_quota.total_used) }
        : null;
      return {
        ok: true,
        quota: {
          unit: display.unit,
          unlimited,
          remaining: unlimited ? null : at(d.total_available),
          used: at(d.total_used),
          limit: unlimited ? null : at(d.total_granted),
          account,
        },
      };
    },
  },
  {
    kind: 'litellm',
    label: 'LiteLLM key budget',
    applies: () => true,
    async read({ root, apiKey, headers, signal, fetchImpl }) {
      // No `?key=` on purpose: LiteLLM falls back to the Authorization header, and a
      // query parameter would put the key into every access log in front of the proxy.
      const r = await get(`${root}/key/info`, { apiKey, headers, signal, fetchImpl });
      const info = r.json?.info;
      if (!r.ok || !info || typeof info !== 'object' || !('spend' in info)) return { ok: false, status: r.status, code: codeOf(r), error: reason(r) };
      const spend = finite(info.spend);
      const budget = finite(info.max_budget);
      return {
        ok: true,
        quota: {
          unit: 'USD',
          unlimited: budget == null,
          remaining: budget == null || spend == null ? null : round(Math.max(0, budget - spend)),
          used: round(spend),
          limit: round(budget),
          resetsAt: info.budget_reset_at ?? null,
        },
      };
    },
  },
  {
    // The old OpenAI dashboard billing routes. Not an OpenAI product any more, but the
    // one-api family (one-api, new-api, done-hub, …) still serves them, which makes this
    // the closest thing to a shared quota standard across relays.
    kind: 'openai-billing',
    label: 'OpenAI-style billing routes',
    applies: () => true,
    async read({ root, apiKey, headers, signal, fetchImpl }) {
      const sub = await get(`${root}/v1/dashboard/billing/subscription`, { apiKey, headers, signal, fetchImpl });
      const limit = finite(sub.json?.hard_limit_usd);
      if (!sub.ok || sub.json?.error || limit == null) return { ok: false, status: sub.status, code: codeOf(sub), error: reason(sub) };
      const usage = await get(`${root}/v1/dashboard/billing/usage`, { apiKey, headers, signal, fetchImpl });
      // total_usage is in cents on this route.
      const usedCents = usage.ok ? finite(usage.json?.total_usage) : null;
      const used = usedCents == null ? null : round(usedCents / 100);
      const unlimited = limit >= UNLIMITED_SENTINEL;
      return {
        ok: true,
        quota: {
          // The route says "usd", but one-api forks fill it in their display currency.
          unit: 'site currency',
          unlimited,
          remaining: unlimited || used == null ? null : round(Math.max(0, limit - used)),
          used,
          limit: unlimited ? null : round(limit),
        },
      };
    },
  },
];

/**
 * Read quota for a saved channel with the adapter its probe found. Only that one
 * adapter runs: a saved channel already knows which endpoint answers.
 */
export async function readQuota({ baseURL, apiKey, kind, headers = {}, signal, fetchImpl = fetch }) {
  const adapter = QUOTA_ADAPTERS.find((a) => a.kind === kind);
  if (!adapter) return { ok: false, code: 'unsupported', error: `no quota adapter "${kind}"` };
  const root = gatewayRoot(baseURL);
  let status;
  if (kind === 'new-api') {
    const r = await get(`${root}/api/status`, { headers, signal, fetchImpl });
    status = r.ok && r.json ? (r.json.data ?? r.json) : undefined;
  }
  const result = await adapter.read({ root, apiKey, headers, status, signal, fetchImpl });
  return result.ok ? { ok: true, quota: { kind, ...result.quota } } : result;
}

/**
 * Identify a gateway without a token: family, version, public info. Used to refresh
 * what is shown for saved gateways; it sends no credential anywhere.
 */
export async function identify({ baseURL, headers = {}, signal, fetchImpl = fetch, skipSite = false }) {
  const root = gatewayRoot(baseURL);
  const statusRes = await get(`${root}/api/status`, { headers, signal, fetchImpl });
  const status = statusRes.ok && statusRes.json ? (statusRes.json.data ?? statusRes.json) : undefined;
  let rootDoc;
  if (!status) {
    const rootRes = await get(`${root}/`, { headers, signal, fetchImpl });
    rootDoc = rootRes.ok && rootRes.json && typeof rootRes.json === 'object' ? rootRes.json : undefined;
  }
  const family = familyOf(status, rootDoc);
  const site = skipSite ? {} : await readSite({ baseURL: root, headers, signal, fetchImpl }).catch(() => ({}));
  return {
    ...family,
    version: status?.version ?? null,
    info: publicInfoOf(family.family, status, rootDoc),
    ...(site.title ? { title: site.title } : {}),
    ...(site.icon ? { icon: site.icon } : {}),
    suggestedName: suggestedNameOf(site.title, family.name, root),
    reachable: statusRes.status > 0 || Boolean(rootDoc),
  };
}

const ICON_MAX_BYTES = 64 * 1024;
const ICON_TYPES = /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|webp|jpeg|gif)$/i;
const ICON_LINK = /<link\b[^>]*>/gi;
const ICON_REL = /\brel\s*=\s*["']?([^"'>]+)/i;
const ICON_HREF = /\bhref\s*=\s*["']([^"']+)["']/i;

/** Raw bytes of one icon response, or undefined when it is not a usable image. */
async function fetchIconBytes(url, { headers, signal, fetchImpl }) {
  const signals = [AbortSignal.timeout(PROBE_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  try {
    const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.any(signals), headers: { accept: 'image/*', ...headers } });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!res.ok || !ICON_TYPES.test(type)) { await res.body?.cancel?.(); return undefined; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > ICON_MAX_BYTES) return undefined;
    return { bytes: buf, type };
  } catch {
    return undefined;
  }
}

/** Pick the declared icon from a page's <link> tags: normal icon first, then apple-touch-icon. */
function iconHrefFrom(html) {
  const icons = [];
  for (const tag of String(html).match(ICON_LINK) ?? []) {
    const rel = (tag.match(ICON_REL)?.[1] ?? '').toLowerCase();
    const href = tag.match(ICON_HREF)?.[1];
    if (!href || !/\bicon\b/.test(rel)) continue;
    icons.push({ href: href.trim(), rank: rel.includes('apple-touch') ? 2 : rel.split(/\s+/).length > 1 && rel.includes('shortcut') ? 1 : 0 });
  }
  icons.sort((a, b) => a.rank - b.rank);
  return icons[0]?.href;
}

/**
 * The gateway site's own icon, as a data URL the page can render directly.
 * Order: an inline data: icon, then <link rel="icon"> from the site root, then
 * /favicon.ico. Only the gateway's own origin is used: a page-declared icon on some
 * other host is skipped, so this never turns into a fetch of an arbitrary URL.
 * @returns `{ dataUrl, type, source }` or undefined when the site has none.
 */
export async function readSite({ baseURL, headers = {}, signal, fetchImpl = fetch }) {
  const root = gatewayRoot(baseURL);
  const origin = new URL(root).origin;
  const inline = (href) => {
    const m = /^data:(image\/[a-z0-9.+-]+)(?:;charset=[^;,]+)?(;base64)?,(.*)$/i.exec(href);
    if (!m || !ICON_TYPES.test(m[1])) return undefined;
    const data = m[2] ? m[3] : decodeURIComponent(m[3]);
    const bytes = Buffer.from(data, m[2] ? 'base64' : 'utf8');
    if (!bytes.length || bytes.length > ICON_MAX_BYTES) return undefined;
    return { dataUrl: `data:${m[1]};base64,${bytes.toString('base64')}`, type: m[1].toLowerCase(), source: 'inline' };
  };
  const fromBytes = (found, source) => ({ dataUrl: `data:${found.type};base64,${found.bytes.toString('base64')}`, type: found.type, source });

  const out = {};

  // 1. A declared icon on the landing page (the only page we know is the site's own).
  //    The same response carries the site title, which is a better default name than the host.
  const page = await get(`${root}/`, { headers, signal, fetchImpl });
  if (page.html) {
    const pageRes = await fetchImpl(`${root}/`, { redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { accept: 'text/html', ...headers } }).catch(() => undefined);
    const html = pageRes?.ok ? await readBounded(pageRes, ICON_MAX_BYTES).catch(() => '') : '';
    const title = html ? siteTitleFrom(html) : undefined;
    if (title) out.title = title;
    const href = html ? iconHrefFrom(html) : undefined;
    if (href) {
      if (href.startsWith('data:')) {
        const found = inline(href);
        if (found) return { ...out, icon: found };
      } else {
        let target;
        try { target = new URL(href, `${root}/`); } catch { target = undefined; }
        if (target && target.origin === origin && ['http:', 'https:'].includes(target.protocol)) {
          const found = await fetchIconBytes(target.href, { headers, signal, fetchImpl });
          if (found) return { ...out, icon: fromBytes(found, 'link') };
        }
      }
    }
  }

  // 2. The conventional path. Served even when the root is a JSON API.
  const found = await fetchIconBytes(`${origin}/favicon.ico`, { headers, signal, fetchImpl });
  return { ...out, ...(found ? { icon: fromBytes(found, 'favicon.ico') } : {}) };
}

/** Best default display name: a page title, else the backend's own name, else the host. */
function suggestedNameOf(title, backendName, root) {
  const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
  const name = clean(title) || clean(backendName);
  if (name) return name.slice(0, 80);
  try { return new URL(root).host; } catch { return root; }
}

/** The site's own icon, when it has one. */
export async function readIcon(options) {
  return (await readSite(options)).icon;
}

const TITLE_TAG = /<title[^>]*>([\s\S]{1,300}?)<\/title>/i;

/** A usable display name from a page title: entities decoded, whitespace collapsed. */
function siteTitleFrom(html) {
  const raw = html.match(TITLE_TAG)?.[1];
  if (!raw) return undefined;
  const text = raw
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[name.toLowerCase()] ?? ' '))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 80) : undefined;
}

/** Wire protocols the gateway reports per model, most common first. */
function protocolsOf(models) {
  const counts = new Map();
  for (const model of models) {
    const types = Array.isArray(model?.supported_endpoint_types) ? model.supported_endpoint_types : [];
    for (const type of types.length ? types : ['unreported']) counts.set(type, (counts.get(type) || 0) + 1);
  }
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
}

const IMAGE_ID = /(^|[-_/.])(gpt-image|dall-e|imagen|flux|seedream|cogview|sdxl|sd3|midjourney|mj-|ideogram|recraft|qwen-image|nano-banana|grok-.*image)/i;
const VIDEO_ID = /(^|[-_/.])(sora|veo|kling|vidu|hailuo|seedance|wan\d|cogvideo|runway|pika|luma|grok-.*video)/i;

/**
 * Recognise a backend family from what it serves without a token. The family picks a
 * quota adapter and an icon; it never decides whether the gateway can be used.
 *   - New API family: GET /api/status (system_name / quota_per_unit)
 *   - CLIProxyAPI:    GET / answers {"message":"CLI Proxy API Server", endpoints:[…]}
 */
function familyOf(status, rootDoc) {
  const name = String(status?.system_name ?? '');
  if (/new\s*api|one\s*api|done\s*hub|one\s*hub|veloera|voapi/i.test(name)) return { family: 'new-api', name, evidence: `system_name "${name}"` };
  if (status && typeof status.quota_per_unit === 'number') return { family: 'new-api', name: name || null, evidence: 'quota_per_unit on /api/status' };
  const banner = typeof rootDoc?.message === 'string' ? rootDoc.message : '';
  if (/cli\s*proxy/i.test(banner)) return { family: 'cliproxy', name: 'CLIProxyAPI', evidence: `GET / "${banner.slice(0, 60)}"` };
  return { family: 'unknown', name: name || null, evidence: 'no known management endpoint' };
}

/** Public facts worth showing about a recognised backend; never anything tied to a user. */
function publicInfoOf(family, status, rootDoc) {
  if (family === 'new-api' && status) {
    const info = {};
    if (typeof status.quota_display_type === 'string') info.currency = status.quota_display_type;
    if (Number(status.start_time) > 0) info.startedAt = Number(status.start_time) * (Number(status.start_time) < 1e12 ? 1000 : 1);
    if (typeof status.docs_link === 'string' && /^https?:\/\//.test(status.docs_link)) info.docs = status.docs_link.slice(0, 300);
    if (typeof status.self_use_mode_enabled === 'boolean') info.selfUse = status.self_use_mode_enabled;
    if (typeof status.enable_drawing === 'boolean') info.drawing = status.enable_drawing;
    if (typeof status.enable_task === 'boolean') info.tasks = status.enable_task;
    return info;
  }
  if (family === 'cliproxy' && Array.isArray(rootDoc?.endpoints)) {
    return { endpoints: rootDoc.endpoints.filter((e) => typeof e === 'string').slice(0, 12).map((e) => e.slice(0, 80)) };
  }
  return {};
}

/**
 * Probe one gateway.
 * @returns a JSON-safe report; `usable` is the single yes/no that matters.
 */
export async function probe({ baseURL, apiKey, headers = {}, signal, fetchImpl = fetch }) {
  const root = gatewayRoot(baseURL);
  const started = Date.now();
  const report = {
    root,
    usable: false,
    models: null,
    protocols: {},
    backend: null,
    quota: null,
    quotaAttempts: [],
    media: { imageModels: [], videoModels: [] },
    // Locale-free codes: protocol-unreported, models-failed, no-token.
    notes: [],
  };

  // Required: the model list, and the token at the same time.
  const models = await get(`${root}/v1/models`, { apiKey, headers, signal, fetchImpl });
  const list = Array.isArray(models.json?.data) ? models.json.data.filter((m) => m && typeof m.id === 'string') : null;
  if (models.ok && list) {
    report.usable = true;
    report.models = { count: list.length, ms: models.ms, sample: list.slice(0, 12).map((m) => m.id) };
    report.protocols = protocolsOf(list);
    report.media.imageModels = list.map((m) => m.id).filter((id) => IMAGE_ID.test(id)).slice(0, 20);
    report.media.videoModels = list.map((m) => m.id).filter((id) => VIDEO_ID.test(id)).slice(0, 20);
    if (report.protocols.unreported) report.notes.push('protocol-unreported');
  } else {
    report.models = { error: reason(models), code: codeOf(models), status: models.status };
    report.notes.push(apiKey ? 'models-failed' : 'no-token');
  }

  // Optional: who is this. Unauthenticated on purpose, like the gateway's own login page.
  const statusRes = await get(`${root}/api/status`, { headers, signal, fetchImpl });
  const status = statusRes.ok && statusRes.json ? (statusRes.json.data ?? statusRes.json) : undefined;
  let rootDoc;
  if (!status) {
    const rootRes = await get(`${root}/`, { headers, signal, fetchImpl });
    rootDoc = rootRes.ok && rootRes.json && typeof rootRes.json === 'object' ? rootRes.json : undefined;
  }
  const family = familyOf(status, rootDoc);
  const site = await readSite({ baseURL: root, headers, signal, fetchImpl }).catch(() => ({}));
  report.backend = {
    ...family,
    version: status?.version ?? null,
    info: publicInfoOf(family.family, status, rootDoc),
    ...(site.title ? { title: site.title } : {}),
    ...(site.icon ? { icon: site.icon } : {}),
    // What the add dialog pre-fills: the site's own name, else the backend's, else the host.
    suggestedName: suggestedNameOf(site.title, family.name, root),
  };

  // Optional: quota. Adapters run in order; the first that answers wins.
  // Without a token nothing is checked: that is reported as skipped, not as "none".
  report.quotaChecked = Boolean(apiKey);
  if (apiKey) {
    const context = { root, apiKey, headers, status, signal, fetchImpl, family: report.backend.family };
    for (const adapter of QUOTA_ADAPTERS) {
      if (!adapter.applies(context)) continue;
      const result = await adapter.read(context);
      report.quotaAttempts.push({ kind: adapter.kind, ok: result.ok, status: result.status ?? 200, code: result.ok ? null : result.code, error: result.ok ? null : result.error });
      if (result.ok) {
        report.quota = { kind: adapter.kind, label: adapter.label, ...result.quota };
        if (adapter.kind === 'litellm' && report.backend.family === 'unknown') {
          Object.assign(report.backend, { family: 'litellm', name: 'LiteLLM', evidence: 'GET /key/info answered' });
        }
        break;
      }
    }
  }

  report.ms = Date.now() - started;
  return report;
}
