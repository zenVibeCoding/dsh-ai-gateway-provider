/**
 * The save path: a gateway is written only after it lists its models, the token goes
 * to the credential store (never the config), and failures leave nothing behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ChannelService, resolveChannels, keyNameFor, backendOf } from '../lib/channels.js';
import { probe, readQuota } from '../lib/probe.js';

const KEY = 'sk-good-0123456789abcdefghij';

async function gateway({ quota = true } = {}) {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const ok = req.headers.authorization === `Bearer ${KEY}`;
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (path === '/v1/models') return ok ? json(200, { data: [{ id: 'gpt-6-sol' }, { id: 'claude-opus-5-5' }] }) : json(401, { error: { message: 'Invalid token' } });
    if (path === '/api/status') return json(200, { data: { system_name: 'New API', version: 'v1.0.0', quota_per_unit: 500000 } });
    if (path === '/api/usage/token/' && quota) return ok ? json(200, { code: true, data: { total_granted: 1_000_000, total_used: 250_000, total_available: 750_000, unlimited_quota: false } }) : json(401, {});
    return json(404, { error: { message: 'not found' } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** In-memory DSH settings + credentials with the same revision and CAS rules. */
function host(initial = {}) {
  let value = structuredClone(initial);
  let revision = 1;
  const store = new Map();
  const settings = {
    describe: () => [{ ns: 'ai-gateway', revision, value }],
    async mutate(ns, ops, expected) {
      if (expected !== revision) throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' });
      const next = structuredClone(value);
      for (const op of ops) {
        if (op.op === 'set') next[op.path[0]] = structuredClone(op.value);
        else delete next[op.path[0]];
      }
      value = next;
      revision++;
    },
  };
  const service = new ChannelService({
    ns: 'ai-gateway',
    current: () => value,
    settings: () => settings,
    keyFor: async (ch) => { const v = store.get(ch.apiKeyEnv); if (!v) throw new Error('missing'); return v; },
    probe: (args) => probe(args),
    storeKey: async (name, v) => { store.set(name, v); },
    unsetKey: async (name) => { store.delete(name); },
  });
  return { service, store, get value() { return value; }, get revision() { return revision; } };
}

test('saving a working gateway stores the token in credentials, and its findings in config', async () => {
  const gw = await gateway();
  const h = host();
  try {
    const r = await h.service.run('save', { revision: h.revision, name: 'Main', baseURL: `${gw.base}/v1`, apiKey: KEY });
    assert.equal(r.ok, true);
    const { list, active } = resolveChannels(h.value);
    assert.equal(list.length, 1);
    assert.equal(active.id, r.channelId, 'the first gateway becomes active');
    assert.equal(list[0].baseURL, gw.base, '/v1 folds to the site root');
    assert.equal(list[0].backend.family, 'new-api');
    assert.equal(list[0].backend.quotaKind, 'new-api');
    assert.equal(list[0].backend.modelCount, 2);
    assert.ok(!JSON.stringify(h.value).includes(KEY), 'the token leaked into config');
    assert.equal(h.store.get(list[0].apiKeyEnv), KEY);
    assert.ok(list[0].apiKeyEnv.startsWith(keyNameFor(list[0].id)));
  } finally { await gw.close(); }
});

test('a gateway that does not list its models is refused, and nothing is written', async () => {
  const gw = await gateway();
  const h = host();
  try {
    await assert.rejects(h.service.run('save', { revision: h.revision, baseURL: gw.base, apiKey: 'sk-wrong-0123456789abcdef' }), (e) => e.status === 400 && e.code === 'unauthorized');
    assert.deepEqual(resolveChannels(h.value).list, []);
    assert.equal(h.store.size, 0, 'a refused token stayed in the credential store');
  } finally { await gw.close(); }
});

test('a new gateway needs a token; editing keeps the old one unless the address changes', async () => {
  const gw = await gateway();
  const h = host();
  try {
    await assert.rejects(h.service.run('save', { revision: h.revision, baseURL: gw.base }), (e) => e.code === 'key-required');
    const first = await h.service.run('save', { revision: h.revision, name: 'A', baseURL: gw.base, apiKey: KEY });
    // Rename only: no token needed, the saved one is reused for the check.
    await h.service.run('save', { revision: h.revision, id: first.channelId, name: 'Renamed', baseURL: gw.base });
    assert.equal(resolveChannels(h.value).list[0].name, 'Renamed');
    // New address without a token: refused, so the saved token never reaches another host.
    await assert.rejects(h.service.run('save', { revision: h.revision, id: first.channelId, baseURL: 'http://127.0.0.1:9' }), (e) => e.code === 'key-required');
    await assert.rejects(h.service.check({ id: first.channelId, baseURL: 'http://127.0.0.1:9' }), (e) => e.code === 'key-required');
  } finally { await gw.close(); }
});

