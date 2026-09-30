import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const apiSource = fs.readFileSync(
  path.resolve('public/js/api.js'), 'utf8'
);

function browserContext() {
  const storage = new Map();
  const listeners = new Map();
  const navigator = { onLine: false };
  const window = {
    navigator,
    listeners,
    addEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || new Set()).add(fn) || listeners.get(type));
    },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) || []) fn(event);
      return true;
    },
    CustomEvent: class {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    },
  };
  const ctx = {
    window,
    navigator,
    console,
    setTimeout,
    crypto: { randomUUID: () => 'stable-test-uuid' },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    fetch: async () => { throw new Error('fetch should not be called while offline'); },
  };
  window.ctx = ctx;
  vm.createContext(ctx);
  vm.runInNewContext(apiSource, ctx);
  return ctx;
}

test('断网时写操作进入发件箱；同一动作只排队一次，恢复后带幂等键重放', async () => {
  const ctx = browserContext();
  let calls = 0;
  let lastHeaders;

  await assert.rejects(
    () => ctx.window.ICH.mutate('POST', '/api/bookings/sessions/s1/holds',
      { name: '离线学员', contact: 'offline@example.com' },
      { keySeed: 'hold:s1:offline@example.com' }),
    (err) => err.code === 'OFFLINE_QUEUED'
  );

  await assert.rejects(
    () => ctx.window.ICH.mutate('POST', '/api/bookings/sessions/s1/holds',
      { name: '离线学员', contact: 'offline@example.com' },
      { keySeed: 'hold:s1:offline@example.com' }),
    (err) => err.code === 'OFFLINE_QUEUED'
  );

  const outbox = JSON.parse(ctx.localStorage.getItem('ich.outbox.v1'));
  assert.equal(outbox.length, 1);

  ctx.navigator.onLine = true;
  ctx.fetch = async (_url, options) => {
    calls += 1;
    lastHeaders = options.headers;
    return {
      ok: true,
      status: 201,
      headers: { get: () => null },
      json: async () => ({ outcome: 'held', hold: { id: 'h1' } }),
    };
  };

  const result = await ctx.window.ICH.flush();
  assert.equal(result.sent, 1);
  assert.equal(calls, 1);
  assert.ok(lastHeaders['Idempotency-Key']);
  assert.equal(JSON.parse(ctx.localStorage.getItem('ich.outbox.v1')).length, 0);
});
