import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import pg from 'pg';
import { Registry } from '../src/registry.js';
import { createServer } from '../src/server.js';
import { objectStoreFromEnvironment, type ObjectStore } from '../src/object-store.js';
import { loadToolchain } from '../src/toolchain.js';
import { DEFAULT_POLICY, digestBytes, policyDigest, snapshotDigest, toolchainDigest, type Bundle } from '../src/protocol.js';

const environmentFile = process.env.PEBBLE_TEST_ENV ?? '.artifacts/test-env.json';
const toolchainDirectory = process.env.PEBBLE_TEST_TOOLCHAIN ?? '.artifacts/toolchain-pinned';
const available = existsSync(environmentFile) && existsSync(`${toolchainDirectory}/toolchain.json`);
function deferred() {
  let resolve:()=>void = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise,resolve};
}

test('real HTTP aborts retain active S3 admission and release unused body slots', {
  skip:available ? false : 'Set PEBBLE_TEST_ENV and PEBBLE_TEST_TOOLCHAIN for integration services',timeout:20_000,
},async () => {
  const env = JSON.parse(await readFile(environmentFile,'utf8')) as Record<string,string>;
  Object.assign(process.env,env);
  const basePool = new pg.Pool({connectionString:env.DATABASE_URL});
  const schema = 'admission_test_' + randomUUID().replaceAll('-','');
  await basePool.query(`CREATE SCHEMA "${schema}"`);
  const databaseUrl = new URL(env.DATABASE_URL!);
  databaseUrl.searchParams.set('options',`-c search_path=${schema}`);
  const store = objectStoreFromEnvironment();
  const hold = deferred();
  const twoBlocked = deferred();
  let holding = true;
  let startedReads = 0;
  const objectStore:ObjectStore = {
    put:(digest,bytes) => store.put(digest,bytes),has:digest => store.has(digest),healthy:()=>store.healthy(),
    get:async digest => {
      const bytes = await store.get(digest);
      if (holding) { startedReads++; if (startedReads === 2) twoBlocked.resolve(); await hold.promise; }
      return bytes;
    },
  };
  const toolchain = await loadToolchain(toolchainDirectory);
  const registry = new Registry({databaseUrl:databaseUrl.toString(),registryId:randomUUID(),toolchain,policy:DEFAULT_POLICY,
    toolchainDigest:toolchainDigest(toolchain),policyDigest:policyDigest(DEFAULT_POLICY),objectStore});
  const token = randomUUID()+randomUUID();
  let app:ReturnType<typeof createServer>|undefined;
  try {
    await registry.initialize({migrate:true});
    await registry.provisionPrincipal({name:'admission-test-owner',token});
    const created = await registry.request('POST','/api/v1/packages',{name:'admission/'+randomUUID()},token,{'idempotency-key':randomUUID()});
    assert.equal(created.status,201);
    const packageId = (created.body as {id:string}).id;
    const bytes = Buffer.from('// This fixture exercises source transport admission; it claims no mathematical acceptance.\n');
    const sha256 = digestBytes(bytes);
    const bundle:Bundle = {snapshot:{schema:'Pebble.PackageSnapshot.v1',package_id:packageId,version:'0.1.0',toolchain_digest:toolchainDigest(toolchain),dependencies:[],
      files:[{path:'fixture.slate',sha256,byte_length:bytes.length}],research:{title:'HTTP admission fixture',summary:'Transport lifecycle regression only.',license:'CC0-1.0',authors:['Test fixture'],formalizers:['Test fixture'],maintainers:['Test fixture'],kind:'formalization',claims:'No mathematical acceptance claimed',assumptions:'No check or publication is requested',citations:[],usage:'Private source transport test'}},
      blobs:[{sha256,content_base64:bytes.toString('base64')}]};
    const uploaded = await registry.request('POST',`/api/v1/packages/${packageId}/snapshots`,bundle,token,{'idempotency-key':randomUUID()});
    assert.equal(uploaded.status,201);
    const path = `/api/v1/packages/${packageId}/snapshots/${snapshotDigest(bundle.snapshot)}`;
    app = createServer(registry);
    const disconnected = deferred();
    const workSettled = deferred();
    const bodyAborted = deferred();
    const bodyRequestsSeen = deferred();
    let serverClosed = 0;
    let completedHandlers = 0;
    let bodyCloseCount = 0;
    let bodyRequestCount = 0;
    app.addHook('onRequest',async (request,reply) => {
      if (request.url === path) reply.raw.once('close',() => { serverClosed++; if (serverClosed === 2) disconnected.resolve(); });
      if (request.url.endsWith('/snapshots?partial=1')) {
        bodyRequestCount++; if (bodyRequestCount === 2) bodyRequestsSeen.resolve();
        reply.raw.once('close',() => { bodyCloseCount++; if (bodyCloseCount === 2) bodyAborted.resolve(); });
      }
    });
    // The underlying registry operation continues even when its HTTP transport
    // is gone. Observe actual settlement to avoid timing-based assertions.
    const originalRequest = registry.request.bind(registry);
    registry.request = async (...args:Parameters<Registry['request']>) => {
      try { return await originalRequest(...args); }
      finally { if (args[1] === path && startedReads >= 2) { completedHandlers++; if (completedHandlers === 2) workSettled.resolve(); } }
    };
    const address = await app.listen({host:'127.0.0.1',port:0});
    const headers = {authorization:`Bearer ${token}`};
    const first = httpRequest(address+path,{headers}); first.on('error',()=>{}); first.end();
    const second = httpRequest(address+path,{headers}); second.on('error',()=>{}); second.end();
    await twoBlocked.promise;
    first.destroy(); second.destroy();
    await disconnected.promise;
    const rejected = await fetch(address+path,{headers});
    assert.equal(rejected.status,503); assert.equal(rejected.headers.get('retry-after'),'1');
    await rejected.arrayBuffer();
    assert.equal(startedReads,2,'Disconnected handlers still consume the two S3 work slots');
    assert.equal((await fetch(address+'/health/live')).status,200);
    holding = false; hold.resolve();
    await workSettled.promise;
    // Let the server handler's finally run after the observed registry finally.
    await new Promise<void>(resolve=>setImmediate(resolve));
    const restored = await fetch(address+path,{headers});
    assert.equal(restored.status,200); await restored.arrayBuffer();

    // Two requests aborted during body parsing have never started registry/S3
    // work, so their unused admission slots must be returned immediately.
    const port = Number(new URL(address).port);
    const partial = () => {
      const socket = connect(port,'127.0.0.1'); socket.on('error',()=>{});
      socket.on('connect',() => socket.write(`POST /api/v1/packages/${packageId}/snapshots?partial=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nIdempotency-Key: ${randomUUID()}\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{`));
      return socket;
    };
    const partialA = partial(); const partialB = partial();
    await bodyRequestsSeen.promise;
    partialA.destroy(); partialB.destroy();
    await bodyAborted.promise;
    const afterBodyAbort = await fetch(address+path,{headers});
    assert.equal(afterBodyAbort.status,200); await afterBodyAbort.arrayBuffer();
  } finally {
    holding = false; hold.resolve();
    if (app) await app.close();
    await registry.close();
    await basePool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await basePool.end();
  }
});
