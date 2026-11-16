/**
 * The picker list: what a gateway lists, narrowed by the saved selection, minus ids
 * the gateway no longer serves.
 */
import http from 'node:http';
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

test('gateway display_name is preferred over slug, while user override wins over both', () => {
  const cat = new Catalog({ modelsDev, levels: new LevelCatalog({ providers: [] }) });
  const models = {
    data: [
      { id: 'gemini-4-argon-high' },
      { id: 'custom-listed', display_name: ' Listed Display \u0007Name ' },
      { id: 'blank-name', display_name: '   \n\t  ' },
      { id: 'user-renamed', display_name: 'Gateway Name' },
    ],
  };
  const tierCatalog = new Map([
    ['gemini-4-argon-high', { slug: 'gemini-4-argon-high', display_name: 'Gemini 4 Argon' }],
    ['custom-listed', { slug: 'custom-listed', display_name: 'Client Catalog Name' }],
  ]);
  const built = cat.build(
    conn({ overrides: { 'user-renamed': { name: 'My Custom Name' } }, overridesRev: 'dn' }),
    { models, tierCatalog },
  );
  const byId = Object.fromEntries(built.entries.map((e) => [e.id, e]));
  assert.equal(byId['gemini-4-argon-high'].name, 'Gemini 4 Argon');
  assert.equal(byId['gemini-4-argon-high'].id, 'gemini-4-argon-high');
  assert.equal(byId['custom-listed'].name, 'Listed Display Name', '/v1/models display_name wins and normalizes control chars');
  assert.equal(byId['blank-name'].name, 'blank-name', 'whitespace-only display_name falls back to id');
  assert.equal(byId['user-renamed'].name, 'My Custom Name', 'explicit user override wins over gateway display_name');
  assert.deepEqual(
    chatModels(built).map((e) => [e.id, e.name]),
    [
      ['gemini-4-argon-high', 'Gemini 4 Argon'],
      ['custom-listed', 'Listed Display Name'],
      ['blank-name', 'blank-name'],
      ['user-renamed', 'My Custom Name'],
    ],
  );
});

test('Catalog.get resolves display_name from CLIProxyAPI client_version catalog while keeping slug as id', async (t) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/v1/models') { res.writeHead(404).end(); return; }
    if (url.searchParams.get('client_version')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        models: [
          { slug: 'gemini-4-hydrogen-xhigh', display_name: 'Gemini 4 Hydrogen' },
          { slug: 'claude-opus-5-5-high', display_name: 'Claude Opus 5.5 (High)' },
        ],
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: [
        { id: 'gemini-4-hydrogen-xhigh', object: 'model', owned_by: 'antigravity' },
        { id: 'claude-opus-5-5-high', object: 'model', owned_by: 'antigravity' },
        { id: 'gemini-3-flash', object: 'model', owned_by: 'antigravity' },
      ],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const { port } = server.address();
  const cat = new Catalog({ modelsDev, levels: new LevelCatalog({ providers: [] }) });
  const built = await cat.get(conn({ baseURL: `http://127.0.0.1:${port}`, fetchTierCatalog: true }), 'sk-test');
  assert.deepEqual(
    chatModels(built).map((e) => [e.id, e.name]),
    [
      ['gemini-4-hydrogen-xhigh', 'Gemini 4 Hydrogen'],
      ['claude-opus-5-5-high', 'Claude Opus 5.5 (High)'],
      ['gemini-3-flash', 'gemini-3-flash'],
    ],
  );
});
