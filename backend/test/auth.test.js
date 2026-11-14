process.env.DB_FILE = ':memory:';
process.env.AUTH_RATE_LIMIT = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}/api/auth`;
});
after(() => server.close());

const post = (path, body, cookie) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
    body: JSON.stringify(body ?? {}),
  });
const me = (cookie) => fetch(base + '/me', { headers: cookie ? { cookie } : {} });
const sid = (res) => res.headers.get('set-cookie')?.split(';')[0];

test('signup -> me -> logout -> login', async () => {
  const signup = await post('/signup', { email: 'Ada@Example.com', password: 'supersecret', name: 'Ada' });
  assert.equal(signup.status, 201);
  const cookie = sid(signup);
  assert.match(signup.headers.get('set-cookie'), /HttpOnly/i);

  const who = await me(cookie);
  assert.equal(who.status, 200);
  assert.equal((await who.json()).user.email, 'ada@example.com');

  assert.equal((await post('/logout', {}, cookie)).status, 200);
  assert.equal((await me(cookie)).status, 401, 'old session is invalid after logout');

  const login = await post('/login', { email: 'ada@example.com', password: 'supersecret' });
  assert.equal(login.status, 200);
  assert.equal((await me(sid(login))).status, 200);
});

test('rejects wrong password and unknown email with the same message', async () => {
  await post('/signup', { email: 'bob@example.com', password: 'correcthorse' });
  const wrong = await post('/login', { email: 'bob@example.com', password: 'nope-nope' });
  const unknown = await post('/login', { email: 'nobody@example.com', password: 'whatever1' });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
});

test('validates signup input and blocks duplicates', async () => {
  assert.equal((await post('/signup', { email: 'bad', password: 'longenough' })).status, 400);
  assert.equal((await post('/signup', { email: 'c@example.com', password: 'short' })).status, 400);
  assert.equal((await post('/signup', { email: 'c@example.com', password: 'longenough' })).status, 201);
  assert.equal((await post('/signup', { email: 'C@example.com', password: 'longenough' })).status, 409);
});

test('me without a cookie is 401', async () => {
  assert.equal((await me()).status, 401);
});
