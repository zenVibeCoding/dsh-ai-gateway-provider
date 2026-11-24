/**
 * Gateway-declared native endpoints (`native_endpoints`) and per-model capacity /
 * modality metadata in `/v1/models` (for example Magpie and compatible gateways).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-gateway-native-'));
const { Catalog, gatewayContextWindow, gatewayMaxTokens, gatewayModalities } = await import('../lib/catalog.js');
const { LevelCatalog } = await import('../lib/levels.js');
const { endpointTypesOf, nativeEndpointType, selectedProtocol } = await import('../lib/service-tiers.js');

const noModelsDev = { refresh: async () => {}, status: () => ({}), match: () => undefined };
const conn = (extra = {}) => ({
  channelId: 'gw',
  baseURL: 'http://127.0.0.1:3425',
  providerId: 'ai-gateway',
  keyFingerprint: 'k',
  overridesRev: '1',
  headers: {},
  overrides: {},
  defaultContextWindow: 128_000,
  defaultMaxTokens: 32_768,
  ...extra,
});

test('nativeEndpointType maps standard chat paths and ignores non-chat routes', () => {
  assert.equal(nativeEndpointType('/v1/chat/completions'), 'openai');
  assert.equal(nativeEndpointType('POST /openai/v1/chat/completions/'), 'openai');
  assert.equal(nativeEndpointType('/v1/responses'), 'openai-response');
  assert.equal(nativeEndpointType('/v1/responses?foo=1'), 'openai-response');
  assert.equal(nativeEndpointType('/v1/messages'), 'anthropic');
  assert.equal(nativeEndpointType('POST /v1/messages/'), 'anthropic');
  assert.equal(nativeEndpointType('/v1beta/models'), 'gemini');
  assert.equal(nativeEndpointType('/v1beta/models/{model}:generateContent'), 'gemini');
  assert.equal(nativeEndpointType('/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse'), 'gemini');

  for (const ignored of [
    undefined, null, 123, '', '   ',
    '/v1/messages/count_tokens',
    '/v1/embeddings',
    '/v1/rerank',
    '/v1/systemone',
    '/v1/images/generations',
    '/v1/audio/speech',
  ]) {
    assert.equal(nativeEndpointType(ignored), undefined, String(ignored));
  }
});

test('endpointTypesOf prefers supported_endpoint_types and falls back to native_endpoints', () => {
  assert.deepEqual(
    endpointTypesOf({ supported_endpoint_types: ['openai', 'anthropic'], native_endpoints: ['/v1/responses'] }),
    ['openai', 'anthropic'],
  );
  assert.deepEqual(
    endpointTypesOf({ supported_endpoint_types: [], native_endpoints: ['/v1/messages'] }),
    ['anthropic'],
  );
  assert.deepEqual(
    endpointTypesOf({ native_endpoints: ['/v1/chat/completions', '/v1/messages', '/v1/messages', '/v1/embeddings'] }),
    ['openai', 'anthropic'],
  );
  assert.deepEqual(endpointTypesOf({ native_endpoints: ['/v1/responses'] }), ['openai-response']);
  assert.deepEqual(endpointTypesOf({ native_endpoints: ['/v1beta/models/{model}:generateContent'] }), ['gemini']);
  assert.equal(endpointTypesOf({ native_endpoints: ['/v1/systemone', '/v1/embeddings'] }), undefined);
  assert.equal(endpointTypesOf(null), undefined);
  assert.equal(endpointTypesOf([]), undefined);
});

test('catalog resolves native_endpoints into protocol selection and honours overrides', () => {
  const cat = new Catalog({ modelsDev: noModelsDev, levels: new LevelCatalog({ providers: [] }) });
  const raw = {
    models: {
      data: [
        { id: 'agy-cli/gemini-4-neon', native_endpoints: ['/v1/messages'] },
        { id: 'codex/gpt-5.6-terra', native_endpoints: ['/v1/responses'] },
        { id: 'google/gemini-4-pro', native_endpoints: ['/v1beta/models/{model}:generateContent'] },
        { id: 'copilot/claude-fable-5.1', native_endpoints: ['/v1/chat/completions', '/v1/messages'] },
      ],
    },
  };
  const built = cat.build(conn({
    overrides: { 'copilot/claude-fable-5.1': { protocol: 'anthropic' } },
  }), raw);
  const byId = Object.fromEntries(built.entries.map((e) => [e.id, e]));

  assert.deepEqual(byId['agy-cli/gemini-4-neon'].endpointTypes, ['anthropic']);
  assert.equal(selectedProtocol(byId['agy-cli/gemini-4-neon'].endpointTypes), 'anthropic');

  assert.deepEqual(byId['codex/gpt-5.6-terra'].endpointTypes, ['openai-response']);
  assert.equal(selectedProtocol(byId['codex/gpt-5.6-terra'].endpointTypes), 'openai-response');

  assert.deepEqual(byId['google/gemini-4-pro'].endpointTypes, ['gemini']);
  assert.equal(selectedProtocol(byId['google/gemini-4-pro'].endpointTypes), 'gemini');

  assert.deepEqual(byId['copilot/claude-fable-5.1'].endpointTypes, ['anthropic']);
  assert.equal(selectedProtocol(byId['copilot/claude-fable-5.1'].endpointTypes), 'anthropic');
});

test('gateway context window, max output tokens and modalities beat models.dev but yield to user overrides', () => {
  const devData = {
    'codex/gpt-5.6-terra': { context: 1_050_000, output: 128_000, input: ['text', 'image', 'pdf'], outputModalities: ['text'], provider: 'openai', match: 'exact' },
    'auto/gemini-4-argon': { context: 1_048_576, output: 32_768, input: ['text'], outputModalities: ['text'], provider: 'google', match: 'exact' },
  };
  const cat = new Catalog({ modelsDev: { match: (id) => devData[id] }, levels: new LevelCatalog({ providers: [] }) });
  const raw = {
    models: {
      data: [
        {
          id: 'codex/gpt-5.6-terra',
          context_window: 272_000,
          max_output_tokens: 64_000,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
        {
          id: 'auto/gemini-4-argon',
          context_length: 1_048_576,
          max_completion_tokens: 65_536,
          modalities: { input: ['text', 'image', 'audio', 'video', 'pdf'], output: ['text'] },
        },
        {
          id: 'custom-image-gen',
          modalities: { input: ['text'], output: ['image'] },
        },
      ],
    },
  };
  const built = cat.build(conn({
    overrides: {
      'auto/gemini-4-argon': { contextWindow: 500_000, maxTokens: 16_384, input: ['text', 'image'] },
    },
  }), raw);
  const byId = Object.fromEntries(built.entries.map((e) => [e.id, e]));

  // Gateway channel cap overrides broader models.dev spec.
  assert.equal(byId['codex/gpt-5.6-terra'].contextWindow, 272_000);
  assert.equal(byId['codex/gpt-5.6-terra'].automaticContextWindow, 272_000);
  assert.equal(byId['codex/gpt-5.6-terra'].maxTokens, 64_000);
  assert.equal(byId['codex/gpt-5.6-terra'].automaticMaxTokens, 64_000);
  assert.deepEqual(byId['codex/gpt-5.6-terra'].input, ['text', 'image']);
  assert.deepEqual(byId['codex/gpt-5.6-terra'].automaticInput, ['text', 'image']);

  // User override wins while automatic fields preserve gateway declarations.
  assert.equal(byId['auto/gemini-4-argon'].contextWindow, 500_000);
  assert.equal(byId['auto/gemini-4-argon'].automaticContextWindow, 1_048_576);
  assert.equal(byId['auto/gemini-4-argon'].maxTokens, 16_384);
  assert.equal(byId['auto/gemini-4-argon'].automaticMaxTokens, 65_536);
  assert.deepEqual(byId['auto/gemini-4-argon'].input, ['text', 'image']);
  assert.deepEqual(byId['auto/gemini-4-argon'].automaticInput, ['text', 'image', 'audio', 'video', 'pdf']);

  // Gateway output modalities assist classification even without models.dev.
  assert.equal(byId['custom-image-gen'].kind, 'image');
});

test('malformed gateway metadata is ignored and upstreamModel aliases prefer target gateway metadata', () => {
  for (const bad of [null, undefined, [], { context_window: 0 }, { context_window: -10 }, { context_window: 1.5 }, { context_window: '128000' }, { context_window: Infinity }]) {
    assert.equal(gatewayContextWindow(bad), undefined);
  }
  for (const bad of [null, { max_output_tokens: 0 }, { max_output_tokens: -1 }, { max_completion_tokens: '4096' }]) {
    assert.equal(gatewayMaxTokens(bad), undefined);
  }
  for (const bad of [null, { modalities: {} }, { modalities: { input: [] } }, { modalities: { input: ['bogus'] } }, { modalities: { input: 'text' } }]) {
    assert.equal(gatewayModalities(bad, 'input'), undefined);
  }
  assert.deepEqual(gatewayModalities({ modalities: { input: ['text', 'unknown', 'image', 'image'] } }, 'input'), ['text', 'image']);

  const cat = new Catalog({ modelsDev: noModelsDev, levels: new LevelCatalog({ providers: [] }) });
  const raw = {
    models: {
      data: [
        { id: 'local', context_window: 100_000, max_output_tokens: 8_192, native_endpoints: ['/v1/chat/completions'] },
        { id: 'remote', context_window: 272_000, max_output_tokens: 64_000, modalities: { input: ['text', 'image'] }, native_endpoints: ['/v1/responses'] },
      ],
    },
  };
  const [entry] = cat.build(conn({ enabledModels: ['local'], overrides: { local: { upstreamModel: 'remote' } } }), raw).entries;
  assert.equal(entry.contextWindow, 272_000);
  assert.equal(entry.maxTokens, 64_000);
  assert.deepEqual(entry.input, ['text', 'image']);
  assert.deepEqual(entry.endpointTypes, ['openai-response']);
});
