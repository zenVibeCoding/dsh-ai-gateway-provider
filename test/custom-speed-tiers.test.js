import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-custom-speed-'));
const { mergeModelOverride, ChannelService } = await import('../lib/channels.js');
const { Catalog } = await import('../lib/catalog.js');
const { SessionTiers } = await import('../lib/session-tiers.js');
const { ModelTester } = await import('../lib/model-test.js');
const { SERVICE_TIERS, advertisedServiceTiers, assertServiceTier, serviceTierError, composerSpeedTiers, withModelPayload, tierOutcome, speedTiersFor } = await import('../lib/service-tiers.js');
const target = 'gpt-custom';
const wire = 'Gateway/Flex v2';
const makeEntry = (extra = {}) => ({ id: target, upstreamModel: target, kind: 'chat', endpointTypes: ['openai'], speedEnabled: true, serviceTier: 'turbo', serviceTierMap: { turbo: wire }, allowedServiceTiers: ['default', 'turbo'], speedTiers: { compatible: true, source: 'unknown', tiers: [] }, ...extra });

test('map validation: 32+ ids, wire grammar, reserved ids, patch deletion and presets', () => {
  assert.deepEqual(SERVICE_TIERS, ['default', 'priority', 'ultrafast']);
  const map = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`tier_${i}`, `wire/${i}`]));
  assert.deepEqual(mergeModelOverride({}, { serviceTierMap: map, allowedServiceTiers: Object.keys(map), serviceTier: 'tier_31' }).serviceTierMap, map);
  for (const id of ['constructor', 'prototype', '__proto__', 'A', '0abc', 'a'.repeat(33)]) {
    assert.throws(() => mergeModelOverride({}, { serviceTierMap: JSON.parse(JSON.stringify({ [id]: 'x' })) }), /invalid/);
  }
  for (const value of ['', '   ', 'x'.repeat(129), 'bad\nwire', 'bad\u0085wire', null, 3]) assert.throws(() => mergeModelOverride({}, { serviceTierMap: { turbo: value } }), /invalid/);
  assert.throws(() => mergeModelOverride({}, { serviceTierMap: [] }), /invalid/);
  assert.equal(mergeModelOverride({ serviceTierMap: map }, { serviceTierMap: null }), undefined);
  assert.equal(assertServiceTier(makeEntry({ serviceTier: 'priority', serviceTierMap: { priority: wire }, allowedServiceTiers: ['priority'] }), 'responses'), wire);
  assert.equal(assertServiceTier({ serviceTier: 'priority' }, 'openai'), 'priority');
  assert.equal(speedTiersFor({}, 'default', 'openai', 'chat', { default: 'custom-lane' }).selectionSource, 'manual');
  assert.equal(speedTiersFor({ service_tiers: ['priority'] }, 'default', 'openai', 'chat', { default: 'priority' }).selectionSource, 'declared');
});

test('CAS saves custom maps, stale writes and invalid maps leave state intact', async () => {
  let state = { channels: [{ id: 'c', baseURL: 'https://offline.invalid', models: {} }], activeChannel: 'c' }, revision = 1;
  const host = { ns: 'gateway', current: () => state, settings: () => ({ describe: () => [{ ns: 'gateway', revision }], mutate: async (_, ops, expected) => { assert.equal(expected, revision); for (const op of ops) state[op.path[0]] = structuredClone(op.value); revision++; } }) };
  const service = new ChannelService(host);
  const args = { channelId: 'c', modelId: target, override: { serviceTierMap: { turbo: wire }, allowedServiceTiers: ['turbo'], serviceTier: 'turbo' } };
  await service.run('model_override', { ...args, revision: 1 });
  assert.equal(state.channels[0].models[target].serviceTierMap.turbo, wire);
  await assert.rejects(service.run('model_override', { ...args, revision: 1 }), { status: 409 });
  await assert.rejects(service.run('model_override', { ...args, revision: 2, override: { serviceTierMap: { turbo: '\u0000' } } }), { status: 400 });
  assert.equal(revision, 2);
});

