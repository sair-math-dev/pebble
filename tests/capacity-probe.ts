/** Explicit local baseline, not a default test or a claim of 10,000 concurrent users.
 * Run: node_modules/.bin/tsx tests/capacity-probe.ts
 * Requires actual PostgreSQL, S3 and the prepared Slate toolchain used by integration tests.
 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, arch, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Registry } from '../src/registry.js';
import { createServer } from '../src/server.js';
import { objectStoreFromEnvironment } from '../src/object-store.js';
import { DEFAULT_POLICY, digestBytes, policyDigest, snapshotDigest, toolchainDigest, type Bundle, type Research } from '../src/protocol.js';
import { VerificationWorker } from '../src/worker.js';

interface Fixture {
  base: string;
  package_id: string;
  snapshot_digest: string;
  registry_id: string;
  toolchain_digest: string;
  tokens: string[];
}
interface PhaseRequest { kind: 'phase'; fixture: Fixture; rps: number; seconds: number; first_account: number }
interface Observation { latency_ms: number; scheduler_lag_ms: number; status: string; bytes: number; route: string; valid: boolean }

const percentile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]!;
};
const latencySummary = (values:number[]) => ({p50:percentile(values,.5),p95:percentile(values,.95),p99:percentile(values,.99),max:values.length ? Math.max(...values) : null});
function resourceSample(start: NodeJS.CpuUsage, wallMs: number, startRss: number, peakRss: number) {
  const cpu = process.cpuUsage(start);
  return {cpu_user_us:cpu.user,cpu_system_us:cpu.system,cpu_one_core_percent:(cpu.user+cpu.system)/(wallMs*1000)*100,
    rss_start_bytes:startRss,rss_peak_sampled_bytes:peakRss,rss_end_bytes:process.memoryUsage().rss};
}

async function generateLoad(request: PhaseRequest) {
  const {fixture,rps,seconds,first_account} = request;
  const count = rps*seconds;
  const observations:Observation[] = [];
  const inflight = new Set<Promise<void>>();
  let maxInflight = 0;
  let peakRss = process.memoryUsage().rss;
  const startRss = peakRss;
  const sample = setInterval(() => {peakRss=Math.max(peakRss,process.memoryUsage().rss);},250);
  const cpu = process.cpuUsage();
  const start = performance.now();
  let lastStarted = start;
  const paths = {
    meta:'/api/v1/meta', package:`/api/v1/packages/${fixture.package_id}`,
    version:`/api/v1/packages/${fixture.package_id}/versions/0.1.0`,
    snapshot:`/api/v1/packages/${fixture.package_id}/snapshots/${fixture.snapshot_digest}`,
  };
  try {
    for (let index=0; index<count; index++) {
      const intended = start+index*1000/rps;
      if (performance.now()<intended) await delay(intended-performance.now());
      const slot=index%10;
      const route = slot===0 ? 'meta' : slot<5 ? 'package' : slot<9 ? 'version' : 'snapshot';
      const account=(first_account+index)%fixture.tokens.length;
      const ip=`198.18.0.${index%100+1}`;
      const started=performance.now(); lastStarted=started;
      const promise = (async () => {
        let status='transport_error'; let bytes=0; let valid=false;
        try {
          const response=await fetch(fixture.base+paths[route],{headers:{authorization:`Bearer ${fixture.tokens[account]}`,'x-forwarded-for':ip},signal:AbortSignal.timeout(10_000)});
          status=String(response.status);
          const buffer=Buffer.from(await response.arrayBuffer()); bytes=buffer.length;
          if (response.status===200) {
            const value=JSON.parse(buffer.toString('utf8')) as Record<string,unknown>;
            valid=route==='meta' ? value.registry_id===fixture.registry_id && value.toolchain_digest===fixture.toolchain_digest
              : route==='package' ? value.id===fixture.package_id
              : route==='version' ? value.snapshot_digest===fixture.snapshot_digest && value.withdrawn===false && value.verification_revoked===false
              : snapshotDigest((value as unknown as Bundle).snapshot)===fixture.snapshot_digest;
          }
        } catch { /* Aggregate failures without writing request tokens or bodies. */ }
        observations.push({latency_ms:performance.now()-started,scheduler_lag_ms:Math.max(0,started-intended),status,bytes,route,valid});
      })();
      inflight.add(promise); maxInflight=Math.max(maxInflight,inflight.size);
      void promise.finally(() => inflight.delete(promise));
    }
    const remaining=start+seconds*1000-performance.now();
    if (remaining>0) await delay(remaining);
    await Promise.all(inflight);
  } finally {clearInterval(sample);}
  const wallMs=performance.now()-start;
  const statuses:Record<string,number>={};
  const routes:Record<string,{requests:number;bytes:number;invalid_payloads:number;latency_ms:ReturnType<typeof latencySummary>}>={};
  for (const observation of observations) statuses[observation.status]=(statuses[observation.status]??0)+1;
  for (const route of Object.keys(paths)) {
    const selected=observations.filter(x=>x.route===route);
    routes[route]={requests:selected.length,bytes:selected.reduce((n,x)=>n+x.bytes,0),invalid_payloads:selected.filter(x=>!x.valid).length,
      latency_ms:latencySummary(selected.map(x=>x.latency_ms))};
  }
  return {offered_rps:rps,offered_seconds:seconds,requests:count,completed:observations.length,
    observed_wall_ms:wallMs,last_request_started_ms:lastStarted-start,completed_rps:observations.length/(wallMs/1000),
    unique_authenticated_principals:count,simulated_client_ips:100,max_inflight:maxInflight,statuses,
    valid_payloads:observations.filter(x=>x.valid).length,bytes:observations.reduce((n,x)=>n+x.bytes,0),
    latency_ms:latencySummary(observations.map(x=>x.latency_ms)),scheduler_lag_ms:latencySummary(observations.map(x=>x.scheduler_lag_ms)),
    routes,generator_process:resourceSample(cpu,wallMs,startRss,peakRss)};
}

