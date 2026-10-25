/**
 * The picker list: what a gateway lists, narrowed by the saved selection, minus ids
 * the gateway no longer serves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-catalog-'));
const { Catalog, chatModels } = await import('../lib/catalog.js');
const { LevelCatalog } = await import('../lib/levels.js');

const modelsDev = { refresh: async () => {}, status: () => ({}), match: () => undefined };
const conn = (extra = {}) => ({ channelId: 'c', baseURL: 'https://gw.example.com', providerId: 'ai-gateway', keyFingerprint: 'k', overridesRev: '1', headers: {}, overrides: {}, defaultContextWindow: 128000, defaultMaxTokens: 32768, ...extra });
const raw = { models: { data: ['gpt-6-sol', 'claude-opus-5-5', 'gpt-image-2', 'devin/swe-2'].map((id) => ({ id })) } };

test('without a selection every chat model is offered; media models never are', () => {
  const cat = new Catalog({ modelsDev, levels: new LevelCatalog({ providers: [] }) });
  const ids = chatModels(cat.build(conn(), raw)).map((e) => e.id);
  assert.deepEqual(ids, ['gpt-6-sol', 'claude-opus-5-5', 'devin/swe-2']);
});

test('a selection narrows the picker, in saved order', () => {
  const cat = new Catalog({ modelsDev, levels: new LevelCatalog({ providers: [] }) });
  const ids = chatModels(cat.build(conn({ enabledModels: ['claude-opus-5-5', 'gpt-6-sol'] }), raw)).map((e) => e.id);
  assert.deepEqual(ids, ['claude-opus-5-5', 'gpt-6-sol']);
});

test('a saved id the gateway stopped listing is not offered (it would fail on send)', () => {
  const cat = new Catalog({ modelsDev, levels: new LevelCatalog({ providers: [] }) });
  const built = cat.build(conn({ enabledModels: ['gpt-6-sol', 'retired-model'] }), raw);
  assert.deepEqual(chatModels(built).map((e) => e.id), ['gpt-6-sol']);
  assert.equal(built.entries.find((e) => e.id === 'retired-model').availability, 'missing', 'still visible to the management view');
});

test('a hidden model stays in the catalog but is not offered in the picker', () => {
  const cat = new Catalog({ modelsDev, levels: new LevelCatalog({ providers: [] }) });
  const built = cat.build(conn({ overrides: { 'devin/swe-2': { hidden: true } }, overridesRev: 'h' }), raw);
  assert.deepEqual(chatModels(built).map((e) => e.id), ['gpt-6-sol', 'claude-opus-5-5']);
  assert.equal(built.entries.find((e) => e.id === 'devin/swe-2').hidden, true, 'the settings list can still show and unhide it');
});
