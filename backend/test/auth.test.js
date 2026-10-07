const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, registerSeller, signToken } = require('./helpers');

let ctx;
before(async () => { ctx = await setup(); });
after(async () => { await ctx.teardown(); });

test('register creates an account and returns a token', async () => {
  const res = await ctx.api('POST', '/auth/register', { json: { name: 'Ali', email: 'ali@test.com', password: 'secret123' } });
  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(res.body.user.email, 'ali@test.com');
  assert.equal(res.body.user.role, 'seller');
  assert.equal(res.body.user.password, undefined, 'password hash must never be returned');
});

test('register rejects a duplicate email and missing fields', async () => {
  await registerSeller(ctx.api, 'dup@test.com');
  const dup = await ctx.api('POST', '/auth/register', { json: { email: 'dup@test.com', password: 'other123' } });
  assert.equal(dup.status, 409);
  const missing = await ctx.api('POST', '/auth/register', { json: { email: 'x@test.com' } });
  assert.equal(missing.status, 400);
});

test('login succeeds with the right password and fails otherwise', async () => {
  await registerSeller(ctx.api, 'login@test.com');
  const ok = await ctx.api('POST', '/auth/login', { json: { email: 'login@test.com', password: 'secret123' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  const wrong = await ctx.api('POST', '/auth/login', { json: { email: 'login@test.com', password: 'nope' } });
  assert.equal(wrong.status, 401);
  const unknown = await ctx.api('POST', '/auth/login', { json: { email: 'ghost@test.com', password: 'secret123' } });
  assert.equal(unknown.status, 401);
});

test('protected routes reject missing, invalid and expired tokens', async () => {
  for (const path of ['/products', '/sales', '/data/versions', '/forecast/1', '/dashboard/stats', '/data/quality']) {
    const none = await ctx.api('GET', path);
    assert.equal(none.status, 401, `${path} without token`);
    const bad = await ctx.api('GET', path, { token: 'not-a-token' });
    assert.equal(bad.status, 401, `${path} with invalid token`);
  }
  const expired = signToken({ id: 1, email: 'e@test.com', role: 'seller' }, { expiresIn: -10 });
  const res = await ctx.api('GET', '/products', { token: expired });
  assert.equal(res.status, 401);
});