test('gateway future declarations stay conservative and supplemental fields remain ignored', () => {
  assert.deepEqual(advertisedServiceTiers({ service_tiers: ['flex', 'auto', 'scale', { id: 'future_mode' }] }), { source: 'gateway', tiers: ['flex', 'auto', 'scale', 'future_mode'] });
  for (const bad of ['constructor', 'prototype', '__proto__', 'Upper', 'bad/name']) assert.equal(advertisedServiceTiers({ service_tiers: [bad] }).source, 'unknown');
  assert.deepEqual(advertisedServiceTiers({ additional_speed_tiers: ['flex'] }), { source: 'unknown', tiers: [] });
  assert.deepEqual(advertisedServiceTiers({ service_tiers: [], additional_speed_tiers: ['flex'] }), { source: 'gateway', tiers: [] });
});

test('catalog retains declarations, map metadata and exact mapped-target identity without name inference', () => {
  const catalog = new Catalog({ modelsDev: { match: () => undefined } });
  const entries = catalog.build({ overrides: { alias: { custom: true, upstreamModel: target, serviceTierMap: { turbo: 'flex', priority: 'special' }, serviceTier: 'turbo' } } }, { models: { data: [{ id: target, service_tiers: ['flex'] }, { id: 'gpt-fast' }] } }).entries;
  const alias = entries.find((e) => e.id === 'alias');
  assert.equal(alias.serviceTierMap.turbo, 'flex');
  assert.equal(alias.speedTiers.selectionSource, 'declared');
  assert.ok(alias.source.overridden.includes('serviceTierMap'));
  assert.deepEqual(alias.speedTiers.tiers, ['flex']);
  assert.deepEqual(composerSpeedTiers(alias).find((t) => t.tier === 'turbo'), { tier: 'turbo', wireValue: 'flex', evidence: 'declared' });
  assert.equal(entries.find((e) => e.id === 'gpt-fast').speedEnabled, false);
});

test('composer enumerates allowed local ids and distinguishes manual/declaration/current-wire verification', () => {
  const entry = makeEntry();
  assert.deepEqual(composerSpeedTiers(entry), [{ tier: 'turbo', wireValue: wire, evidence: 'manual' }]);
  const last = { ok: true, upstreamModel: target, tierOutcome: 'verified', requestedServiceTier: wire, returnedServiceTier: wire };
  assert.equal(composerSpeedTiers(entry, last)[0].evidence, 'verified');
  for (const changed of [{ upstreamModel: 'gpt-other' }, { ok: false }, { returnedServiceTier: 'default' }]) assert.equal(composerSpeedTiers(entry, { ...last, ...changed })[0].evidence, 'manual');
  assert.equal(composerSpeedTiers(makeEntry({ serviceTierMap: { turbo: 'new-wire' } }), last)[0].evidence, 'manual');
  assert.equal(composerSpeedTiers(makeEntry({ serviceTierMap: { turbo: 'flex' }, speedTiers: { compatible: true, source: 'gateway', tiers: ['flex'] } }))[0].evidence, 'declared');
  assert.equal(composerSpeedTiers(makeEntry({ allowedServiceTiers: ['default'] })).length, 0);
  assert.equal(composerSpeedTiers(makeEntry({ upstreamModel: 'claude-test' })).length, 0);
  assert.equal(composerSpeedTiers(makeEntry({ speedEnabled: false })).length, 0);
  assert.match(serviceTierError(entry, 'anthropic'), /OpenAI/);
  assert.match(serviceTierError(makeEntry({ allowedServiceTiers: ['default'] }), 'openai'), /disabled/);
  assert.match(serviceTierError(makeEntry({ serviceTierMap: {} }), 'openai'), /unconfigured/);
});

test('session custom ids survive persistence, invalid ids do not', () => {
  const sessions = new SessionTiers();
  sessions.set('s', 'c', target, 'turbo');
  assert.equal(new SessionTiers().get('s', 'c', target), 'turbo');
  assert.equal(sessions.get('s', 'other', target), undefined);
  for (const id of ['constructor', '__proto__', 'prototype', 'bad/name']) assert.throws(() => sessions.set('s', 'c', target, id), /invalid/);
  sessions.set('s', 'c', target, null);
  assert.equal(new SessionTiers().get('s', 'c', target), undefined);
});

