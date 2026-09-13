import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { Registry, type ApiResponse, type JobLease, type JobResult } from '../src/registry.js';
import { createServer } from '../src/server.js';
import { objectStoreFromEnvironment, type ObjectStore } from '../src/object-store.js';
import { DEFAULT_POLICY, digestBytes, snapshotDigest, policyDigest, toolchainDigest, type Bundle, type Dependency, type Research } from '../src/protocol.js';
import { VerificationWorker } from '../src/worker.js';

const environmentFile = process.env.PEBBLE_TEST_ENV ?? '.artifacts/test-env.json';
const toolchainDirectory = process.env.PEBBLE_TEST_TOOLCHAIN ?? '.artifacts/toolchain-pinned';
const available = existsSync(environmentFile) && existsSync(`${toolchainDirectory}/toolchain.json`);
function response<T>(result: ApiResponse, status = 200): T {
  assert.equal(result.status,status,JSON.stringify(result.body));
  return result.body as T;
}
type Candidate = {id:string;revision:number;status:string};
type Release = {id:string;version:string;snapshot_digest:string;withdrawn:boolean;verification_revoked:boolean};

test('registry invariants with real PostgreSQL, S3, and isolated Slate', {skip:available ? false : 'Set PEBBLE_TEST_ENV and PEBBLE_TEST_TOOLCHAIN for integration services'}, async t => {
  const env = JSON.parse(await readFile(environmentFile,'utf8')) as Record<string,string>;
  Object.assign(process.env,env);
  const basePool = new pg.Pool({connectionString:env.DATABASE_URL});
  const schema = 'registry_test_' + randomUUID().replaceAll('-','');
  await basePool.query(`CREATE SCHEMA "${schema}"`);
  const databaseUrl = new URL(env.DATABASE_URL!);
  databaseUrl.searchParams.set('options',`-c search_path=${schema}`);
  const worker = new VerificationWorker(resolve(toolchainDirectory),DEFAULT_POLICY);
  const toolchain = await worker.initialize();
  const objectStore = objectStoreFromEnvironment();
  let failPublication = false;
  let downloadHook: (() => Promise<void>) | undefined;
  let holdDownloads: (() => Promise<void>) | undefined;
  const controlledStore:ObjectStore = {
    put:(digest,bytes) => objectStore.put(digest,bytes),
    has:digest => objectStore.has(digest),
    healthy:() => objectStore.healthy(),
    get:async digest => { const bytes = await objectStore.get(digest); if (holdDownloads) await holdDownloads(); if (downloadHook) { const hook = downloadHook; downloadHook = undefined; await hook(); } return bytes; },
  };
  const registry = new Registry({databaseUrl:databaseUrl.toString(),registryId:randomUUID(),toolchain,
    policy:DEFAULT_POLICY,toolchainDigest:toolchainDigest(toolchain),policyDigest:policyDigest(DEFAULT_POLICY),
    objectStore:controlledStore,leaseSeconds:120,
    beforePublishCommit:async () => { if (failPublication) throw new Error('Injected publication failure'); },
  });
  await registry.initialize({migrate:true});
  const ownerToken = randomUUID() + randomUUID();
  const memberToken = randomUUID() + randomUUID();
  const outsiderToken = randomUUID() + randomUUID();
  const owner = await registry.provisionPrincipal({name:'test-owner',token:ownerToken});
  const member = await registry.provisionPrincipal({name:'test-member',token:memberToken});
  await registry.provisionPrincipal({name:'test-outsider',token:outsiderToken});
  const request = (method:string,path:string,body:unknown={},token:string|undefined=ownerToken,headers:Record<string,string>={}) =>
    registry.request(method,path,body,token,{'idempotency-key':randomUUID(),...headers});
  const research:Research = {title:'Test fixture: group inverse results',summary:'Existing mathematical results formalized for registry integration tests.',
    license:'Apache-2.0',authors:['Existing mathematical literature'],formalizers:['Slate project contributors','Pebble fixture contributors'],maintainers:['Test owner'],kind:'formalization',
    claims:'Group inverse identities',assumptions:'Explicit group theory axioms',citations:[],usage:'Import the exact pinned module and rebuild with Slate.'};
  const fixture = async (id:string,version='0.1.0',kind='algebra-provider',dependencies:Dependency[]=[]):Promise<Bundle> => {
    const paths = ['LICENSE.txt', ...(kind === 'algebra-provider' ? ['src/inverses.slate','theory/group.slate'] : kind === 'algebra-consumer' ? ['src/involution.slate'] : ['src/transport.slate','theory/sets.slate'])];
    const blobs = [];
    const files = [];
    for (const path of paths) {
      const bytes = await readFile(path === 'LICENSE.txt' ? 'experiments/fixtures/package-reuse/LICENSE' : `experiments/fixtures/package-reuse/${kind}/${path}`);
      const sha256 = digestBytes(bytes);
      files.push({path,sha256,byte_length:bytes.length});
      blobs.push({sha256,content_base64:bytes.toString('base64')});
    }
    const metadata = kind === 'set-membership' ? {...research,title:'Test fixture: set membership substitution',claims:'Equality substitution preserves membership',assumptions:'Set and member symbols; no nonlogical axioms'} : research;
    return {snapshot:{schema:'Pebble.PackageSnapshot.v1',package_id:id,version,toolchain_digest:toolchainDigest(toolchain),dependencies,files,research:metadata},blobs};
  };
  const newPackage = async (name:string = randomUUID()) => response<{id:string}>(await request('POST','/api/v1/packages',{name:'test/'+name}),201).id;
  const upload = async (bundle:Bundle) => response<{snapshot_digest:string}>(await request('POST',`/api/v1/packages/${bundle.snapshot.package_id}/snapshots`,bundle),201).snapshot_digest;
  const candidateFor = async (bundle:Bundle,token=ownerToken) => {
    await upload(bundle);
    return response<Candidate>(await request('POST',`/api/v1/packages/${bundle.snapshot.package_id}/candidates`,{snapshot_digest:snapshotDigest(bundle.snapshot)},token),202);
  };
  const current = async (candidate:Candidate,token=ownerToken) => response<Candidate>(await request('GET',`/api/v1/candidates/${candidate.id}`,{},token));
  const check = async (candidate:Candidate):Promise<JobLease> => {
    const lease = await registry.claimJob(); assert.ok(lease); assert.equal(lease.candidate_id,candidate.id);
    const result = await worker.verify(lease); assert.equal(result.outcome,'passed',JSON.stringify(result));
    assert.equal(await registry.completeJob(lease,result),true);
    return lease;
  };
  const review = async (candidate:Candidate,confirmed=true) => response<Candidate>(await request('POST',`/api/v1/candidates/${candidate.id}/review`,
    {approved:true,note:'Reviewed immutable research metadata, attribution, explicit assumptions, and source classification.',source_classification_confirmed:confirmed}));
  const publish = async (candidate:Candidate,headers:Record<string,string>={}) => request('POST',`/api/v1/candidates/${candidate.id}/publish`,{},ownerToken,{'if-match':`"${candidate.revision}"`,...headers});
  const makeRelease = async (bundle:Bundle) => {
    const candidate = await candidateFor(bundle); await check(candidate); const reviewed = await review(candidate);
    return response<Release>(await publish(reviewed),201);
  };
  let providerId = '';
  let providerBundle:Bundle;
  let providerRelease:Release;
  try {
    await t.test('private staging, real formal check, explicit review, rollback, and immutable publication',async () => {
      providerId = await newPackage('provider'); providerBundle = await fixture(providerId);
      const digest = await upload(providerBundle);
      response(await request('GET',`/api/v1/packages/${providerId}/snapshots/${digest}`,{},outsiderToken),403);
      response(await request('PUT',`/api/v1/packages/${providerId}/visibility`,{visibility:'public'}));
      response(await registry.request('GET',`/api/v1/packages/${providerId}/snapshots/${digest}`),404);
      const candidate = await candidateFor(providerBundle); await check(candidate);
      response(await publish(await current(candidate)),409);
      response(await publish(await review(candidate,false)),409);
      const reviewed = await review(candidate);
      response(await publish(candidate),412);
      failPublication = true;
      await assert.rejects(publish(reviewed),/Injected publication failure/);
      failPublication = false;
      const counts = (await registry.db.pool.query<{releases:string;events:string}>(`SELECT
        (SELECT count(*) FROM releases WHERE package_id=$1) AS releases,
        (SELECT count(*) FROM outbox_events WHERE kind='release.published') AS events`,[providerId])).rows[0]!;
      assert.deepEqual(counts,{releases:'0',events:'0'});
      const key = randomUUID();
      providerRelease = response<Release>(await publish(reviewed,{'idempotency-key':key}),201);
      assert.deepEqual(response(await publish(reviewed,{'idempotency-key':key}),201),providerRelease);
      response(await request('POST',`/api/v1/candidates/${candidate.id}/publish`,{unexpected:true},ownerToken,{'idempotency-key':key,'if-match':`"${reviewed.revision}"`}),409);
      const downloaded = response<Bundle>(await registry.request('GET',`/api/v1/packages/${providerId}/snapshots/${digest}`));
      assert.equal(snapshotDigest(downloaded.snapshot),digest);
      const replacement = structuredClone(providerBundle); replacement.snapshot.research.summary += ' Revised.';
      response(await request('POST',`/api/v1/packages/${providerId}/snapshots`,replacement),409);
      await assert.rejects(registry.db.pool.query('UPDATE snapshots SET version=$1 WHERE digest=$2',['9.9.9',digest]),/immutable registry record/);
    });

    await t.test('two real checked candidates contest one version, with no partial duplicate release',async () => {
      const id = await newPackage('race');
      const a = await fixture(id); const b = structuredClone(a); b.snapshot.research.summary += ' Separate immutable candidate.';
      const ca = await candidateFor(a); await check(ca); const ra = await review(ca);
      const cb = await candidateFor(b); await check(cb); const rb = await review(cb);
      const results = await Promise.all([publish(ra),publish(rb)]);
      assert.deepEqual(results.map(result => result.status).sort(),[201,409]);
      const count = (await registry.db.pool.query<{count:string}>('SELECT count(*) FROM releases WHERE package_id=$1',[id])).rows[0]!.count;
      assert.equal(count,'1');
    });

    await t.test('same concurrent idempotent publication returns one stable release',async () => {
      const id = await newPackage('same-request');
      const candidate = await candidateFor(await fixture(id)); await check(candidate); const reviewed = await review(candidate);
      const key = randomUUID();
      const results = await Promise.all([publish(reviewed,{'idempotency-key':key}),publish(reviewed,{'idempotency-key':key})]);
      assert.equal(results[0]!.status,201,JSON.stringify(results));
      assert.equal(results[1]!.status,201,JSON.stringify(results));
      assert.deepEqual(results[0]!.body,results[1]!.body);
    });

    await t.test('query strings cannot bypass object preparation before snapshot registration',async () => {
      const id = await newPackage('query-upload'); const bundle = await fixture(id);
      const bytes = Buffer.from(`Unique attachment for ${randomUUID()}`); const sha256 = digestBytes(bytes);
      assert.equal(await objectStore.has(sha256),false);
      bundle.snapshot.files.push({path:'unique.txt',sha256,byte_length:bytes.length});
      bundle.blobs.push({sha256,content_base64:bytes.toString('base64')});
      response(await request('POST',`/api/v1/packages/${id}/snapshots?x=1`,bundle),201);
      assert.equal(await objectStore.has(sha256),true);
      response(await request('GET',`/api/v1/packages/${id}/snapshots/${snapshotDigest(bundle.snapshot)}`));
    });

    await t.test('heavy HTTP admission rejects overload before parsing and recovers after response',async () => {
      const app = createServer(registry);
      let releaseDownloads:()=>void = () => {};
      let twoReached:()=>void = () => {};
      const held = new Promise<void>(resolve=>{releaseDownloads=resolve;});
      const twoBlocked = new Promise<void>(resolve=>{twoReached=resolve;});
      let blocked = 0;
      holdDownloads = async () => { blocked++; if (blocked === 2) twoReached(); await held; };
      const url = `/api/v1/packages/${providerId}/snapshots/${providerRelease.snapshot_digest}`;
      const first = app.inject({method:'GET',url});
      const second = app.inject({method:'GET',url});
      try {
        await twoBlocked;
        const overloaded = await app.inject({method:'GET',url});
        assert.equal(overloaded.statusCode,503); assert.equal(overloaded.headers['retry-after'],'1');
        assert.equal((await app.inject({method:'GET',url:'/health/live'})).statusCode,200);
      } finally { holdDownloads=undefined; releaseDownloads(); }
      assert.equal((await first).statusCode,200); assert.equal((await second).statusCode,200);
      assert.equal((await app.inject({method:'GET',url})).statusCode,200);
      await app.close();
    });

    await t.test('exact dependency checks, private graph protection, and independent theory publication',async () => {
      const consumerId = await newPackage('consumer');
      const dependencies = [{package_id:providerId,version:'0.1.0',snapshot_digest:providerRelease.snapshot_digest}];
      const consumer = await fixture(consumerId,'0.1.0','algebra-consumer',dependencies);
      response(await request('PUT',`/api/v1/packages/${consumerId}/visibility`,{visibility:'public'}));
      const release = await makeRelease(consumer);
      response(await registry.request('GET',`/api/v1/packages/${consumerId}/versions/0.1.0`));
      const substituted = structuredClone(consumer); substituted.snapshot.version = '0.2.0'; substituted.snapshot.dependencies[0]!.snapshot_digest = '0'.repeat(64);
      response(await request('POST',`/api/v1/packages/${consumerId}/snapshots`,substituted),409);
      response(await request('PUT',`/api/v1/packages/${providerId}/visibility`,{visibility:'private'}));
      response(await registry.request('GET',`/api/v1/packages/${consumerId}/snapshots/${release.snapshot_digest}`),401);
      const visible = response<{versions:unknown[]}>(await registry.request('GET',`/api/v1/packages/${consumerId}/versions`));
      assert.deepEqual(visible.versions,[]);
      response(await request('PUT',`/api/v1/packages/${providerId}/visibility`,{visibility:'public'}));
      const sets = await fixture(await newPackage('sets'),'0.1.0','set-membership');
      const setRelease = await makeRelease(sets);
      assert.ok(setRelease.id);
    });

    await t.test('revocation applies to saved responses and to downloads delayed in S3',async () => {
      const id = await newPackage('revoke'); const bundle = await fixture(id); await upload(bundle);
      response(await request('PUT',`/api/v1/packages/${id}/members/${member.id}`,{role:'maintainer'}));
      const key = randomUUID();
      const candidate = response<Candidate>(await request('POST',`/api/v1/packages/${id}/candidates`,{snapshot_digest:snapshotDigest(bundle.snapshot)},memberToken,{'idempotency-key':key}),202);
      const lease = await registry.claimJob(); assert.ok(lease);
      response(await request('DELETE',`/api/v1/packages/${id}/members/${member.id}`));
      response(await request('POST',`/api/v1/packages/${id}/candidates`,{snapshot_digest:snapshotDigest(bundle.snapshot)},memberToken,{'idempotency-key':key}),403);
      assert.equal(await registry.completeJob(lease,{outcome:'timeout',input_digest:lease.input_digest,toolchain_digest:lease.toolchain_digest,policy_digest:lease.policy_digest}),true);
      assert.equal((await current(candidate)).status,'error');
      response(await request('PUT',`/api/v1/packages/${id}/members/${member.id}`,{role:'viewer'}));
      downloadHook = async () => { response(await request('DELETE',`/api/v1/packages/${id}/members/${member.id}`)); };
      response(await request('GET',`/api/v1/packages/${id}/snapshots/${snapshotDigest(bundle.snapshot)}`,{},memberToken),403);
    });

    await t.test('full source coverage rejects hidden unimported bad theorem and foreign caches',async () => {
      const id = await newPackage('hidden-failure'); const bundle = await fixture(id);
      const bytes = Buffer.from('module Pebble.Fixtures.Unchecked\n    under Pebble.Fixtures.Algebra.Group\n    theorem FalseClaim(a : Element): a = one\n        a = one from missing_proof\n');
      const sha256 = digestBytes(bytes);
      bundle.snapshot.files.push({path:'.hidden/bad.slate',sha256,byte_length:bytes.length});
      bundle.snapshot.files.sort((a,b) => a.path < b.path ? -1 : 1);
      bundle.blobs.push({sha256,content_base64:bytes.toString('base64')});
      const candidate = await candidateFor(bundle); const lease = await registry.claimJob(); assert.ok(lease);
      const result = await worker.verify(lease); assert.equal(result.outcome,'incomplete',JSON.stringify(result));
      assert.equal(await registry.completeJob(lease,result),true);
      response(await publish(await review(candidate)),409);
      const poisoned = await fixture(id,'0.2.0');
      poisoned.snapshot.files[0]!.path = 'author.slatecache';
      response(await request('POST',`/api/v1/packages/${id}/snapshots`,poisoned),400);
    });

    await t.test('fixed transitive closure rejects two versions of one package before checking',async () => {
      const newProvider = await fixture(providerId,'0.2.0');
      const second = await makeRelease(newProvider);
      const branchAId = await newPackage('branch-a');
      const branchA = await fixture(branchAId,'0.1.0','algebra-consumer',[{package_id:providerId,version:'0.1.0',snapshot_digest:providerRelease.snapshot_digest}]);
      const a = await makeRelease(branchA);
      const branchBId = await newPackage('branch-b');
      const branchB = await fixture(branchBId,'0.1.0','set-membership',[{package_id:providerId,version:'0.2.0',snapshot_digest:second.snapshot_digest}]);
      const b = await makeRelease(branchB);
      const id = await newPackage('conflicting-root');
      const deps = [{package_id:branchAId,version:'0.1.0',snapshot_digest:a.snapshot_digest},{package_id:branchBId,version:'0.1.0',snapshot_digest:b.snapshot_digest}].sort((a,b)=>a.package_id.localeCompare(b.package_id));
      const root = await fixture(id,'0.1.0','set-membership',deps);
      const denied = await request('POST',`/api/v1/packages/${id}/snapshots`,root);
      assert.equal(response<{error:string}>(denied,409).error,'dependency_conflict');
    });

    await t.test('version pagination skips unreadable dependency graphs before applying page limits',async () => {
      const depId = await newPackage('pagination-dependency');
      response(await request('PUT',`/api/v1/packages/${depId}/visibility`,{visibility:'public'}));
      const dep = await makeRelease(await fixture(depId));
      const id = await newPackage('pagination-root');
      response(await request('PUT',`/api/v1/packages/${id}/visibility`,{visibility:'public'}));
      const first = await makeRelease(await fixture(id,'0.1.0','set-membership'));
      const hidden = await makeRelease(await fixture(id,'0.2.0','algebra-consumer',[{package_id:depId,version:'0.1.0',snapshot_digest:dep.snapshot_digest}]));
      const last = await makeRelease(await fixture(id,'0.3.0','set-membership'));
      response(await request('PUT',`/api/v1/packages/${depId}/visibility`,{visibility:'private'}));
      const page = response<{versions:Release[];next_cursor:string}>(await registry.request('GET',`/api/v1/packages/${id}/versions?limit=1`));
      assert.deepEqual(page.versions.map(version=>version.id),[first.id]); assert.equal(page.next_cursor,first.id);
      const next = response<{versions:Release[];next_cursor:null}>(await registry.request('GET',`/api/v1/packages/${id}/versions?limit=1&cursor=${page.next_cursor}`));
      assert.deepEqual(next.versions.map(version=>version.id),[last.id]); assert.equal(next.next_cursor,null);
      response(await registry.request('GET',`/api/v1/packages/${id}/versions?limit=1&cursor=${hidden.id}`),400);
    });

    await t.test('expired attempt fencing, timeout retry, fail-closed report fields, and no report upload route',async () => {
      const id = await newPackage('retry'); const candidate = await candidateFor(await fixture(id));
      const old = await registry.claimJob(); assert.ok(old);
      await registry.db.pool.query("UPDATE verification_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[old.id]);
      const fresh = await registry.claimJob(); assert.ok(fresh); assert.equal(fresh.attempt,old.attempt+1);
      const timeout = (lease:JobLease):JobResult => ({outcome:'timeout',input_digest:lease.input_digest,toolchain_digest:lease.toolchain_digest,policy_digest:lease.policy_digest});
      assert.equal(await registry.completeJob(old,timeout(old)),false);
      assert.equal(await registry.completeJob(fresh,timeout(fresh)),true);
      assert.equal((await current(candidate)).status,'timeout');
      response(await request('POST',`/api/v1/candidates/${candidate.id}/retry`),202);
      const invalid = await registry.claimJob(); assert.ok(invalid);
      assert.equal(await registry.completeJob(invalid,{...timeout(invalid),outcome:'passed',report:{complete:true,formal_checks_eligible:true}}),true);
      assert.equal((await current(candidate)).status,'error');
      response(await publish(await review(candidate)),409);
      response(await request('POST',`/api/v1/candidates/${candidate.id}/retry`),202);
      const alteredLease = await registry.claimJob(); assert.ok(alteredLease);
      const altered = await worker.verify(alteredLease); assert.equal(altered.outcome,'passed');
      const report = altered.report as {files:unknown[]}; report.files.pop();
      assert.equal(await registry.completeJob(alteredLease,altered),true);
      assert.equal((await current(candidate)).status,'error');
      const app = createServer(registry);
      const http = await app.inject({method:'POST',url:`/api/v1/candidates/${candidate.id}/report`,headers:{authorization:`Bearer ${ownerToken}`,'idempotency-key':randomUUID()},payload:{complete:true}});
      assert.equal(http.statusCode,404);
      assert.equal((await app.inject({method:'GET',url:'/health/ready'})).statusCode,200);
      await app.close();
    });

    await t.test('database queue quota and competing workers preserve bounded unique claims',async () => {
      const id = await newPackage('queue-quota'); const bundle = await fixture(id); await upload(bundle);
      const retryable = await candidateFor(bundle);
      const firstLease = await registry.claimJob(); assert.ok(firstLease);
      assert.equal(await registry.completeJob(firstLease,{outcome:'timeout',input_digest:firstLease.input_digest,toolchain_digest:firstLease.toolchain_digest,policy_digest:firstLease.policy_digest}),true);
      const path = `/api/v1/packages/${id}/candidates`;
      const requests = await Promise.all(Array.from({length:5},() => request('POST',path,{snapshot_digest:snapshotDigest(bundle.snapshot)})));
      assert.deepEqual(requests.map(result=>result.status).sort(),[202,202,202,202,429]);
      response(await request('POST',`/api/v1/candidates/${retryable.id}/retry`),429);
      const leases = await Promise.all(Array.from({length:4},() => registry.claimJob()));
      assert.equal(leases.filter(Boolean).length,4);
      assert.equal(new Set(leases.map(lease=>lease!.id)).size,4);
      for (const lease of leases) assert.equal(await registry.completeJob(lease!,{outcome:'timeout',input_digest:lease!.input_digest,toolchain_digest:lease!.toolchain_digest,policy_digest:lease!.policy_digest}),true);
    });

    await t.test('withdrawal and verification revocation preserve citations and prohibit new dependent selection',async () => {
      const base = `/api/v1/packages/${providerId}/versions/0.1.0`;
      const before = response<Release>(await request('GET',base));
      const withdrawn = response<Release>(await request('POST',base+'/withdrawals',{reason:'Integration fixture withdrawal'}));
      assert.equal(withdrawn.id,before.id); assert.equal(withdrawn.withdrawn,true);
      const revoked = response<Release>(await request('POST',base+'/revocations',{reason:'Integration fixture verification revocation'}));
      assert.equal(revoked.verification_revoked,true); assert.equal(revoked.snapshot_digest,before.snapshot_digest);
      response(await request('GET',`/api/v1/packages/${providerId}/snapshots/${before.snapshot_digest}`));
      const id = await newPackage('withdrawn-dependency');
      const bundle = await fixture(id,'0.1.0','algebra-consumer',[{package_id:providerId,version:'0.1.0',snapshot_digest:before.snapshot_digest}]);
      response(await request('POST',`/api/v1/packages/${id}/snapshots`,bundle),409);
      response(await request('GET',`/api/v1/packages/${providerId}/versions?limit=1`));
      response(await request('GET',`/api/v1/packages/${providerId}/versions?limit=10000`),400);
    });
  } finally {
    await registry.close();
    // Drop only the unique integration schema created by this test invocation.
    await basePool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await basePool.end();
  }
});