async function generator() {
  assert.ok(process.send,'The load generator requires an isolated IPC parent');
  process.on('message',(message:PhaseRequest) => {
    if (message.kind!=='phase') return;
    void generateLoad(message).then(result=>process.send?.({kind:'result',result}),()=>process.send?.({kind:'failure'}));
  });
  process.send({kind:'ready'});
}

async function main() {
  const handoffIndex=process.argv.indexOf('--backup-handoff');
  const handoffPath=handoffIndex<0 ? undefined : process.argv[handoffIndex+1];
  if (handoffIndex>=0) assert.ok(handoffPath,'--backup-handoff requires a new marker path');
  const environmentFile=process.env.PEBBLE_TEST_ENV ?? '.artifacts/test-env.json';
  const toolchainDirectory=process.env.PEBBLE_TEST_TOOLCHAIN ?? '.artifacts/toolchain-pinned';
  const env=JSON.parse(await readFile(environmentFile,'utf8')) as Record<string,string>;
  Object.assign(process.env,env);
  const previousProxy=process.env.TRUST_PROXY_CIDRS;
  process.env.TRUST_PROXY_CIDRS='127.0.0.1';
  const basePool=new pg.Pool({connectionString:env.DATABASE_URL,max:2});
  const schema='capacity_probe_'+randomUUID().replaceAll('-','');
  let createdSchema=false;
  let registry:Registry|undefined;
  let app:ReturnType<typeof createServer>|undefined;
  let child:ReturnType<typeof fork>|undefined;
  let cleanupComplete=false;
  const output=resolve('.artifacts',`capacity-probe-${new Date().toISOString().replaceAll(':','-')}.json`);
  const report:Record<string,unknown>={schema:'Pebble.CapacityProbe.v1',started_at:new Date().toISOString(),
    mode:handoffPath ? 'backup_fixture_only' : 'capacity_baseline',
    method:{registered_principals:10_000,source:'actual PostgreSQL account rows with SHA256 token indexes',
      phases:[{rps:35,seconds:30},{rps:100,seconds:30}],traffic_mix:{registry_metadata:.1,package_metadata:.4,exact_version:.4,small_snapshot:.1},
      pacing:'open-loop fixed target times; no response-dependent pacing',request_timeout_ms:10_000,
      network:'loopback HTTP; explicit TRUST_PROXY_CIDRS=127.0.0.1; 100 simulated benchmark-range forwarded client IPs',
      authorization:'different valid persisted bearer principal per offered request',
      logging:'only this isolated Fastify instance uses silent request logging; production middleware is unchanged',
      cpu_scope:'API/DB/S3 client process and separate HTTP load-generator process measured separately; DB/S3 daemon CPU is excluded',
      scope:'10,000 registered accounts, not 10,000 concurrent users; one public small algebra package; local HTTP excludes WAN/TLS/CDN and does not establish general proof throughput'},
    host:{node:process.version,platform:platform(),architecture:arch(),kernel:release(),logical_cpus:cpus().length,cpu_model:cpus()[0]?.model},phases:[]};
  const implementationFiles = ['package-lock.json', 'src/db.ts', 'src/main.ts', 'src/object-store.ts',
    'src/protocol.ts', 'src/registry.ts', 'src/server.ts', 'src/toolchain.ts', 'src/worker.ts',
    'migrations/001_registry.sql', 'tests/capacity-probe.ts'];
  report.implementation_files = await Promise.all(implementationFiles.map(async path => ({ path, sha256: digestBytes(await readFile(path)) })));
  try {
    await basePool.query(`CREATE SCHEMA "${schema}"`); createdSchema=true;
    const databaseUrl=new URL(env.DATABASE_URL!);
    databaseUrl.searchParams.set('options',`-c search_path=${schema}`);
    const worker=new VerificationWorker(resolve(toolchainDirectory),DEFAULT_POLICY);
    const toolchain=await worker.initialize();
    const registryId=randomUUID();
    const objectStore=objectStoreFromEnvironment();
    registry=new Registry({databaseUrl:databaseUrl.toString(),registryId,toolchain,policy:DEFAULT_POLICY,
      toolchainDigest:toolchainDigest(toolchain),policyDigest:policyDigest(DEFAULT_POLICY),objectStore,leaseSeconds:120});
    let sqlStatements=0;
    registry.db.pool.on('connect',client=>{
      const original=client.query;
      client.query=((...args:Parameters<typeof original>)=>{sqlStatements++; return Reflect.apply(original,client,args);}) as typeof client.query;
    });
    await registry.initialize({migrate:true});
    const principals=Array.from({length:10_000},(_,index)=>({id:randomUUID(),name:`capacity-user-${index}`,token:randomUUID()+randomUUID()}));
    const provisionStart=performance.now();
    for (let offset=0;offset<principals.length;offset+=500) {
      const batch=principals.slice(offset,offset+500);
      await registry.db.pool.query('INSERT INTO principals(id,name,token_hash) SELECT * FROM unnest($1::uuid[],$2::text[],$3::text[])',
        [batch.map(p=>p.id),batch.map(p=>p.name),batch.map(p=>digestBytes(p.token))]);
    }
    const principalCount=Number((await registry.db.pool.query<{count:string}>('SELECT count(*) FROM principals')).rows[0]!.count);
    assert.equal(principalCount,10_000);
    report.account_fixture={principals:principalCount,provision_wall_ms:performance.now()-provisionStart};
    app=createServer(registry);
    app.log.level='silent';
    await app.listen({host:'127.0.0.1',port:0});
    const address=app.server.address(); assert.ok(address && typeof address!=='string');
    const base=`http://127.0.0.1:${address.port}`;
    const owner=principals[0]!;
    const request=async <T>(method:string,path:string,body:unknown={},expected=200,headers:Record<string,string>={}) => {
      const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${owner.token}`,'x-forwarded-for':'198.18.1.1','content-type':'application/json','idempotency-key':randomUUID(),...headers},
        ...(method==='GET' ? {} : {body:JSON.stringify(body)}),signal:AbortSignal.timeout(30_000)});
      assert.equal(response.status,expected,`Fixture HTTP ${method} failed with status ${response.status}`);
      return await response.json() as T;
    };
    const packageId=(await request<{id:string}>('POST','/api/v1/packages',{name:'capacity/small-algebra'},201)).id;
    const research:Research={title:'Capacity fixture: group inverse identities',summary:'Existing group laws formalized only for a local infrastructure capacity baseline.',
      license:'Apache-2.0',authors:['Existing mathematical literature'],formalizers:['Slate project contributors','Pebble integration fixture contributors'],maintainers:['Capacity probe fixture owner'],
      kind:'formalization',claims:'Group inverse identities checked by actual Slate',assumptions:'Explicit group theory axioms',citations:[],usage:'Import the pinned inverse module and rebuild its exact sources.'};
    const bundle:Bundle={snapshot:{schema:'Pebble.PackageSnapshot.v1',package_id:packageId,version:'0.1.0',toolchain_digest:toolchainDigest(toolchain),dependencies:[],files:[],research},blobs:[]};
    for (const path of ['LICENSE.txt','src/inverses.slate','theory/group.slate']) {
      const bytes=await readFile(path === 'LICENSE.txt' ? 'experiments/fixtures/package-reuse/LICENSE' : `experiments/fixtures/package-reuse/algebra-provider/${path}`);
      const hash=digestBytes(bytes);
      bundle.snapshot.files.push({path,byte_length:bytes.length,sha256:hash});
      bundle.blobs.push({sha256:hash,content_base64:bytes.toString('base64')});
    }
    const snapshot=snapshotDigest(bundle.snapshot);
    await request('POST',`/api/v1/packages/${packageId}/snapshots`,bundle,201);
    await request('PUT',`/api/v1/packages/${packageId}/visibility`,{visibility:'public'});
    const candidate=await request<{id:string}>('POST',`/api/v1/packages/${packageId}/candidates`,{snapshot_digest:snapshot},202);
    const lease=await registry.claimJob(); assert.ok(lease); assert.equal(lease.candidate_id,candidate.id);
    const workerStart=performance.now();
    const checked=await worker.verify(lease);
    const checkMs=performance.now()-workerStart;
    assert.equal(checked.outcome,'passed','The capacity fixture must pass an actual isolated Slate check');
    assert.equal(await registry.completeJob(lease,checked),true);
    const reviewed=await request<{revision:number}>('POST',`/api/v1/candidates/${candidate.id}/review`,{approved:true,
      note:'Reviewed capacity-only algebra fixture source classification, metadata, attributions and group assumptions.',source_classification_confirmed:true});
    await request('POST',`/api/v1/candidates/${candidate.id}/publish`,{},201,{'if-match':`"${reviewed.revision}"`});
    report.checked_fixture={package_id:packageId,snapshot_digest:snapshot,toolchain_digest:toolchainDigest(toolchain),policy_digest:policyDigest(DEFAULT_POLICY),
      formal_check_outcome:checked.outcome,isolated_worker_wall_ms:checkMs,source_bytes:bundle.snapshot.files.reduce((n,f)=>n+f.byte_length,0),
      files:bundle.snapshot.files.length,release_status:'published',sample_count:1,
      limitation:'One small algebra source check; does not measure arbitrary theorem proving or general worker throughput'};
    let firstAccount=1;
    if (handoffPath) {
      // Keep backups outside timed load windows. A second invocation creates the
      // same genuinely checked fixture and holds only its own schema for the
      // restore drill, then performs the normal cleanup when the marker arrives.
      (report.method as {phases:unknown[]}).phases=[];
      const marker=resolve(handoffPath);
      await writeFile(marker,JSON.stringify({schema,registry_id:registryId,package_id:packageId,snapshot_digest:snapshot,
        version:'0.1.0',toolchain_digest:toolchainDigest(toolchain),policy_digest:policyDigest(DEFAULT_POLICY),
        formal_check_outcome:'passed',release_status:'published',principals:principalCount},null,2)+'\n',{flag:'wx',mode:0o600});
      console.log(JSON.stringify({backup_handoff:marker,completion_marker:marker+'.complete'}));
      const deadline=performance.now()+10*60*1000;
      while (true) {
        try {await access(marker+'.complete');break;} catch { /* The drill owns its completion marker. */ }
        assert.ok(performance.now()<deadline,'Backup handoff expired; cleaning the isolated fixture');
        await delay(500);
      }
      report.backup_handoff={metadata_file:marker,completion_observed:true};
    } else {
    child=fork(fileURLToPath(import.meta.url),['--generator'],{stdio:['ignore','ignore','ignore','ipc']});
    await new Promise<void>((done,reject)=>{
      const timer=setTimeout(()=>reject(new Error('GeneratorStartupTimeout')),15_000);
      child!.once('error',reject);
      child!.once('exit',()=>reject(new Error('GeneratorExited')));
      child!.once('message',message=>{clearTimeout(timer); assert.equal((message as {kind:string}).kind,'ready'); done();});
    });
    const fixture:Fixture={base,package_id:packageId,snapshot_digest:snapshot,registry_id:registryId,toolchain_digest:toolchainDigest(toolchain),tokens:principals.map(p=>p.token)};
    for (const rps of [35,100]) {
      const start=performance.now(); const cpu=process.cpuUsage(); const sqlStart=sqlStatements;
      const startRss=process.memoryUsage().rss; let peakRss=startRss; let peakConnections=0; let peakWaiters=0;
      const sample=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);peakConnections=Math.max(peakConnections,registry!.db.pool.totalCount);peakWaiters=Math.max(peakWaiters,registry!.db.pool.waitingCount);},250);
      let result:Awaited<ReturnType<typeof generateLoad>>;
      try {
        result=await new Promise((done,reject)=>{
          const timer=setTimeout(()=>reject(new Error('GeneratorPhaseTimeout')),50_000);
          const onMessage=(message:{kind:string;result:Awaited<ReturnType<typeof generateLoad>>})=>{
            if (message.kind!=='result' && message.kind!=='failure') return;
            clearTimeout(timer); child!.off('message',onMessage);
            if (message.kind==='failure') reject(new Error('GeneratorFailed')); else done(message.result);
          };
          child!.on('message',onMessage);
          child!.send({kind:'phase',fixture,rps,seconds:30,first_account:firstAccount} satisfies PhaseRequest);
        });
      } finally {clearInterval(sample);}
      const wallMs=performance.now()-start;
      (report.phases as unknown[]).push({...result,api_process:resourceSample(cpu,wallMs,startRss,peakRss),
        database:{statements:sqlStatements-sqlStart,pool_connections_peak:peakConnections,pool_waiters_peak:peakWaiters,pool_configured_max:registry.db.pool.options.max}});
      console.log(JSON.stringify({phase_rps:rps,requests:result.requests,statuses:result.statuses,latency_ms:result.latency_ms,bytes:result.bytes}));
      firstAccount+=rps*30;
    }
    }
    const counts=(await registry.db.pool.query<{principals:string;packages:string;releases:string;verification_attempts:string}>(`SELECT
      (SELECT count(*) FROM principals) AS principals,(SELECT count(*) FROM packages) AS packages,
      (SELECT count(*) FROM releases) AS releases,(SELECT count(*) FROM verification_attempts) AS verification_attempts`)).rows[0]!;
    report.database_counts=Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,Number(value)]));
    report.distinct_load_principals=firstAccount-1;
    report.completed_at=new Date().toISOString();
    report.passed=(report.phases as Awaited<ReturnType<typeof generateLoad>>[]).every(phase=>phase.completed===phase.requests && phase.valid_payloads===phase.requests && phase.statuses['200']===phase.requests);
  } finally {
    if (child) {child.kill('SIGTERM'); await new Promise<void>(done=>{if (child!.exitCode!==null || child!.signalCode!==null) done();else child!.once('exit',()=>done());});}
    if (app) await app.close();
    if (registry) await registry.close();
    if (createdSchema) await basePool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await basePool.end();
    cleanupComplete=true;
    if (previousProxy===undefined) delete process.env.TRUST_PROXY_CIDRS; else process.env.TRUST_PROXY_CIDRS=previousProxy;
    report.cleanup={unique_database_schema_dropped:createdSchema,server_closed:true,generator_stopped:true,complete:cleanupComplete,
      object_storage:'Existing content-addressed fixture bytes retained; no shared S3 objects deleted'};
    await mkdir(resolve('.artifacts'),{recursive:true});
    await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({capacity_report:output,cleanup_complete:cleanupComplete}));
  }
  assert.equal(report.passed,true,'Capacity probe had unsuccessful or invalid HTTP responses; inspect the aggregate report');
}

if (process.argv.includes('--generator')) await generator();
else await main();