test('OpenAI and Responses final payload uses wire map, including mapped default; off strips caller injection', async () => {
  for (const protocol of ['openai', 'openai-response']) {
    for (const method of ['stream', 'streamSimple']) {
      let options;
      const api = { [method]: (_, __, opts) => { options = opts; } };
      const entry = makeEntry({ serviceTierMap: { turbo: wire, default: 'standard/wire' } });
      const entries = new Map([[target, entry]]);
      const run = async (choice, patch = {}) => {
        Object.assign(entry, patch);
        const wrapped = withModelPayload(api, new Map([[target, target]]), entries, protocol, () => choice);
        wrapped[method]({ id: target }, {}, { sessionId: 's', onPayload: () => ({ model: target, service_tier: 'injected' }) });
        return options.onPayload({});
      };
      assert.equal((await run('turbo')).service_tier, wire);
      assert.equal((await run('default')).service_tier, 'standard/wire');
      assert.equal((await run('turbo', { allowedServiceTiers: ['default'], serviceTier: 'default' })).service_tier, 'standard/wire');
      assert.equal(Object.hasOwn(await run('turbo', { speedEnabled: false }), 'service_tier'), false);
    }
  }
});

test('offline custom SSE echoes compare requested wire, including Responses, downgrade and disabled', async (t) => {
  for (const protocol of ['openai', 'openai-response']) {
    let entry = makeEntry({ endpointTypes: [protocol] }), returned = wire, sent;
    t.mock.method(globalThis, 'fetch', async (_, init) => {
      sent = JSON.parse(init.body);
      const data = protocol === 'openai' ? { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }], service_tier: returned } : { type: 'response.completed', response: { status: 'completed', service_tier: returned } };
      return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    const tester = new ModelTester({ channelFacts: async () => ({ baseURL: 'https://offline.invalid', apiKey: async () => 'fixture-key', entryFor: async () => entry }) });
    const run = () => tester.run({ channelId: 'custom-c', modelId: target });
    const result = await run();
    assert.equal(sent.service_tier, wire);
    assert.equal(result.requestedServiceTier, wire);
    assert.equal(result.returnedServiceTier, wire);
    assert.equal(result.tierOutcome, 'verified');
    returned = 'default';
    assert.equal((await run()).tierOutcome, 'downgraded');
    entry = { ...entry, speedEnabled: false };
    assert.equal((await run()).requestedServiceTier, null);
    assert.equal(Object.hasOwn(sent, 'service_tier'), false);
    t.mock.restoreAll();
  }
  assert.equal(tierOutcome(wire, wire), 'verified');
  assert.equal(tierOutcome(wire, undefined), 'unconfirmed');
  assert.equal(tierOutcome('fast', 'priority'), 'verified');
  assert.equal(tierOutcome('priority', 'fast'), 'verified');
});

 test('session options classify mapped default by wire and include it once only when allowed', () => {
  const mapped = makeEntry({ serviceTierMap: { default: 'priority', turbo: wire } });
  const standard = composerSpeedTiers(makeEntry(), undefined, true).filter((o) => o.tier === 'default');
  assert.deepEqual(standard, [{ tier: 'default', wireValue: 'default', evidence: 'standard' }]);
  assert.equal(composerSpeedTiers(mapped, undefined, true).find((o) => o.tier === 'default').evidence, 'manual');
  mapped.speedTiers = { compatible: true, source: 'gateway', tiers: ['priority'] };
  assert.equal(composerSpeedTiers(mapped, undefined, true).find((o) => o.tier === 'default').evidence, 'declared');
  const last = { ok: true, upstreamModel: target, requestedServiceTier: 'priority', returnedServiceTier: 'priority', tierOutcome: 'verified' };
  assert.equal(composerSpeedTiers(mapped, last, true).find((o) => o.tier === 'default').evidence, 'verified');
  mapped.allowedServiceTiers = ['turbo'];
  assert.equal(composerSpeedTiers(mapped, last, true).some((o) => o.tier === 'default'), false);
});
