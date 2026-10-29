/**
 * Reasoning level resolution.
 *
 * The bug this locks down: with no override, every reasoning model used to advertise
 * the same `off/minimal/low/medium/high` set, because no `thinkingLevelMap` reached
 * pi-ai. Vendors differ — Gemini 3 cannot be turned off, DeepSeek has a gap at
 * `medium`, `xhigh`/`max` only exist where they are explicitly mapped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'newapi-provider-levels-'));
const { LevelCatalog, levelsFromMap, mapFromLevels, resolveReasoningLevels, gatewayReasoning, thinkingCompat, LEVELS } = await import('../lib/levels.js');
const { Catalog } = await import('../lib/catalog.js');

test('gateway reasoning is unknown without explicit valid per-model metadata', () => {
  for (const model of [undefined, null, [], 'gpt-6', {}, { id: 'gpt-6' },
    { supports_reasoning_effort_updates: true }, { default_reasoning_level: 'high' },
    { supported_reasoning_levels: 'low,high' },
    { supported_reasoning_levels: [null] }, { supported_reasoning_levels: [{}] },
    { supported_reasoning_levels: [{ effort: 1 }] },
    { supported_reasoning_levels: ['low', { effort: 'high' }] },
    { supported_reasoning_levels: [{ effort: 'low' }, 'high'] },
    { supported_reasoning_levels: ['low', 'HIGH'] },
    { supported_reasoning_levels: ['low', 'bad level'] },
    { supported_reasoning_levels: ['__proto__'] },
    { supported_reasoning_levels: ['a'.repeat(25)] },
    { supported_reasoning_levels: Array(33).fill('low') },
  ]) assert.equal(gatewayReasoning(model), undefined, JSON.stringify(model));
});

test('only an explicitly empty level list disables effort updates', () => {
  const expected = {
    levels: [], map: Object.fromEntries(LEVELS.map((level) => [level, null])),
    source: 'gateway', supported: false, defaultEffort: undefined,
  };
  for (const model of [
    { supported_reasoning_levels: [] },
    { supported_reasoning_levels: [], supports_reasoning_effort_updates: false },
    { supported_reasoning_levels: [], supports_reasoning_effort_updates: true, default_reasoning_level: 'high' },
  ]) assert.deepEqual(gatewayReasoning(model), expected);
});

test('a level that cannot be updated mid-turn still keeps its levels (CLIProxy Claude)', () => {
  // Exactly what a CLIProxyAPI catalog serves for claude-sonnet-5-5: five efforts, a
  // default, and `supports_reasoning_effort_updates: false` — the flag says a running
  // turn cannot change its level, not that the model has none.
  const model = {
    slug: 'claude-sonnet-5-5',
    default_reasoning_level: 'medium',
    supports_reasoning_effort_updates: false,
    supported_reasoning_levels: [
      { description: 'Fast responses with lighter reasoning', effort: 'low' },
      { description: 'Balances speed and reasoning depth', effort: 'medium' },
      { description: 'Greater reasoning depth', effort: 'high' },
      { description: 'Extra high reasoning depth', effort: 'xhigh' },
      { description: 'Maximum available reasoning depth', effort: 'max' },
    ],
  };
  const parsed = gatewayReasoning(model);
  assert.equal(parsed.supported, true);
  assert.deepEqual(parsed.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(parsed.defaultEffort, 'medium');
  assert.equal(parsed.source, 'gateway');
  assert.deepEqual(levelsFromMap(parsed.map), parsed.levels);
  // The flag on its own declares nothing: the installed catalog decides instead.
  assert.equal(gatewayReasoning({ supports_reasoning_effort_updates: false }), undefined);
  assert.equal(gatewayReasoning({ supports_reasoning_effort_updates: false, supported_reasoning_levels: 'malformed' }), undefined);
});

test('gateway levels normalise none, preserve wire values and hide undeclared standards', () => {
  const model = { id: 'gemini-3-pro', supported_reasoning_levels: ['ultra', 'high', 'none', 'low', 'high'], default_reasoning_level: 'none' };
  const snapshot = structuredClone(model);
  const parsed = gatewayReasoning(model);
  assert.deepEqual(parsed, {
    levels: ['off', 'low', 'high', 'ultra'],
    map: { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null, ultra: 'ultra' },
    source: 'gateway', supported: true, defaultEffort: 'off',
  });
  assert.deepEqual(levelsFromMap(parsed.map), parsed.levels);
  assert.deepEqual(model, snapshot);
});

test('gateway effort objects, safe custom ids and declared defaults are accepted', () => {
  const parsed = gatewayReasoning({
    supported_reasoning_levels: [{ effort: 'z_custom-1' }, { effort: 'low' }, { effort: 'a'.repeat(24) }],
    default_reasoning_level: 'z_custom-1',
  });
  assert.deepEqual(parsed.levels, ['low', 'a'.repeat(24), 'z_custom-1']);
  assert.equal(parsed.defaultEffort, 'z_custom-1');
  assert.equal(parsed.map.off, null);
  for (const default_reasoning_level of ['max', '', 1, null, {}, 'LOW']) {
    assert.equal(gatewayReasoning({ supported_reasoning_levels: ['low'], default_reasoning_level }).defaultEffort, undefined);
  }
  assert.equal(gatewayReasoning({ supported_reasoning_levels: Array(32).fill('low') }).supported, true);
  const boundary = gatewayReasoning({ supported_reasoning_levels: Array.from({ length: 32 }, (_, n) => `custom-${n}`) });
  assert.equal(boundary.levels.length, 32);
});

test('resolver prioritises user overrides, then parsed gateway metadata, then old fallbacks', async () => {
  const catalog = familyOnly();
  catalog.index = new Map([['gpt-6', { thinkingLevelMap: { high: 'CATALOG' } }]]);
  const gateway = gatewayReasoning({ supported_reasoning_levels: ['none', 'high'], default_reasoning_level: 'high' });
  assert.deepEqual(await resolveReasoningLevels({ id: 'gpt-6', catalog, gateway }), gateway);
  // Gateway and explicit maps need no catalog lookup at all.
  assert.deepEqual(await resolveReasoningLevels({ id: 'private', gateway }), gateway);
  const disabled = gatewayReasoning({ supported_reasoning_levels: [] });
  assert.deepEqual(await resolveReasoningLevels({ id: 'gpt-6', catalog, gateway: disabled }), disabled);
  const override = await resolveReasoningLevels({ id: 'gpt-6', catalog, gateway, override: ['off', 'low'] });
  assert.deepEqual(override.levels, ['off', 'low']);
  assert.equal(override.source, 'override');
  assert.equal(override.map.off, 'none');
  assert.equal(override.map.low, 'low');
  const mapped = await resolveReasoningLevels({ id: 'gpt-6', gateway: disabled, override: ['high'], overrideMap: { low: 'CUSTOM' } });
  assert.deepEqual(mapped.levels, ['low']);
  assert.equal(mapped.map.low, 'CUSTOM');
  assert.equal(mapped.source, 'override');
  assert.deepEqual(await resolveReasoningLevels({ id: 'gpt-6', catalog, gateway, overrideMap: { low: null } }), gateway);
  const unknown = await resolveReasoningLevels({ id: 'private', catalog });
  assert.equal(unknown.source, 'default');
  assert.equal(Object.hasOwn(unknown, 'supported'), true);
  assert.equal(unknown.supported, undefined);
  assert.equal((await resolveReasoningLevels({ id: 'gpt-6', catalog })).source, 'catalog');
  assert.equal((await resolveReasoningLevels({ id: 'gpt-5', catalog })).source, 'family');
});

/** No pi-ai catalogs: exercise the family defaults only. */
const familyOnly = () => new LevelCatalog({ providers: [] });

