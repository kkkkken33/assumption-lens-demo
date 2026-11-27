import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDeepSeek } from '../deepseek-client.js';

test('analysis uses the fast DeepSeek model and JSON response mode', async () => {
  let observed;
  const output = await runDeepSeek('Return JSON', {
    apiKey: 'test-only-key',
    jsonMode: true,
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    },
  });
  const body = JSON.parse(observed.options.body);
  assert.equal(observed.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(observed.options.headers.Authorization, 'Bearer test-only-key');
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(output, '{"ok":true}');
});

test('an invalid API key produces an actionable error', async () => {
  await assert.rejects(runDeepSeek('Hello', {
    apiKey: 'test-only-key',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 }),
  }), /重设API密钥/);
});

test('HTTP 402 is checked against the balance of the same key', async () => {
  let balanceChecked = false;
  await assert.rejects(runDeepSeek('Hello', {
    apiKey: 'test-only-key',
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer test-only-key');
      if (options.method === 'GET') {
        balanceChecked = true;
        assert.equal(String(url), 'https://api.deepseek.com/user/balance');
        return new Response(JSON.stringify({ is_available: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'Insufficient Balance (request_id: sample)' } }), { status: 402 });
    },
  }), error => error.message.includes('余额接口显示可用') && error.message.includes('sample'));
  assert.equal(balanceChecked, true);
});
