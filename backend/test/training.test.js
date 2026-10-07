// Model training is disabled by default and enforced by the backend.
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, registerSeller } = require('./helpers');

let ctx, a;
before(async () => {
  ctx = await setup();
  a = await registerSeller(ctx.api, 'a@test.com');
});
after(async () => { await ctx.teardown(); });
beforeEach(() => ctx.ml.reset());
afterEach(() => { delete process.env.MANUAL_FINETUNE_ENABLED; });

test('starting training is refused and never reaches the ML server', async () => {
  for (const path of ['/finetune', '/store/finetune']) {
    const res = await ctx.api('POST', path, { token: a.token, json: {} });
    assert.equal(res.status, 403, path);
    assert.equal(res.body.error, 'training_disabled');
  }
  assert.equal(ctx.ml.calls.length, 0);
});

test('training status still works and says training is disabled', async () => {
  for (const path of ['/finetune/status', '/store/finetune/status']) {
    const res = await ctx.api('GET', path, { token: a.token });
    assert.equal(res.status, 200, path);
    assert.equal(res.body.training_enabled, false);
    assert.equal(res.body.status, 'idle', 'status from the ML server is preserved');
  }
});

test('training can only be re-enabled explicitly through configuration', async () => {
  process.env.MANUAL_FINETUNE_ENABLED = 'true';
  const res = await ctx.api('POST', '/finetune', { token: a.token, json: {} });
  assert.equal(res.status, 200);
  assert.equal(ctx.ml.calls.filter(c => c.url === '/finetune').length, 1);
  const status = await ctx.api('GET', '/finetune/status', { token: a.token });
  assert.equal(status.body.training_enabled, true);
});

test('training endpoints still require login', async () => {
  assert.equal((await ctx.api('POST', '/finetune', { json: {} })).status, 401);
  assert.equal((await ctx.api('GET', '/finetune/status')).status, 401);
});
