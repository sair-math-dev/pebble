import assert from 'node:assert/strict';
import test from 'node:test';
import type { Registry } from '../src/registry.js';
import { createServer } from '../src/server.js';

test('HTTP plugins enforce read/write limits before handlers and ignore untrusted forwarding headers',async () => {
  const previous=process.env.TRUST_PROXY_CIDRS;
  delete process.env.TRUST_PROXY_CIDRS;
  let calls=0;
  // Only the HTTP middleware is under test; no proof or publication result is
  // synthesized. Invitation integration separately exercises real PostgreSQL.
  const registry={request:async () => {calls++;return {status:200,body:{transport_test:true}};}} as unknown as Registry;
  const app=createServer(registry);
  app.log.level='silent';
  try {
    for (let i=0;i<180;i++) {
      const response=await app.inject({method:'GET',url:`/api/v1/meta?probe=${i}`});
      assert.equal(response.statusCode,200);
      assert.equal(response.headers['x-content-type-options'],'nosniff','Helmet hooks must also be active');
    }
    const readRejected=await app.inject({method:'GET',url:'/api/v1/meta?different=1',headers:{'x-forwarded-for':'192.0.2.1'}});
    assert.equal(readRejected.statusCode,429);
    assert.ok(readRejected.headers['retry-after']);
    assert.equal(calls,180);
    for (let i=0;i<30;i++) {
      assert.equal((await app.inject({method:'POST',url:`/api/v1/packages?probe=${i}`,payload:{name:'middleware-test'}})).statusCode,200);
    }
    assert.equal((await app.inject({method:'POST',url:'/api/v1/packages?different=2',payload:{},headers:{'x-forwarded-for':'192.0.2.2'}})).statusCode,429);
    assert.equal(calls,210,'Rejected requests must never reach registry handlers');
    assert.equal((await app.inject({method:'GET',url:'/health/live'})).statusCode,200);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.TRUST_PROXY_CIDRS; else process.env.TRUST_PROXY_CIDRS=previous;
  }
});
