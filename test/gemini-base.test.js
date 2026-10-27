import test from 'node:test';
import assert from 'node:assert/strict';
import { baseUrlFor, geminiBase } from '../lib/util.js';
import { requestFor } from '../lib/model-test.js';

// The Google GenAI SDK appends `models/<id>:streamGenerateContent` straight onto the base
// (pi-ai sets apiVersion to ''), so chat and test must both include `/v1beta`.
test('Gemini chat base carries /v1beta, matching the model-test URL', () => {
  for (const input of ['https://gw.example', 'https://gw.example/', 'https://gw.example/v1', 'https://gw.example/v1/']) {
    assert.equal(geminiBase(input), 'https://gw.example/v1beta', input);
    assert.equal(baseUrlFor(input, 'google-generative-ai'), 'https://gw.example/v1beta', input);
  }
  const chatUrl = `${baseUrlFor('https://gw.example/v1', 'google-generative-ai')}/models/gemini-3-pro:streamGenerateContent?alt=sse`;
  assert.equal(requestFor('gemini', 'https://gw.example', 'gemini-3-pro', 'k').url, chatUrl);
  assert.equal(baseUrlFor('https://gw.example/v1', 'openai-completions'), 'https://gw.example/v1');
  assert.equal(baseUrlFor('https://gw.example/v1', 'anthropic-messages'), 'https://gw.example');
});
