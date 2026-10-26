import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aig-controls-'));
const { Catalog } = await import('../lib/catalog.js');
const { LevelCatalog } = await import('../lib/levels.js');
const { mergeModelOverride } = await import('../lib/channels.js');
const { composerSpeedTiers, withModelPayload } = await import('../lib/service-tiers.js');
const { ModelTester } = await import('../lib/model-test.js');
const modelsDev = { refresh: async () => {}, status: () => ({}), match: () => undefined };
const conn = (overrides = {}) => ({ channelId: 'gw', baseURL: 'https://offline.invalid', overrides, headers: {}, defaultContextWindow: 128000, defaultMaxTokens: 32768 });
const raw = {
  models: { data: [{ id: 'gpt-example' }] },
  tierCatalog: new Map([['gpt-example', { slug: 'gpt-example', supported_reasoning_levels: [{ effort: 'none' }, { effort: 'medium' }, { effort: 'high' }], default_reasoning_level: 'high', service_tiers: [{ id: 'priority' }, { id: 'ultrafast' }] }]]),
};
async function build(overrides = {}, source = raw) {
  const c = new Catalog({ modelsDev, levels: new LevelCatalog({ providers: [] }) });
  const connection = conn(overrides);
  return c.build(connection, source, await c.resolveLevels(connection, source)).entries[0];
}

test('model fetch resolves gateway reasoning and speed evidence before editor opens', async () => {
  const e = await build();
  assert.equal(e.automaticReasoning, true);
  assert.equal(e.automaticReasoningKnown, true);
  assert.deepEqual(e.automaticReasoningLevels, ['off', 'medium', 'high']);
  assert.equal(e.automaticThinkingLevelMap.off, 'none');
  assert.equal(e.defaultReasoningEffort, 'high');
  assert.deepEqual(e.speedTiers.tiers, ['priority', 'ultrafast']);
  assert.equal(e.speedEnabled, true);
});

test('allowed levels, wire mappings and defaults are separate from automatic capability', async () => {
  const e = await build({ 'gpt-example': { reasoning: true, thinkingLevelMap: { medium: 'medium', high: 'high' }, defaultReasoningEffort: 'medium', speedEnabled: true, allowedServiceTiers: ['default', 'priority'], serviceTier: 'priority' } });
  assert.deepEqual(e.reasoningLevels, ['medium', 'high']);
  assert.deepEqual(e.automaticReasoningLevels, ['off', 'medium', 'high']);
  assert.equal(e.defaultReasoningEffort, 'medium');
  assert.deepEqual(composerSpeedTiers(e).map((v) => v.tier), ['priority']);
  assert.deepEqual(e.speedTiers.tiers, ['priority', 'ultrafast']);
});

test('off keeps discovery results but removes effective controls and selected speed', async () => {
  const e = await build({ 'gpt-example': { reasoning: false, speedEnabled: false, serviceTier: 'ultrafast' } });
  assert.equal(e.reasoning, false);
  assert.deepEqual(e.reasoningLevels, []);
  assert.deepEqual(e.automaticReasoningLevels, ['off', 'medium', 'high']);
  assert.equal(e.serviceTier, undefined);
  assert.deepEqual(composerSpeedTiers(e), []);
  let options;
  const api = { streamSimple: (m, c, o) => { options = o; }, stream: () => {} };
  const wrapped = withModelPayload(api, new Map(), new Map([[e.id, e]]), 'openai', () => 'priority');
  wrapped.streamSimple({ id: e.id }, {}, { sessionId: 's', serviceTier: 'priority', onPayload: () => ({ service_tier: 'ultrafast' }) });
  assert.equal(options.serviceTier, undefined);
  assert.equal('service_tier' in await options.onPayload({ model: e.id }), false);
});

test('revoked session tier cannot bypass allowed tiers; model default is used instead', async () => {
  const e = await build({ 'gpt-example': { allowedServiceTiers: ['default', 'priority'], serviceTier: 'priority' } });
  let options;
  const api = { streamSimple: (m, c, o) => { options = o; }, stream: () => {} };
  withModelPayload(api, new Map(), new Map([[e.id, e]]), 'openai', () => 'ultrafast').streamSimple({ id: e.id }, {}, { sessionId: 's' });
  assert.equal((await options.onPayload({ model: e.id })).service_tier, 'priority');
  assert.equal(options.reasoning, 'high', 'detected default passed to SDK when no effort chosen');
});

test('unknown reasoning and speed remain unknown; metadata from alias target is used', async () => {
  const unknown = await build({}, { models: { data: [{ id: 'gpt-unknown' }] } });
  assert.equal(unknown.automaticReasoningKnown, false);
  assert.equal(unknown.speedTiers.source, 'unknown');
  assert.equal(unknown.speedEnabled, false);
  const c = new Catalog({ modelsDev, levels: new LevelCatalog({ providers: [] }) });
  const connection = { ...conn({ alias: { custom: true, upstreamModel: 'gpt-example' } }), enabledModels: ['alias'] };
  const e = c.build(connection, raw, await c.resolveLevels(connection, raw)).entries[0];
  assert.deepEqual(e.reasoningLevels, ['off', 'medium', 'high']);
  assert.equal(e.speedTiers.source, 'gateway');
});

test('mutation validates allowed and default tiers while permitting disabling a saved selection', () => {
  assert.throws(() => mergeModelOverride({}, { allowedServiceTiers: [] }), /invalid/);
  assert.throws(() => mergeModelOverride({}, { allowedServiceTiers: ['priority'], serviceTier: 'ultrafast' }), /default speed/);
  assert.throws(() => mergeModelOverride({}, { thinkingLevelMap: { high: 'high' }, defaultReasoningEffort: 'medium' }), /default reasoning/);
  assert.doesNotThrow(() => mergeModelOverride({ serviceTier: 'ultrafast' }, { speedEnabled: false, allowedServiceTiers: ['default'] }));
});

test('model tester also omits service_tier when the master switch is off', async (t) => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    sent = JSON.parse(opts.body);
    return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const tester = new ModelTester({ channelFacts: async () => ({ baseURL: 'https://offline.invalid', apiKey: async () => 'fake-key', entryFor: async () => ({ kind: 'chat', endpointTypes: ['openai'], serviceTier: 'priority', speedEnabled: false }) }) });
  const result = await tester.run({ channelId: 'off', modelId: 'gpt-example' });
  assert.equal(result.ok, true);
  assert.equal('service_tier' in sent, false);
  assert.equal(result.requestedServiceTier, null);
});

test('editor equality includes custom level names and empty wire remains hidden', () => {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('    function sameLevelMap('), source.indexOf('    /** Wire value a level'));
  const equal = vm.runInNewContext(`const LEVELS=['off','minimal','low','medium','high','xhigh','max']; ${fn}; sameLevelMap`);
  assert.equal(equal({ high: 'high', turbo: 'turbo' }, { high: 'high' }), false);
  assert.equal(equal({ high: 'high' }, { high: 'high', off: null }), true);
});
