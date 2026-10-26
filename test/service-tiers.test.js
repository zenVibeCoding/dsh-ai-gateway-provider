/**
 * Speed tiers: what counts as a gateway declaration, how a saved tier reaches the wire,
 * and how one test decides whether the tier was really used. Offline only: fetch is mocked
 * and the key is fake, so nothing here can bill.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-tiers-'));
const { advertisedServiceTiers, speedTiersFor, serviceTierError, tierOutcome, withModelPayload } = await import('../lib/service-tiers.js');
const { Catalog } = await import('../lib/catalog.js');
const { LevelCatalog } = await import('../lib/levels.js');
const { ModelTester, requestFor } = await import('../lib/model-test.js');

test('declarations: plain ids, CLIProxyAPI objects and additional_speed_tiers all count', () => {
  assert.deepEqual(advertisedServiceTiers({ supported_service_tiers: ['default', 'priority', 'ultrafast'] }), { source: 'gateway', tiers: ['default', 'priority', 'ultrafast'] });
  // CLIProxyAPI's Codex catalog, verbatim shape.
  assert.deepEqual(advertisedServiceTiers({ service_tiers: [{ id: 'priority', name: 'Fast', description: '2x speed' }], additional_speed_tiers: ['fast'] }), { source: 'gateway', tiers: ['priority'] });
  assert.deepEqual(advertisedServiceTiers({ additional_speed_tiers: ['fast'] }), { source: 'gateway', tiers: ['priority'] }, '`fast` is the documented alias of priority');
});

test('an empty list is an explicit "none"; absence or garbage stays unknown', () => {
  assert.deepEqual(advertisedServiceTiers({ service_tiers: [] }), { source: 'gateway', tiers: [] });
  assert.deepEqual(advertisedServiceTiers({ id: 'gpt-6-sol' }), { source: 'unknown', tiers: [] });
  for (const bad of [{ service_tiers: 'priority' }, { service_tiers: [42] }, { service_tiers: [{ name: 'Fast' }] }, { service_tiers: ['PRIORITY!'] }]) {
    assert.equal(advertisedServiceTiers(bad).source, 'unknown', JSON.stringify(bad));
  }
});

test('a model name never implies a tier', () => {
  for (const id of ['gpt-6.1-sol', 'gpt-6-astra-fast', 'gpt-6-ultrafast']) {
    assert.equal(speedTiersFor({ id }, null, 'openai').source, 'unknown', id);
  }
});

test('an undeclared tier is a manual trial, still sent; impossible combinations are refused', () => {
  const declared = speedTiersFor({ service_tiers: ['priority'] }, 'priority', 'openai');
  assert.equal(declared.selectionSource, 'declared');
  const trial = speedTiersFor({ id: 'x' }, 'ultrafast', 'openai-response');
  assert.equal(trial.selectionSource, 'manual');
  assert.equal(trial.validationError, undefined, 'the user may try a tier nobody declared');
  assert.match(serviceTierError({ kind: 'chat', serviceTier: 'priority' }, 'anthropic'), /OpenAI/);
  assert.match(serviceTierError({ kind: 'image', serviceTier: 'priority' }, 'openai'), /chat/);
});

test('verdicts come from the response stamp only', () => {
  assert.equal(tierOutcome('priority', 'priority'), 'verified');
  assert.equal(tierOutcome('priority', 'fast'), 'verified');
  assert.equal(tierOutcome('ultrafast', 'default'), 'downgraded');
  assert.equal(tierOutcome('priority', undefined), 'unconfirmed');
  assert.equal(tierOutcome('default', 'default'), undefined, 'standard needs no verdict');
  assert.equal(tierOutcome(undefined, 'priority'), undefined);
});

test('the chat request carries service_tier only on OpenAI protocols', () => {
  assert.equal(requestFor('openai', 'https://gw', 'm', 'k', {}, 'priority').body.service_tier, 'priority');
  assert.equal(requestFor('responses', 'https://gw', 'm', 'k', {}, 'ultrafast').body.service_tier, 'ultrafast');
  assert.equal('service_tier' in requestFor('anthropic', 'https://gw', 'm', 'k', {}, 'priority').body, false);
  assert.equal('service_tier' in requestFor('openai', 'https://gw', 'm', 'k', {}).body, false, 'no tier saved, nothing sent');
});

test('the conversation payload gains service_tier; without one it is untouched', async () => {
  const seen = [];
  const api = { stream: (model, context, options) => { seen.push(options); return 'ok'; }, streamSimple: () => 'ok' };
  const entries = new Map([['fast', { id: 'fast', kind: 'chat', serviceTier: 'priority' }], ['plain', { id: 'plain', kind: 'chat' }]]);
  const wrapped = withModelPayload(api, new Map([['fast', 'fast'], ['plain', 'plain']]), entries, 'openai');
  wrapped.stream({ id: 'plain' }, {}, { marker: 1 });
  assert.deepEqual(seen.pop(), { marker: 1 }, 'no tier: options pass through unchanged');
  wrapped.stream({ id: 'fast' }, {}, {});
  const payload = await seen.pop().onPayload({ model: 'fast', messages: [] }, { id: 'fast' });
  assert.equal(payload.service_tier, 'priority');
});

test('catalog: the client catalog supplies tiers when the plain list has none', () => {
  const modelsDev = { refresh: async () => {}, status: () => ({}), match: () => undefined };
  const cat = new Catalog({ modelsDev, levels: new LevelCatalog({ providers: [] }) });
  const conn = { channelId: 'c', baseURL: 'https://gw', overrides: { 'gpt-6-luna': { serviceTier: 'ultrafast' } }, overridesRev: '1', headers: {}, defaultContextWindow: 1, defaultMaxTokens: 1 };
  const raw = {
    models: { data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }, { id: 'claude-opus-5-5' }] },
    tierCatalog: new Map([['gpt-6.1-sol', { slug: 'gpt-6.1-sol', service_tiers: [{ id: 'priority', name: 'Fast' }], additional_speed_tiers: ['fast'] }], ['claude-opus-5-5', { slug: 'claude-opus-5-5', service_tiers: [] }]]),
  };
  const by = Object.fromEntries(cat.build(conn, raw).entries.map((e) => [e.id, e.speedTiers]));
  assert.deepEqual([by['gpt-6.1-sol'].source, by['gpt-6.1-sol'].tiers], ['gateway', ['priority']]);
  assert.deepEqual([by['claude-opus-5-5'].source, by['claude-opus-5-5'].tiers], ['gateway', []], 'declared empty: no accelerated tier');
  assert.equal(by['gpt-6-luna'].source, 'unknown');
  assert.equal(by['gpt-6-luna'].selectionSource, 'manual', 'the user chose a tier the gateway did not declare');
});

test('a model test sends the saved tier and records the verdict', async (t) => {
  let sent;
  const sse = (tier) => `data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }], ...(tier ? { service_tier: tier } : {}) })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
  const run = async (returned, serviceTier = 'priority') => {
    t.mock.method(globalThis, 'fetch', async (url, init) => { sent = JSON.parse(init.body); return new Response(sse(returned), { headers: { 'content-type': 'text/event-stream' } }); });
    const tester = new ModelTester({
      channelFacts: async () => ({ baseURL: 'https://offline.invalid', apiKey: async () => 'offline-fake-key', entryFor: async () => ({ kind: 'chat', endpointTypes: ['openai'], serviceTier }) }),
    });
    const result = await tester.run({ channelId: `c-${returned}-${serviceTier}`, modelId: 'gpt-6.1-sol' });
    t.mock.restoreAll();
    return result;
  };
  const verified = await run('priority');
  assert.equal(sent.service_tier, 'priority');
  assert.equal(verified.ok, true);
  assert.equal(verified.tierOutcome, 'verified');
  assert.equal((await run('default')).tierOutcome, 'downgraded', 'the gateway answered at standard tier');
  assert.equal((await run(undefined)).tierOutcome, 'unconfirmed', 'no stamp, no conclusion');
  const plain = await run('default', null);
  assert.equal('service_tier' in sent, false, 'no saved tier: the test sends none');
  assert.equal(plain.tierOutcome, undefined);
});

test('a conversation choice wins over the model default, only for that conversation', async () => {
  const { SessionTiers } = await import('../lib/session-tiers.js');
  const tiers = new SessionTiers();
  tiers.set('s1', 'gw', 'gpt-6.1-sol', 'ultrafast');
  const seen = [];
  const api = { stream: (model, context, options) => { seen.push(options); return 'ok'; }, streamSimple: () => 'ok' };
  const entries = new Map([['gpt-6.1-sol', { id: 'gpt-6.1-sol', kind: 'chat', serviceTier: 'priority' }]]);
  const wrapped = withModelPayload(api, new Map([['gpt-6.1-sol', 'gpt-6.1-sol']]), entries, 'openai-response', (sid, mid) => tiers.get(sid, 'gw', mid));
  wrapped.stream({ id: 'gpt-6.1-sol' }, {}, { sessionId: 's1' });
  assert.equal((await seen.pop().onPayload({ model: 'gpt-6.1-sol' })).service_tier, 'ultrafast', 'session choice');
  wrapped.stream({ id: 'gpt-6.1-sol' }, {}, { sessionId: 's2' });
  assert.equal((await seen.pop().onPayload({ model: 'gpt-6.1-sol' })).service_tier, 'priority', 'other session: model default');
  wrapped.stream({ id: 'gpt-6.1-sol' }, {}, {});
  assert.equal((await seen.pop().onPayload({ model: 'gpt-6.1-sol' })).service_tier, 'priority', 'no session (title, compaction): model default');
  tiers.set('s1', 'gw', 'gpt-6.1-sol', null);
  wrapped.stream({ id: 'gpt-6.1-sol' }, {}, { sessionId: 's1' });
  assert.equal((await seen.pop().onPayload({ model: 'gpt-6.1-sol' })).service_tier, 'priority', 'cleared: back to the default');
  assert.equal(tiers.get('s1', 'other-gateway', 'gpt-6.1-sol'), undefined, 'a choice never follows another gateway');
  assert.throws(() => tiers.set('s1', 'gw', 'm', 'turbo'), /invalid/);
});

test('a conversation choice of standard sends default even when the model default is fast', async () => {
  const seen = [];
  const api = { stream: (m, c, options) => { seen.push(options); return 'ok'; }, streamSimple: () => 'ok' };
  const entries = new Map([['m', { id: 'm', kind: 'chat', serviceTier: 'priority' }]]);
  const wrapped = withModelPayload(api, new Map([['m', 'm']]), entries, 'openai', () => 'default');
  wrapped.stream({ id: 'm' }, {}, { sessionId: 's' });
  assert.equal((await seen.pop().onPayload({ model: 'm' })).service_tier, 'default');
});
