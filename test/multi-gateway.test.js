/**
 * Multi-gateway routing: every gateway is its own provider route, so the model picker
 * groups them and two gateways serving the same model id stay distinct. The first
 * gateway keeps the legacy route so sessions recorded before this existed keep working.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aig-routes-'));
const { assignRoutes, resolveChannels, ChannelService } = await import('../lib/channels.js');
const { Catalog } = await import('../lib/catalog.js');

const ch = (id, extra = {}) => ({ id, name: extra.name ?? id, baseURL: `https://${id}.example`, models: {}, headers: {}, ...extra });

test('routes: the first gateway keeps the legacy id, later gateways get their own', () => {
  const list = assignRoutes([ch('gw-a'), ch('gw-b'), ch('gw-c')], 'ai-gateway');
  assert.deepEqual(list.map((c) => c.providerId), ['ai-gateway', 'ai-gateway-gw-b', 'ai-gateway-gw-c']);
  assert.equal(assignRoutes([ch('gw-a')], undefined)[0].providerId, 'ai-gateway', 'no configured legacy id still yields the default route');
  assert.equal(assignRoutes([ch('gw-a')], 'custom-route')[0].providerId, 'custom-route');
});

test('routes: assignment is stable when the list order changes', () => {
  const once = assignRoutes([ch('gw-a'), ch('gw-b')], 'ai-gateway');
  const reordered = assignRoutes([...once].reverse(), 'ai-gateway');
  assert.deepEqual(reordered.map((c) => [c.id, c.providerId]).sort(), once.map((c) => [c.id, c.providerId]).sort());
});

test('routes: stored routes win, duplicates are repaired, unsafe ids fall back', () => {
  const list = assignRoutes([
    ch('gw-a', { providerId: 'mine' }),
    ch('gw-b', { providerId: 'mine' }),
    ch('gw-c', { providerId: 'bad route!' }),
  ], 'ai-gateway');
  assert.deepEqual(list.map((c) => c.providerId), ['mine', 'ai-gateway-gw-b', 'ai-gateway-gw-c']);
});

test('routes: hidden defaults to false and survives resolution', () => {
  const state = resolveChannels({ channels: [ch('gw-a'), ch('gw-b', { hidden: true })], providerId: 'ai-gateway' });
  assert.equal(state.list[0].hidden, false);
  assert.equal(state.list[1].hidden, true);
  assert.deepEqual(state.list.map((c) => c.providerId), ['ai-gateway', 'ai-gateway-gw-b']);
});

/** The same fake settings/credential host the channel tests use, trimmed to what routing needs. */
function host(initial = {}) {
  let value = structuredClone(initial);
  let revision = 1;
  const settings = {
    describe: () => [{ ns: 'ai-gateway', revision, value }],
    async mutate(ns, ops, expected) {
      if (expected !== revision) throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' });
      const next = structuredClone(value);
      for (const op of ops) { if (op.op === 'set') next[op.path[0]] = structuredClone(op.value); else delete next[op.path[0]]; }
      value = next; revision++;
    },
  };
  const service = new ChannelService({
    ns: 'ai-gateway', current: () => value, settings: () => settings,
    keyFor: async () => 'sk-test', keyConfigured: async () => true,
    probe: async () => ({ usable: true, root: 'https://gw.example', models: { count: 1 }, backend: { family: 'unknown' } }),
    storeKey: async () => {}, unsetKey: async () => {},
    gatewayModelIds: async () => ['gpt-6-sol'],
  });
  return { service, get value() { return value; } };
}

test('visibility: hiding persists, keeps the route, and un-hiding clears the flag', async () => {
  const h = host({ channels: [ch('gw-a'), ch('gw-b')], providerId: 'ai-gateway', activeChannel: 'gw-a' });
  const before = resolveChannels(h.value).list.map((c) => c.providerId);
  await h.service.run('visibility', { revision: 1, id: 'gw-b', hidden: true });
  const hidden = resolveChannels(h.value);
  assert.equal(hidden.list[1].hidden, true);
  assert.deepEqual(hidden.list.map((c) => c.providerId), before, 'the route is unchanged, so history still resolves');
  assert.equal(hidden.active.id, 'gw-a', 'hiding never changes the active gateway');
  await h.service.run('visibility', { revision: 2, id: 'gw-b', hidden: false });
  assert.equal(resolveChannels(h.value).list[1].hidden, false);
  assert.equal(h.value.channels[1].hidden, undefined, 'the flag is removed rather than stored as false');
  await assert.rejects(h.service.run('visibility', { revision: 3, id: 'gw-b', hidden: 'yes' }), { status: 400 });
});

test('deleting the legacy gateway keeps every remaining route stable', async () => {
  const h = host({ channels: [ch('gw-a'), ch('gw-b'), ch('gw-c')], providerId: 'ai-gateway', activeChannel: 'gw-a' });
  const before = new Map(resolveChannels(h.value).list.map((c) => [c.id, c.providerId]));
  await h.service.run('delete', { revision: 1, id: 'gw-a' });
  const after = resolveChannels(h.value).list;
  assert.deepEqual(after.map((c) => [c.id, c.providerId]), [['gw-b', before.get('gw-b')], ['gw-c', before.get('gw-c')]]);
  assert.equal(after.some((c) => c.providerId === 'ai-gateway'), false, 'the legacy route leaves with its gateway');
});

test('a legacy activeChannel value is ignored rather than honoured', () => {
  const state = resolveChannels({ channels: [ch('gw-a'), ch('gw-b')], providerId: 'ai-gateway', activeChannel: 'gw-b' });
  assert.equal(state.active.id, 'gw-a', 'no user-facing active state survives; the first gateway is only an internal fallback');
});

test('a new gateway gets its own route and never steals the legacy one', async () => {
  const h = host({ channels: [ch('gw-a')], providerId: 'ai-gateway' });
  const result = await h.service.run('save', { revision: 1, baseURL: 'https://gw-b.example', apiKey: 'sk-new', name: 'Second' });
  const list = resolveChannels(h.value).list;
  assert.equal(list.length, 2);
  assert.equal(list[0].providerId, 'ai-gateway');
  assert.match(list[1].providerId, /^ai-gateway-gw-/);
  assert.equal(h.value.activeChannel, undefined, 'saving never writes an active-channel state');
});

test('two gateways serving the same model id keep separate catalogs and identities', async () => {
  const modelsDev = { refresh: async () => {}, match: () => undefined };
  const catalogs = new Catalog({ modelsDev });
  const raw = (id) => ({ models: { data: [{ id }] } });
  const conn = (channelId, baseURL) => ({ channelId, baseURL, overrides: {}, enabledModels: undefined, overridesRev: channelId, headers: {}, defaultContextWindow: 1000, defaultMaxTokens: 100 });
  const a = catalogs.build(conn('gw-a', 'https://a.example'), raw('gpt-6-sol'));
  const b = catalogs.build(conn('gw-b', 'https://b.example'), raw('gpt-6-sol'));
  assert.equal(a.entries[0].id, b.entries[0].id, 'the same model id on both gateways');
  assert.equal(a.entries[0].upstreamModel, b.entries[0].upstreamModel);
  assert.notEqual(catalogs.key(conn('gw-a', 'https://a.example')), catalogs.key(conn('gw-b', 'https://b.example')), 'caches never merge two gateways');
});