test('a map decides which levels exist; xhigh and max need an explicit mapping', () => {
  assert.deepEqual(levelsFromMap(undefined), ['off', 'minimal', 'low', 'medium', 'high']);
  // Claude adaptive: exactly what pi-ai ships — off hidden, minimal still offered,
  // xhigh/max appear because they are mapped.
  assert.deepEqual(levelsFromMap({ off: null, xhigh: 'xhigh', max: 'max' }), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  // Gemini 3 pro: two step levers.
  assert.deepEqual(levelsFromMap({ off: null, minimal: null, low: 'LOW', medium: null, high: 'HIGH' }), ['low', 'high']);
  // DeepSeek v4: gap at medium.
  assert.deepEqual(levelsFromMap({ minimal: null, low: 'low', medium: null, high: 'high', max: 'max' }), ['off', 'low', 'high', 'max']);
});

test('mapFromLevels keeps upstream strings and hides everything else', () => {
  const map = mapFromLevels(['low', 'high'], { low: 'LOW', high: 'HIGH', off: 'none' });
  assert.deepEqual(map, { off: null, minimal: null, low: 'LOW', medium: null, high: 'HIGH', xhigh: null, max: null });
  // Without a base the level id is the wire value.
  assert.equal(mapFromLevels(['medium']).medium, 'medium');
  assert.equal(mapFromLevels([]), undefined);
});

test('family defaults differ by vendor instead of one global set', async () => {
  const catalog = familyOnly();
  const levels = async (id) => (await resolveReasoningLevels({ id, catalog })).levels;
  // Anthropic effort has no "minimal": low/medium/high/xhigh/max.
  assert.deepEqual(await levels('claude-opus-5-5'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(await levels('claude-3-7-sonnet'), ['off', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(await levels('gpt-5'), ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(await levels('gpt-5.6-luna'), ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(await levels('o3'), ['low', 'medium', 'high']);
  // Gemini 3 thinking_level: MINIMAL/LOW/MEDIUM/HIGH, never off.
  assert.deepEqual(await levels('gemini-3-pro'), ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(await levels('deepseek-v4.1-flash'), ['off', 'low', 'high', 'max']);
  // GLM-5.3 rejects `disabled`, so off must not be offered; it also has no medium.
  assert.deepEqual(await levels('glm-5.3'), ['low', 'high', 'max']);
  assert.deepEqual(await levels('gpt-5-pro'), ['high']);
  assert.deepEqual(await levels('kimi-k3'), ['low', 'high', 'max']);
  // Nothing recognised: pi-ai's own default, never a made-up set.
  assert.deepEqual(await levels('totally-unknown-model'), ['off', 'minimal', 'low', 'medium', 'high']);
});

test('shipped catalog wins over the family default; the user override wins over both', async () => {
  const catalog = new LevelCatalog({ providers: [] });
  // Stand in for pi-ai's shipped entry for this id.
  catalog.index = new Map([['gemini-2-5-flash', { id: 'gemini-2.5-flash', thinkingLevelMap: { off: '0', minimal: null, low: null, medium: null, high: null } }]]);
  catalog.loading = Promise.resolve(catalog.index);

  const shipped = await resolveReasoningLevels({ id: 'gemini-2.5-flash', catalog });
  assert.equal(shipped.source, 'catalog');
  assert.deepEqual(shipped.levels, ['off']);

  const mine = await resolveReasoningLevels({ id: 'gemini-2.5-flash', override: ['high'], catalog });
  assert.equal(mine.source, 'override');
  assert.deepEqual(mine.levels, ['high']);
  assert.equal(mine.map.low, null, 'levels outside the override are hidden');

  // An override on an unknown model still yields a valid map.
  const custom = await resolveReasoningLevels({ id: 'private-model', override: ['medium'], catalog });
  assert.deepEqual(custom.levels, ['medium']);
  assert.equal(custom.map.max, null);
});

test('one relay gateway produces different level sets per model', async () => {
  // Capability source marks these as reasoning models, as current models.dev data does.
  const modelsDev = { refresh: async () => {}, status: () => ({}), match: () => ({ reasoning: true, context: 200000, output: 64000, provider: 'x', match: 'exact' }) };
  const cat = new Catalog({ modelsDev, logger: { warn() {} }, levels: familyOnly() });
  const conn = { channelId: 'c1', baseURL: 'https://gw.example.com', providerId: 'newapi-provider', keyFingerprint: 'k', overridesRev: '1', headers: {}, defaultContextWindow: 128000, defaultMaxTokens: 32768, overrides: { 'claude-opus-5-5': { reasoningLevels: ['low', 'max'] } } };
  const ids = ['claude-opus-5-5', 'gemini-3-pro', 'gpt-5.6-luna', 'deepseek-v4.1-flash'];
  const info = await cat.resolveLevels(conn, { models: { data: ids.map((id) => ({ id })) } });
  const built = cat.build(conn, { models: { data: ids.map((id) => ({ id })) } }, info);
  const byId = Object.fromEntries(built.entries.map((e) => [e.id, e]));

  assert.deepEqual(byId['gemini-3-pro'].reasoningLevels, ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(byId['deepseek-v4.1-flash'].reasoningLevels, ['off', 'low', 'high', 'max']);
  assert.deepEqual(byId['gpt-5.6-luna'].reasoningLevels, ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  // Overridden model keeps its declared set and remembers what the default would be.
  assert.deepEqual(byId['claude-opus-5-5'].reasoningLevels, ['low', 'max']);
  assert.deepEqual(byId['claude-opus-5-5'].automaticReasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(byId['claude-opus-5-5'].reasoningLevelsSource, 'override');
  assert.equal(byId['gemini-3-pro'].reasoningLevelsSource, 'family');
  // The advertised list and the map must agree: pi-ai derives its selector from the
  // map, DSH rejects any effort we did not advertise, so a mismatch is a 400 waiting.
  for (const entry of built.entries) {
    if (!entry.reasoning) continue;
    assert.deepEqual(levelsFromMap(entry.thinkingLevelMap), entry.reasoningLevels, `levels disagree with the map for ${entry.id}`);
  }
});

test('a user-supplied level map decides both the selector and the wire value', async () => {
  const catalog = familyOnly();
  // Exactly what the editor table stores: level → API value, blank meaning "send nothing".
  const overrideMap = { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' };
  const resolved = await resolveReasoningLevels({ id: 'claude-opus-5-5', overrideMap, catalog });
  assert.equal(resolved.source, 'override');
  assert.deepEqual(resolved.levels, ['low', 'high', 'max']);
  assert.deepEqual(resolved.map, overrideMap);

  // A level mapped to a vendor-specific string is passed through untouched.
  const gemini = await resolveReasoningLevels({ id: 'gemini-3-pro', overrideMap: { low: 'LOW', high: 'HIGH' }, catalog });
  assert.deepEqual(gemini.levels, ['low', 'high']);
  assert.equal(gemini.map.low, 'LOW');
});

test('custom level names work when they carry a wire value', async () => {
  const catalog = familyOnly();
  const overrideMap = { low: 'low', high: 'high', ultra: 'ULTRA', bogus: null };
  const resolved = await resolveReasoningLevels({ id: 'claude-opus-5-5', overrideMap, catalog });
  // Preset levels first, then the custom one; a custom name without a value is not offered.
  assert.deepEqual(resolved.levels, ['low', 'high', 'ultra']);
  assert.equal(resolved.map.ultra, 'ULTRA');
  assert.equal(resolved.map.bogus, undefined);

  // A custom name that is not a safe id never becomes a level.
  const rejected = await resolveReasoningLevels({ id: 'x', overrideMap: { 'Not An Id': 'x' }, catalog });
  assert.deepEqual(rejected.levels, ['off', 'minimal', 'low', 'medium', 'high']);
});

test('a resolved entry can be handed in, so one id is looked up once', async () => {
  const catalog = familyOnly();
  let lookups = 0;
  catalog.find = async () => { lookups++; return { model: { thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } }, match: 'exact' }; };
  const found = await catalog.find('claude-sonnet-5-5');
  const resolved = await resolveReasoningLevels({ id: 'claude-sonnet-5-5', catalog, found });
  assert.equal(resolved.source, 'catalog');
  assert.deepEqual(resolved.levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(lookups, 1);
});

test('the shipped compat block survives, minus routing and mid-conversation switching', () => {
  // pi-ai's own anthropic entry for claude-sonnet-5-5.
  const shipped = {
    supportsMidConvoEffort: true, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true,
    forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true,
    allowedFallbackModels: [{ provider: 'anthropic', model: 'claude-opus-5' }],
    sendSessionAffinityHeaders: true, sessionAffinityFormat: 'anthropic',
  };
  // What stays decides how the level reaches the wire. What leaves either moves the
  // level into synthetic system messages (pi-ai then pins `output_config.effort` to
  // "high") or switches the model behind the user's back.
  assert.deepEqual(thinkingCompat(shipped), {
    forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true,
  });
  assert.equal(thinkingCompat(undefined), undefined);
  assert.equal(thinkingCompat({}), undefined);
  assert.equal(thinkingCompat([{ forceAdaptiveThinking: true }]), undefined);
  // Nothing but withheld fields is the same as no compat at all.
  assert.equal(thinkingCompat({ allowedFallbackModels: [], openRouterRouting: { only: ['x'] } }), undefined);
});

test('one gateway entry carries its levels and the compat that puts them on the wire', async () => {
  const modelsDev = { refresh: async () => {}, status: () => ({}), match: () => ({ reasoning: true, context: 200000, output: 64000, provider: 'x', match: 'exact' }) };
  const levels = familyOnly();
  levels.index = new Map([['claude-sonnet-5-5', {
    id: 'claude-sonnet-5-5',
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    compat: { forceAdaptiveThinking: true, allowedFallbackModels: [] },
  }]]);
  levels.loading = Promise.resolve(levels.index);
  const cat = new Catalog({ modelsDev, logger: { warn() {} }, levels });
  const conn = { channelId: 'c1', baseURL: 'https://gw.example.com', providerId: 'ai-gateway', keyFingerprint: 'k', overridesRev: '1', headers: {}, overrides: {} };
  const models = { data: [{ id: 'claude-sonnet-5-5' }] };
  const info = await cat.resolveLevels(conn, { models });
  const entry = cat.build(conn, { models }, info).entries.find((e) => e.id === 'claude-sonnet-5-5');
  assert.equal(entry.reasoning, true);
  assert.deepEqual(entry.reasoningLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(entry.reasoningLevelsSource, 'catalog');
  assert.deepEqual(entry.piCompat, { forceAdaptiveThinking: true });
});