test('replacing a token removes the old one only after the write lands', async () => {
  const gw = await gateway();
  const h = host();
  try {
    const first = await h.service.run('save', { revision: h.revision, baseURL: gw.base, apiKey: KEY });
    const oldRef = resolveChannels(h.value).list[0].apiKeyEnv;
    await h.service.run('save', { revision: h.revision, id: first.channelId, baseURL: gw.base, apiKey: KEY });
    const newRef = resolveChannels(h.value).list[0].apiKeyEnv;
    assert.notEqual(newRef, oldRef);
    assert.equal(h.store.has(oldRef), false);
    assert.equal(h.store.get(newRef), KEY);
  } finally { await gw.close(); }
});

test('a stale revision is rejected before any request or write', async () => {
  const gw = await gateway();
  const h = host();
  try {
    await assert.rejects(h.service.run('save', { revision: h.revision + 5, baseURL: gw.base, apiKey: KEY }), (e) => e.status === 409);
    assert.equal(h.store.size, 0);
  } finally { await gw.close(); }
});

test('activate and delete; deleting the last gateway leaves an empty, valid config', async () => {
  const gw = await gateway();
  const h = host();
  try {
    const a = await h.service.run('save', { revision: h.revision, name: 'A', baseURL: gw.base, apiKey: KEY });
    const b = await h.service.run('save', { revision: h.revision, name: 'B', baseURL: `${gw.base}/`, apiKey: KEY });
    assert.equal(resolveChannels(h.value).active.id, a.channelId, 'a second gateway does not steal the active slot');
    await h.service.run('activate', { revision: h.revision, id: b.channelId });
    assert.equal(resolveChannels(h.value).active.id, b.channelId);
    await h.service.run('delete', { revision: h.revision, id: b.channelId });
    assert.equal(resolveChannels(h.value).active.id, a.channelId, 'the remaining gateway takes over');
    await h.service.run('delete', { revision: h.revision, id: a.channelId });
    const { list, active } = resolveChannels(h.value);
    assert.deepEqual(list, []);
    assert.equal(active, undefined);
    assert.equal(h.value.activeChannel, undefined);
    assert.equal(h.store.size, 0, 'deleted gateways left tokens behind');
  } finally { await gw.close(); }
});

test('a saved gateway reads quota with the adapter its probe found', async () => {
  const gw = await gateway();
  try {
    const r = await readQuota({ baseURL: gw.base, apiKey: KEY, kind: 'new-api' });
    assert.equal(r.ok, true);
    assert.equal(r.quota.remaining, 1.5);
    assert.equal(r.quota.used, 0.5);
    const none = await readQuota({ baseURL: gw.base, apiKey: KEY, kind: 'litellm' });
    assert.equal(none.ok, false);
  } finally { await gw.close(); }
});

test('backend findings omit absent fields instead of writing nulls', () => {
  const b = backendOf({ backend: { family: 'unknown' }, models: { count: 3 } });
  assert.deepEqual(Object.keys(b).sort(), ['checkedAt', 'family', 'modelCount']);
});

test('picking models: a list narrows the picker, "all" removes the list, bad input is refused', async () => {
  const gw = await gateway();
  const h = host();
  try {
    const { channelId } = await h.service.run('save', { revision: h.revision, baseURL: gw.base, apiKey: KEY });
    assert.equal(resolveChannels(h.value).list[0].enabledModels, undefined, 'a new gateway offers every model');

    await h.service.run('models', { revision: h.revision, id: channelId, mode: 'list', models: ['gpt-6-sol', ' gpt-6-sol ', 'claude-opus-5-5'] });
    assert.deepEqual(resolveChannels(h.value).list[0].enabledModels, ['gpt-6-sol', 'claude-opus-5-5'], 'trimmed and de-duplicated, order kept');

    await assert.rejects(h.service.run('models', { revision: h.revision, id: channelId, mode: 'list', models: [] }), (e) => e.code === 'empty-models');
    await assert.rejects(h.service.run('models', { revision: h.revision, id: channelId, mode: 'list', models: ['__proto__'] }), (e) => e.status === 400);
    await assert.rejects(h.service.run('models', { revision: h.revision, id: channelId, mode: 'some' }), (e) => e.status === 400);

    await h.service.run('models', { revision: h.revision, id: channelId, mode: 'all' });
    assert.equal('enabledModels' in h.value.channels[0], false, '"all" removes the field instead of storing an empty list');
  } finally { await gw.close(); }
});

test('editing the gateway keeps its model selection', async () => {
  const gw = await gateway();
  const h = host();
  try {
    const { channelId } = await h.service.run('save', { revision: h.revision, baseURL: gw.base, apiKey: KEY });
    await h.service.run('models', { revision: h.revision, id: channelId, mode: 'list', models: ['gpt-6-sol'] });
    await h.service.run('save', { revision: h.revision, id: channelId, name: 'Renamed', baseURL: gw.base });
    assert.deepEqual(resolveChannels(h.value).list[0].enabledModels, ['gpt-6-sol']);
  } finally { await gw.close(); }
});
