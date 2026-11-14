const http = require('node:http');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// A fake spending service, so tests can check what the AI is told about the user's money.
let spendingCookies = [];
let spendingUp = true;
const spendingServer = http.createServer((req, res) => {
  spendingCookies.push(req.headers.cookie);
  if (!spendingUp) { res.writeHead(500); return res.end(); }
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/api/spending/summary/monthly')) {
    return res.end(JSON.stringify({ months: [
      { month: '2026-09', income: 0, expenses: 0, net: 0 },
      { month: '2026-10', income: 1200, expenses: 950, net: 250 },
      { month: '2026-11', income: 600, expenses: 420.5, net: 179.5 },
    ] }));
  }
  res.end(JSON.stringify({
    start: '2026-11-01', end: '2026-11-14', income: 600, expenses: 420.5, net: 179.5,
    expenses_by_category: [{ category: 'Food', total: 300.5, count: 9, percent: 71.5 }],
    income_by_category: [{ category: 'Part-time Job', total: 600, count: 2, percent: 100 }],
  }));
});

let server;
let base;

before(async () => {
  await new Promise((r) => spendingServer.listen(0, r));
  process.env.DB_FILE = ':memory:';
  process.env.AUTH_RATE_LIMIT = '1000';
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.SPENDING_URL = `http://127.0.0.1:${spendingServer.address().port}`;
  const app = require('../src/app');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}/api`;
});
after(() => { server.close(); spendingServer.close(); });

// Fake Gemini: records what it was asked, replies in chunks.
const gemini = require('../src/chat/gemini');
let calls;
let fakeReply;
beforeEach(() => {
  calls = [];
  spendingCookies = [];
  spendingUp = true;
  process.env.GEMINI_API_KEY = 'test-key';
  fakeReply = async function* () { yield 'Start with '; yield 'an emergency fund.'; };
  gemini.streamReply = (opts) => { calls.push(opts); return fakeReply(opts); };
});

let userCount = 0;
async function newUser(name = 'Ada') {
  const res = await fetch(`${base}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `user${++userCount}@example.com`, password: 'supersecret', name }),
  });
  return res.headers.get('set-cookie').split(';')[0];
}

