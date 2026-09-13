import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { MemoryObjectStore } from '../src/object-store.js';
import { publicKey, type Registry } from '../src/registry.js';

function deferred() {
  let resolve:()=>void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise,resolve};
}

test('archive reads hold heavy admission slots, overload is refused before work starts, and the tree is read-only', {timeout:20_000}, async () => {
  const store = new MemoryObjectStore();
  const key = 'packages/base/1.0.0/base-1.0.0.slatepkg';
  await store.put(publicKey(key), Buffer.from('archive bytes'));
  await store.put(publicKey('index/config.json'), Buffer.from('{"dl":"x","api":"y"}'));
  const hold = deferred();
  const fourBlocked = deferred();
  let blocked = 0;
  let holding = true;
  const controlled = Object.create(store) as MemoryObjectStore;
  controlled.get = async (k: string) => {
    const bytes = await store.get(k);
    if (holding && k === publicKey(key)) { blocked++; if (blocked === 4) fourBlocked.resolve(); await hold.promise; }
    return bytes;
  };
  // Only HTTP admission and the read tree are under test; no registry state is touched.
  const registry = { options: { objectStore: controlled }, request: async () => ({ status: 200, body: {} }) } as unknown as Registry;
  const app = createServer(registry);
  app.log.level = 'silent';
  try {
    const url = `/static/${key}`;
    const held = [1, 2, 3, 4].map(() => app.inject({ method: 'GET', url }));
    await fourBlocked.promise;
    const overloaded = await app.inject({ method: 'GET', url });
    assert.equal(overloaded.statusCode, 503); assert.equal(overloaded.headers['retry-after'], '1');
    assert.equal((await app.inject({ method: 'GET', url: '/health/live' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/index/config.json' })).statusCode, 200, 'index reads are not heavy');
    holding = false; hold.resolve();
    for (const response of await Promise.all(held)) { assert.equal(response.statusCode, 200); assert.equal(response.body, 'archive bytes'); }
    const again = await app.inject({ method: 'GET', url });
    assert.equal(again.statusCode, 200);
    assert.equal(again.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal((await app.inject({ method: 'GET', url: '/static/packages/base/1.0.0/missing.slatepkg' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/static/../staging/x' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/index/3/b/bas' })).statusCode, 404, 'a missing index file is a 404, not an error');
    assert.equal((await app.inject({ method: 'PUT', url, payload: 'x' })).statusCode, 404, 'the read tree accepts no writes');
  } finally {
    await app.close();
  }
});
