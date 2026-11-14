// Tests the real Gemini wrapper (time limits, retries, fallback model) with Google's
// servers replaced by a fake fetch, so no API key or network is needed.
process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MODEL = 'main-model';
process.env.GEMINI_FALLBACK_MODEL = 'backup-model';
process.env.GEMINI_FIRST_CHUNK_TIMEOUT_MS = '300';
process.env.GEMINI_TOTAL_TIMEOUT_MS = '800';
process.env.GEMINI_RETRY_ATTEMPTS = '1'; // no retry delays in tests

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { streamReply } = require('../src/chat/gemini');

const opts = (signal) => ({ history: [{ role: 'user', content: 'hi' }], systemInstruction: 'SYS', signal });

let requests;
let behavior; // (model) => Response | 'hang' | 'stall'
beforeEach(() => { requests = []; });

const sse = (texts) => texts.map((t) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: t }] } }] })}\r\n\r\n`).join('');
const overloaded = () => new Response(JSON.stringify({ error: { code: 503, message: 'high demand', status: 'UNAVAILABLE' } }), { status: 503 });

globalThis.fetch = async (url, init) => {
  const model = String(url).match(/models\/([^:]+):/)[1];
  requests.push(model);
  const result = behavior(model);
  const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

  if (result === 'hang') { // never answers at all
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(abortError())));
  }
  if (result === 'stall') { // starts replying, then goes silent
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse(['Partial '])));
        init.signal.addEventListener('abort', () => c.error(abortError()));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return result;
};

async function collect(signal) {
  let text = '';
  for await (const t of streamReply(opts(signal))) text += t;
  return text;
}

test('normal reply streams from the main model', async () => {
  behavior = () => new Response(sse(['Hello ', 'there']), { status: 200 });
  assert.equal(await collect(), 'Hello there');
  assert.deepEqual(requests, ['main-model']);
});

test('a reply that hits the length limit says it was cut short', async () => {
  const body = `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Long answer that stops mid' }] }, finishReason: 'MAX_TOKENS' }] })}\r\n\r\n`;
  behavior = () => new Response(body, { status: 200 });
  const text = await collect();
  assert.ok(text.startsWith('Long answer that stops mid'));
  assert.match(text, /cut short/);
});

test('falls back to the backup model when the main one is overloaded', async () => {
  behavior = (model) => (model === 'main-model' ? overloaded() : new Response(sse(['From backup']), { status: 200 }));
  assert.equal(await collect(), 'From backup');
  assert.deepEqual(requests, ['main-model', 'backup-model']);
});

test('gives up with status 503 when both models are overloaded', async () => {
  behavior = () => overloaded();
  await assert.rejects(collect(), (err) => err.status === 503);
  assert.deepEqual(requests, ['main-model', 'backup-model']);
});

test('a model that never answers times out, then the backup is tried', async () => {
  behavior = (model) => (model === 'main-model' ? 'hang' : new Response(sse(['Backup answered']), { status: 200 }));
  const start = Date.now();
  assert.equal(await collect(), 'Backup answered');
  assert.ok(Date.now() - start < 1000, 'did not wait forever');
});

test('if nothing answers, it fails with 504 instead of hanging', async () => {
  behavior = () => 'hang';
  const start = Date.now();
  await assert.rejects(collect(), (err) => err.status === 504);
  assert.ok(Date.now() - start < 1500, `took ${Date.now() - start}ms`);
});

test('a reply that stalls halfway fails with 504 and does not switch models', async () => {
  behavior = () => 'stall';
  let text = '';
  await assert.rejects(async () => { for await (const t of streamReply(opts())) text += t; }, (err) => err.status === 504);
  assert.equal(text, 'Partial ');
  assert.deepEqual(requests, ['main-model'], 'no fallback once text was sent');
});

test('when the user leaves, it stops without trying the backup', async () => {
  behavior = () => 'hang';
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(collect(controller.signal), (err) => err.status !== 504);
  assert.deepEqual(requests, ['main-model']);
});

test('other errors (e.g. bad API key) are not retried on the backup', async () => {
  behavior = () => new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid', status: 'INVALID_ARGUMENT' } }), { status: 400 });
  await assert.rejects(collect(), (err) => err.status === 400);
  assert.deepEqual(requests, ['main-model']);
});