const api = (cookie, path, { method = 'GET', body } = {}) =>
  fetch(base + path, {
    method,
    headers: { cookie, ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });

async function chat(cookie, body) {
  const res = await api(cookie, '/chat/messages', { method: 'POST', body });
  if (!res.headers.get('content-type')?.includes('ndjson')) return { res, json: await res.json() };
  const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  return { res, events, done: events.find((e) => e.type === 'done'), error: events.find((e) => e.type === 'error') };
}

test('chat requires login', async () => {
  const res = await fetch(`${base}/chat/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"hi"}',
  });
  assert.equal(res.status, 401);
  assert.equal((await fetch(`${base}/chat/conversations`)).status, 401);
});

test('new conversation streams the reply and saves it', async () => {
  const cookie = await newUser();
  const { res, events, done } = await chat(cookie, { message: '  How do I start saving?  ' });

  assert.equal(res.status, 200);
  assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.text), ['Start with ', 'an emergency fund.']);
  assert.equal(done.conversation.title, 'How do I start saving?');
  assert.deepEqual(done.messages.map((m) => [m.role, m.content]), [
    ['user', 'How do I start saving?'],
    ['model', 'Start with an emergency fund.'],
  ]);

  const list = await (await api(cookie, '/chat/conversations')).json();
  assert.equal(list.conversations.length, 1);
  const full = await (await api(cookie, `/chat/conversations/${done.conversation.id}`)).json();
  assert.equal(full.messages.length, 2);
});

test('follow-up messages send the earlier conversation to Gemini', async () => {
  const cookie = await newUser();
  const first = await chat(cookie, { message: 'What is an index fund?' });
  fakeReply = async function* () { yield 'Yes, for most beginners.'; };
  const second = await chat(cookie, { message: 'Is it good for beginners?', conversationId: first.done.conversation.id });

  assert.equal(second.done.conversation.id, first.done.conversation.id);
  assert.deepEqual(calls[1].history.map((m) => m.role), ['user', 'model', 'user']);
  assert.equal(calls[1].history[0].content, 'What is an index fund?');
  assert.equal(calls[1].history[2].content, 'Is it good for beginners?');
});

test('long titles are shortened', async () => {
  const cookie = await newUser();
  const { done } = await chat(cookie, { message: 'a'.repeat(100) });
  assert.equal(done.conversation.title.length, 60);
  assert.ok(done.conversation.title.endsWith('…'));
});

test('spending summary is shared with Gemini by default, and can be turned off', async () => {
  const cookie = await newUser('Grace');
  await chat(cookie, { message: 'How am I doing this month?' });

  const instruction = calls[0].systemInstruction;
  assert.match(instruction, /The user's name is Grace/);
  assert.match(instruction, /income \$600\.00, expenses \$420\.50, net \$179\.50/);
  assert.match(instruction, /Food \$300\.50 \(71\.5%\)/);
  assert.match(instruction, /2026-10: income \$1,200\.00/);
  assert.ok(spendingCookies.every((c) => c === cookie), 'login cookie is forwarded to the spending service');

  assert.deepEqual(await (await api(cookie, '/chat/settings')).json(), { shareSpending: true });
  const put = await api(cookie, '/chat/settings', { method: 'PUT', body: { shareSpending: false } });
  assert.deepEqual(await put.json(), { shareSpending: false });

  spendingCookies = [];
  await chat(cookie, { message: 'And now?' });
  assert.doesNotMatch(calls[1].systemInstruction, /\$600/);
  assert.match(calls[1].systemInstruction, /don't have access to the user's spending data/);
  assert.equal(spendingCookies.length, 0, 'spending service is not even asked');
});

test('chat still works when the spending service is down', async () => {
  const cookie = await newUser();
  spendingUp = false;
  const { done } = await chat(cookie, { message: 'Tips to save?' });
  assert.ok(done);
  assert.match(calls[0].systemInstruction, /don't have access to the user's spending data/);
});

test('a Gemini failure shows an error and saves nothing', async () => {
  const cookie = await newUser();
  fakeReply = async function* () { yield 'partial'; throw Object.assign(new Error('boom'), { status: 500 }); };
  const { error, done } = await chat(cookie, { message: 'Hello?' });
  assert.equal(done, undefined);
  assert.match(error.error, /couldn't answer/);
  assert.equal((await (await api(cookie, '/chat/conversations')).json()).conversations.length, 0);

  fakeReply = async function* () { throw Object.assign(new Error('quota'), { status: 429 }); };
  assert.match((await chat(cookie, { message: 'Hello?' })).error.error, /busy/);

  fakeReply = async function* () { throw Object.assign(new Error('timeout'), { status: 504 }); };
  assert.match((await chat(cookie, { message: 'Hello?' })).error.error, /took too long/);
});

test('rejects bad messages', async () => {
  const cookie = await newUser();
  assert.equal((await chat(cookie, { message: '   ' })).res.status, 400);
  assert.equal((await chat(cookie, {})).res.status, 400);
  assert.equal((await chat(cookie, { message: 'x'.repeat(2001) })).res.status, 400);
  assert.equal((await chat(cookie, { message: 'hi', conversationId: 99999 })).res.status, 404);
  assert.equal(calls.length, 0, 'Gemini is never called for rejected messages');
});

test('says clearly when the Gemini key is missing', async () => {
  const cookie = await newUser();
  delete process.env.GEMINI_API_KEY;
  const { res, json } = await chat(cookie, { message: 'hi' });
  assert.equal(res.status, 503);
  assert.match(json.error, /GEMINI_API_KEY/);
});

test('users cannot read, continue or delete each other\'s conversations', async () => {
  const ada = await newUser();
  const bob = await newUser('Bob');
  const { done } = await chat(ada, { message: 'My private question' });
  const id = done.conversation.id;

  assert.equal((await api(bob, `/chat/conversations/${id}`)).status, 404);
  assert.equal((await chat(bob, { message: 'hijack', conversationId: id })).res.status, 404);
  assert.equal((await api(bob, `/chat/conversations/${id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await (await api(bob, '/chat/conversations')).json()).conversations.length, 0);

  assert.equal((await api(ada, `/chat/conversations/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(ada, `/chat/conversations/${id}`)).status, 404);
});

test('settings validation', async () => {
  const cookie = await newUser();
  assert.equal((await api(cookie, '/chat/settings', { method: 'PUT', body: { shareSpending: 'no' } })).status, 400);
});
