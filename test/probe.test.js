/**
 * Probe behaviour against local fake gateways, one per backend family.
 * Every fake speaks only what its real counterpart serves, with response shapes
 * taken from the projects' own source (New API controller/billing.go and
 * controller/token.go, LiteLLM key_management_endpoints.py `info_key_fn`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probe, gatewayRoot } from '../lib/probe.js';

const KEY = 'sk-test-0123456789abcdefghij';

/** Start a fake gateway; `routes` maps "METHOD /path" to (req) => [status, body, headers?]. */
async function fakeGateway(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    seen.push({ path, auth: req.headers.authorization ?? null, query: new URL(req.url, 'http://x').search });
    const route = routes[`${req.method} ${path}`];
    if (!route) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"message":"not found"}}'); return; }
    const [status, body, headers = {}] = route(req);
    const isText = typeof body === 'string';
    res.writeHead(status, { 'content-type': isText ? 'text/html' : 'application/json', ...headers });
    res.end(isText ? body : JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const authed = (fn) => (req) => (req.headers.authorization === `Bearer ${KEY}` ? fn(req) : [401, { error: { message: 'Invalid token' } }]);
const models = (list) => authed(() => [200, { object: 'list', data: list }]);

test('New API: recognised by /api/status, quota converted with the site display rules', async () => {
  const gw = await fakeGateway({
    'GET /v1/models': models([
      { id: 'gpt-6-sol', supported_endpoint_types: ['openai', 'openai-response'] },
      { id: 'claude-opus-5-5', supported_endpoint_types: ['anthropic', 'openai'] },
      { id: 'gpt-image-2', supported_endpoint_types: ['image-generation'] },
    ]),
    'GET /api/status': () => [200, { success: true, data: { system_name: 'New API', version: 'v1.0.0-rc.45', quota_per_unit: 500000, quota_display_type: 'USD' } }],
    'GET /api/usage/token/': authed(() => [200, { code: true, data: { name: 'dev', total_granted: 5_000_000, total_used: 1_000_000, total_available: 4_000_000, unlimited_quota: false } }]),
  });
  try {
    const r = await probe({ baseURL: `${gw.base}/v1`, apiKey: KEY });
    assert.equal(r.usable, true);
    assert.equal(r.models.count, 3);
    assert.equal(r.backend.family, 'new-api');
    assert.equal(r.backend.version, 'v1.0.0-rc.45');
    assert.deepEqual(r.quota, { kind: 'new-api', label: 'New API token quota', unit: 'USD', unlimited: false, remaining: 8, used: 2, limit: 10, account: null });
    assert.deepEqual(r.media.imageModels, ['gpt-image-2']);
    assert.equal(r.protocols.openai, 2);
    // A recognised New API never gets probed with other backends' routes.
    assert.deepEqual(r.quotaAttempts.map((a) => a.kind), ['new-api']);
  } finally { await gw.close(); }
});

test('New API unlimited token: no remaining value, flagged unlimited', async () => {
  const gw = await fakeGateway({
    'GET /v1/models': models([{ id: 'm' }]),
    'GET /api/status': () => [200, { data: { system_name: 'New API', quota_per_unit: 500000 } }],
    // Same shape as the real local gateway: unlimited token, account quota exposed.
    'GET /api/usage/token/': authed(() => [200, { code: true, data: { total_granted: 0, total_used: 250000, total_available: 0, unlimited_quota: true, user_quota: { total_available: 5_000_000, total_used: 250000 } } }]),
  });
  try {
    const r = await probe({ baseURL: gw.base, apiKey: KEY });
    assert.equal(r.quota.unlimited, true);
    assert.equal(r.quota.remaining, null);
    assert.equal(r.quota.used, 0.5);
    assert.deepEqual(r.quota.account, { remaining: 10, used: 0.5 });
  } finally { await gw.close(); }
});

test('LiteLLM: /key/info budget, key sent only in the header, never in the URL', async () => {
  const gw = await fakeGateway({
    'GET /v1/models': models([{ id: 'gpt-4o' }, { id: 'claude-sonnet' }]),
    'GET /key/info': authed(() => [200, { key: 'hashed', info: { spend: 2.5, max_budget: 10, budget_reset_at: '2026-11-01T00:00:00Z' } }]),
  });
  try {
    const r = await probe({ baseURL: gw.base, apiKey: KEY });
    assert.equal(r.backend.family, 'unknown');
    assert.equal(r.quota.kind, 'litellm');
    assert.equal(r.quota.remaining, 7.5);
    assert.equal(r.quota.used, 2.5);
    assert.equal(r.quota.limit, 10);
    for (const hit of gw.seen) assert.equal(hit.query, '', `${hit.path} carried a query string`);
  } finally { await gw.close(); }
});

test('one-api family without /api/status: falls back to the OpenAI-style billing routes', async () => {
  const gw = await fakeGateway({
    'GET /v1/models': models([{ id: 'deepseek-chat' }]),
    'GET /v1/dashboard/billing/subscription': authed(() => [200, { object: 'billing_subscription', hard_limit_usd: 20, soft_limit_usd: 20 }]),
    'GET /v1/dashboard/billing/usage': authed(() => [200, { object: 'list', total_usage: 550 }]),
  });
  try {
    const r = await probe({ baseURL: gw.base, apiKey: KEY });
    assert.equal(r.quota.kind, 'openai-billing');
    assert.equal(r.quota.used, 5.5, 'total_usage is in cents');
    assert.equal(r.quota.remaining, 14.5);
  } finally { await gw.close(); }
});

test('plain OpenAI-compatible relay with no quota API: usable, quota hidden, no error state', async () => {
  const gw = await fakeGateway({
    'GET /v1/models': models([{ id: 'grok-4' }, { id: 'grok-imagine-video' }]),
    // A SPA that answers every unknown path with its index page must not count as an API.
    'GET /key/info': () => [200, '<!doctype html><html></html>'],
    'GET /api/status': () => [200, '<!doctype html><html></html>'],
  });
  try {
    const r = await probe({ baseURL: gw.base, apiKey: KEY });
    assert.equal(r.usable, true);
    assert.equal(r.quota, null);
    assert.equal(r.backend.family, 'unknown');
    assert.equal(r.protocols.unreported, 2);
    assert.deepEqual(r.media.videoModels, ['grok-imagine-video']);
    assert.ok(r.quotaAttempts.every((a) => !a.ok));
    assert.equal(r.quotaChecked, true);
    assert.equal(r.quotaAttempts.find((a) => a.kind === 'litellm').code, 'html');
    assert.ok(r.notes.includes('protocol-unreported'));
  } finally { await gw.close(); }
});

test('wrong token: not usable, reason given, token never echoed', async () => {
  const gw = await fakeGateway({
    'GET /v1/models': (req) => [401, { error: { message: `Invalid token ${req.headers.authorization}` } }],
  });
  try {
    const r = await probe({ baseURL: gw.base, apiKey: KEY });
    assert.equal(r.usable, false);
    assert.equal(r.models.code, 'unauthorized');
    assert.ok(r.notes.includes('models-failed'));
    assert.ok(!JSON.stringify(r).includes(KEY), 'token leaked into the report');
  } finally { await gw.close(); }
});

test('a redirect is not followed, so the token cannot reach another host', async () => {
  const other = await fakeGateway({ 'GET /v1/models': () => [200, { data: [{ id: 'stolen' }] }] });
  const gw = await fakeGateway({ 'GET /v1/models': () => [302, {}, { location: `${other.base}/v1/models` }] });
  try {
    const r = await probe({ baseURL: gw.base, apiKey: KEY });
    assert.equal(r.usable, false);
    assert.equal(r.models.code, 'redirect');
    assert.equal(other.seen.length, 0, 'the second host received a request');
  } finally { await gw.close(); await other.close(); }
});

test('unreachable host: a clear reason, no throw', async () => {
  const r = await probe({ baseURL: 'http://127.0.0.1:1', apiKey: KEY });
  assert.equal(r.usable, false);
  assert.equal(r.models.code, 'network');
  assert.equal(r.quota, null);
});

test('no token: quota is reported as not checked, not as missing', async () => {
  const gw = await fakeGateway({
    'GET /v1/models': models([{ id: 'm' }]),
    'GET /api/status': () => [200, { data: { system_name: 'New API', version: 'v1' } }],
  });
  try {
    const r = await probe({ baseURL: gw.base });
    assert.equal(r.quotaChecked, false);
    assert.deepEqual(r.quotaAttempts, []);
    assert.equal(r.backend.family, 'new-api', 'the public part is still identified');
    assert.ok(r.notes.includes('no-token'));
    assert.ok(gw.seen.every((hit) => hit.auth === null), 'a request carried credentials');
  } finally { await gw.close(); }
});

test('addresses: /v1 and trailing slashes fold to the site root; credentials in the URL are refused', () => {
  assert.equal(gatewayRoot('https://gw.example.com/v1/'), 'https://gw.example.com');
  assert.equal(gatewayRoot('https://gw.example.com/relay/v1'), 'https://gw.example.com/relay');
  assert.throws(() => gatewayRoot('https://user:pass@gw.example.com'), /token/);
  assert.throws(() => gatewayRoot('ftp://gw.example.com'), /http/);
});
