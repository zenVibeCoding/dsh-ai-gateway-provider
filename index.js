/**
 * AI Gateway (dsh-ai-gateway-provider) — preview skeleton.
 *
 * This first version only serves the settings page and the gateway probe; it does
 * not register a model route yet, so it cannot affect conversations. The probe runs
 * on the Host, not in the browser, because most gateways do not allow cross-origin
 * calls and the token must not travel through page scripts more than necessary.
 *
 * Routes (all under the plugin's own prefix, guarded by the Web UI's session check):
 *   GET  /ai-gateway/api/info   → version and what this build can do
 *   POST /ai-gateway/api/probe  → { baseURL, apiKey? } → probe report
 * The token sent to /probe is used for that request only: never stored, logged or
 * echoed back.
 */
import { probe, gatewayRoot, redact } from './lib/probe.js';

const ROUTE_PREFIX = '/ai-gateway/api/';
const VERSION = '0.1.0';
const MAX_BODY_BYTES = 16 * 1024;

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

export function apply(ctx) {
  // The page is drawn by client.js; this plugin has no generated settings form.
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber));
  });

  // One probe per address at a time: a double click must not double the traffic.
  const inflight = new Map();

  const routes = {
    'GET info': async () => ({ version: VERSION, stage: 'preview', capabilities: ['probe'] }),
    'POST probe': async (body) => {
      const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : '';
      const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : undefined;
      if (!baseURL || baseURL.length > 2048) throw Object.assign(new Error('enter a gateway address'), { status: 400 });
      if (apiKey && apiKey.length > 4096) throw Object.assign(new Error('token too long'), { status: 400 });
      let root;
      try { root = gatewayRoot(baseURL); } catch (error) { throw Object.assign(new Error(error.message), { status: 400 }); }
      const key = `${root}\u0000${apiKey ? 'k' : '-'}`;
      if (!inflight.has(key)) {
        inflight.set(key, probe({ baseURL: root, apiKey }).finally(() => inflight.delete(key)));
      }
      try {
        return await inflight.get(key);
      } catch (error) {
        throw Object.assign(new Error(redact(error?.message ?? error, apiKey)), { status: 502 });
      }
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
        if (!url.pathname.startsWith(ROUTE_PREFIX)) return sendJson(res, 404, { error: 'not found' });
        const route = routes[`${req.method} ${url.pathname.slice(ROUTE_PREFIX.length)}`];
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
          return sendJson(res, error?.status ?? 500, { error: String(error?.message ?? error) });
        }
      },
    }));
  });
}
