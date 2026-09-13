import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as rawHttpServer, request as rawHttpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { Registry } from '../src/registry.js';
import { createServer } from '../src/server.js';
import { type ObjectStore } from '../src/object-store.js';
import { DEFAULT_POLICY, digestBytes, policyDigest, toolchainDigest, type Toolchain } from '../src/protocol.js';

const environmentFile = process.env.PEBBLE_TEST_ENV ?? '.artifacts/test-env.json';
const toolchainDirectory = process.env.PEBBLE_TEST_TOOLCHAIN ?? '.artifacts/toolchain-adr0188';
const available = existsSync(environmentFile) && existsSync(`${toolchainDirectory}/toolchain.json`);
const newToken = () => randomBytes(32).toString('hex');
const unknownCode = () => randomBytes(32).toString('base64url');

test('invitation registration uses real PostgreSQL transactions and HTTP authentication', {
  skip: available ? false : 'Set PEBBLE_TEST_ENV and PEBBLE_TEST_TOOLCHAIN for actual PostgreSQL integration',
}, async t => {
  const env = JSON.parse(await readFile(environmentFile,'utf8')) as Record<string,string>;
  const adminPool = new pg.Pool({connectionString:env.DATABASE_URL,max:2});
  const schema = 'invitations_test_' + randomUUID().replaceAll('-','');
  const databaseUrl = new URL(env.DATABASE_URL!);
  databaseUrl.searchParams.set('options',`-c search_path=${schema}`);
  const toolchain = JSON.parse(await readFile(resolve(toolchainDirectory,'toolchain.json'),'utf8')) as Toolchain;
  const denyStorage = async ():Promise<never> => {throw new Error('Invitation registration must not access source storage or mathematical verification');};
  // Bootstrapping writes the public `config.json`; nothing else may reach storage.
  const objectStore:ObjectStore = {put:async (key:string) => {if (key !== 'public/index/config.json') await denyStorage();},get:denyStorage,has:denyStorage,copy:denyStorage,healthy:denyStorage};
  const registry = new Registry({databaseUrl:databaseUrl.toString(),registryId:randomUUID(),toolchain,
    policy:DEFAULT_POLICY,toolchainDigest:toolchainDigest(toolchain),policyDigest:policyDigest(DEFAULT_POLICY),objectStore,toolchainTag:'local'});
  const previousProxy = process.env.TRUST_PROXY_CIDRS;
  process.env.TRUST_PROXY_CIDRS = '127.0.0.1';
  const app = createServer(registry);
  app.log.level = 'silent';
  let observedRequests=0;
  app.addHook('onRequest',async () => {observedRequests++;});
  let schemaCreated = false;
  let base = '';
  let nextIp = 1;
  const ip = () => `198.19.${Math.floor(nextIp/250)}.${nextIp++%250+1}`;
  interface HttpResult {status:number;body:Record<string,unknown>;headers:Headers}
  const request = async (method:string,path:string,body?:unknown,headers:Record<string,string>={}):Promise<HttpResult> => {
    const result = await fetch(base+path,{method,headers:{'x-forwarded-for':ip(),...(body===undefined ? {} : {'content-type':'application/json'}),...headers},
      ...(body===undefined ? {} : {body:JSON.stringify(body)}),signal:AbortSignal.timeout(10_000)});
    return {status:result.status,body:await result.json() as Record<string,unknown>,headers:result.headers};
  };
  const redeem = (code:string,token:string,headers:Record<string,string>={},query='') => request('POST','/api/v1/invitations/redeem'+query,{invitation_code:code,token},headers);
  const expectInvalid = (result:HttpResult) => {
    assert.equal(result.status,410);
    assert.equal(result.body.error,'invalid_invitation');
  };
  const principal = async (name:string) => (await registry.db.pool.query<{id:string;name:string;token_hash:string;revoked:boolean}>(
    'SELECT id,name,token_hash,revoked FROM principals WHERE name=$1',[name])).rows[0];

  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    await registry.initialize({migrate:true});
    await t.test('the previous schema refuses startup until an idempotent operator migration upgrades it',async () => {
      const token=newToken();
      const existing=await registry.provisionPrincipal({name:'migration-preserved-account',token});
      // This isolated schema has no invitation rows; its existing principal is
      // retained across the operator upgrade of a previous registry schema.
      await registry.db.pool.query('DROP TABLE invitations');
      await registry.db.pool.query('DELETE FROM schema_migrations WHERE version=3');
      await assert.rejects(registry.initialize(),/requires migration 3/);
      await registry.initialize({migrate:true});
      await registry.initialize({migrate:true});
      await registry.initialize();
      assert.equal((await registry.db.pool.query('SELECT 1 FROM schema_migrations WHERE version=3')).rowCount,1);
      assert.equal((await registry.db.pool.query('SELECT count(*)::integer AS count FROM invitations')).rows[0]!.count,0);
      const retained=await principal(existing.name); assert.ok(retained);
      assert.equal(retained.id,existing.id); assert.equal(retained.token_hash,digestBytes(token));
    });
    await app.listen({host:'127.0.0.1',port:0});
    const address=app.server.address(); assert.ok(address && typeof address!=='string');
    base=`http://127.0.0.1:${address.port}`;

    await t.test('the actual invitation CLI persists a private credential, retries it and refuses unrelated output reuse',async () => {
      const directory=await mkdtemp(resolve(tmpdir(),'pebble-invitation-cli-'));
      const inviteFile=resolve(directory,'invitation.json');
      const credentialFile=resolve(directory,'credentials.json');
      const invocation=async (registryUrl=base,outputFile=credentialFile):Promise<{code:number|null;stdout:string;stderr:string}> => new Promise((done,reject) => {
        const child=spawn(process.execPath,[resolve('deployment/accept-invite.mjs'),'--registry',registryUrl,'--invite-file',inviteFile,'--output',outputFile],
          {stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH}});
        let stdout='';let stderr='';
        const timer=setTimeout(()=>child.kill('SIGKILL'),15_000);
        child.stdout.on('data',(chunk:Buffer)=>{stdout+=chunk.toString('utf8');if(stdout.length>16384)child.kill('SIGKILL');});
        child.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.toString('utf8');if(stderr.length>16384)child.kill('SIGKILL');});
        child.once('error',error=>{clearTimeout(timer);reject(error);});
        child.once('close',code=>{clearTimeout(timer);done({code,stdout,stderr});});
      });
      try {
        const invitation=await registry.issueInvitation({name:'actual-cli-user'});
        await writeFile(inviteFile,JSON.stringify(invitation)+'\n',{mode:0o600});
        const first=await invocation();
        assert.equal(first.code,0,'The actual CLI should redeem a valid invitation');
        const bytes=await readFile(credentialFile);
        const credentials=JSON.parse(bytes.toString('utf8')) as {registry_url:string;invitation_hash:string;token:string};
        assert.equal((await stat(credentialFile)).mode&0o777,0o600);
        assert.equal(credentials.registry_url,base);
        assert.equal(credentials.invitation_hash,digestBytes(invitation.code));
        assert.match(credentials.token,/^[0-9a-f]{64}$/);
        const cleanOutput=(output:{stdout:string;stderr:string}) => {
          assert.ok(!output.stdout.includes(invitation.code) && !output.stderr.includes(invitation.code),'The invitation code must never appear in CLI output');
          assert.ok(!output.stdout.includes(credentials.token) && !output.stderr.includes(credentials.token),'The login secret must never appear in CLI output');
        };
        cleanOutput(first);
        const principalOutput=JSON.parse(first.stdout) as {id:string;status:string;credentials_file:string};
        assert.equal(principalOutput.status,'accepted');
        assert.match(principalOutput.id,/^[0-9a-f-]{36}$/);
        assert.deepEqual(Object.keys(principalOutput).sort(),['credentials_file','id','status']);
        assert.equal(principalOutput.credentials_file,credentialFile);
        const second=await invocation();
        assert.equal(second.code,0,'Retrying with the same files should retain the selected login');
        cleanOutput(second);
        assert.deepEqual(JSON.parse(second.stdout),principalOutput);
        assert.ok((await readFile(credentialFile)).equals(bytes),'A successful retry must not rotate or rewrite credentials');
        const created=await request('POST','/api/v1/packages',{name:'actual-cli-private-research',visibility:'private'},
          {authorization:`Bearer ${credentials.token}`,'idempotency-key':randomUUID()});
        assert.equal(created.status,201);assert.equal(created.body.visibility,'private');

        const other=await registry.issueInvitation({name:'other-cli-invitation'});
        await writeFile(inviteFile,JSON.stringify(other)+'\n',{mode:0o600});
        const beforeOther=observedRequests;
        const wrongInvitation=await invocation();
        assert.equal(wrongInvitation.code,1);
        assert.equal(observedRequests,beforeOther,'An unrelated invitation must fail before sending a credential');
        cleanOutput(wrongInvitation);
        assert.ok(!wrongInvitation.stdout.includes(other.code) && !wrongInvitation.stderr.includes(other.code));
        assert.ok((await readFile(credentialFile)).equals(bytes),'A rejected invitation must not overwrite an existing credential file');
        assert.equal(await principal(other.name),undefined);

        await writeFile(inviteFile,JSON.stringify(invitation)+'\n',{mode:0o600});
        let otherRegistryRequests=0;
        const otherServer=rawHttpServer((request,response)=>{
          otherRegistryRequests++;
          let body='';
          request.on('data',(bytes:Buffer)=>{body+=bytes.toString('utf8');});
          request.once('end',()=>{
            const received=JSON.parse(body) as {token:string};
            response.writeHead(200,{'content-type':'application/json'});
            response.end(JSON.stringify({id:randomUUID(),name:received.token}));
          });
        });
        await new Promise<void>(done=>otherServer.listen(0,'127.0.0.1',done));
        try {
          const address=otherServer.address();assert.ok(address && typeof address!=='string');
          const wrongRegistry=await invocation(`http://127.0.0.1:${address.port}`);
          assert.equal(wrongRegistry.code,1);
          assert.equal(otherRegistryRequests,0,'A different registry origin must fail before making a request');
          cleanOutput(wrongRegistry);
          assert.ok((await readFile(credentialFile)).equals(bytes),'A rejected registry must not overwrite an existing credential file');
          const hostileOutput=resolve(directory,'hostile-response-credentials.json');
          const hostile=await invocation(`http://127.0.0.1:${address.port}`,hostileOutput);
          assert.equal(hostile.code,0);
          assert.equal(otherRegistryRequests,1);
          const hostileCredentials=JSON.parse(await readFile(hostileOutput,'utf8')) as {token:string};
          assert.ok(!hostile.stdout.includes(hostileCredentials.token) && !hostile.stderr.includes(hostileCredentials.token),
            'Even an explicit remote success payload echoing the login token must not leak it to logs');
          assert.equal(JSON.parse(hostile.stdout).status,'accepted');
        } finally {await new Promise<void>((done,reject)=>otherServer.close(error=>error ? reject(error) : done()));}
      } finally {await rm(directory,{recursive:true,force:true});}
    });

    await t.test('one issued invitation creates a usable private-package owner and stores no credential plaintext',async () => {
      const start=Date.now();
      const invitation=await registry.issueInvitation({name:'invited-owner'});
      assert.match(invitation.code,/^[A-Za-z0-9_-]{43}$/);
      assert.equal(invitation.name,'invited-owner');
      assert.ok(Date.parse(invitation.expires_at)>=start+168*60*60*1000-1000);
      assert.ok(Date.parse(invitation.expires_at)<=Date.now()+168*60*60*1000+1000);
      const token=newToken();
      const accepted=await redeem(invitation.code,token);
      assert.equal(accepted.status,200);
      assert.equal(accepted.body.name,invitation.name);
      assert.deepEqual(Object.keys(accepted.body).sort(),['id','name']);
      const stored=await principal(invitation.name); assert.ok(stored);
      assert.equal(stored.id,accepted.body.id);
      assert.equal(stored.token_hash,digestBytes(token));
      assert.equal(stored.revoked,false);
      const serialized=(await registry.db.pool.query<{record:string}>('SELECT row_to_json(i)::text AS record FROM invitations i WHERE id=$1',[invitation.id])).rows[0]!.record;
      assert.ok(!serialized.includes(invitation.code),'Only an invitation hash may be persisted');
      assert.ok(!serialized.includes(token),'Login token plaintext must not enter invitation history');
      assert.ok(serialized.includes(digestBytes(invitation.code)),'The stored invitation hash binds the actually issued code');
      const response=await request('POST','/api/v1/packages',{name:'invited-owner-research',visibility:'private'},{authorization:`Bearer ${token}`,'idempotency-key':randomUUID()});
      assert.equal(response.status,201);
      assert.equal(response.body.visibility,'private');
      const unauthenticated=await request('POST','/api/v1/packages',{name:'without-invitation-research'},{'idempotency-key':randomUUID()});
      assert.equal(unauthenticated.status,401);
      const invalidToken=await request('POST','/api/v1/packages',{name:'unregistered-token-research'},{authorization:`Bearer ${newToken()}`,'idempotency-key':randomUUID()});
      assert.equal(invalidToken.status,401);
      const meta=await request('GET','/api/v1/meta');
      assert.equal(meta.status,200); assert.equal(meta.body.registration,'invitation_only');
      const publicIssuance=await request('POST','/api/v1/invitations',{name:'public-issuance'},{authorization:`Bearer ${token}`,'idempotency-key':randomUUID()});
      assert.equal(publicIssuance.status,404);
    });

    await t.test('same-code same-token concurrent redemption is idempotent and creates exactly one account',async () => {
      const invitation=await registry.issueInvitation({name:'concurrent-identical'});
      const token=newToken();
      const results=await Promise.all(Array.from({length:4},()=>redeem(invitation.code,token)));
      assert.deepEqual(results.map(result=>result.status),[200,200,200,200]);
      for (const result of results) assert.deepEqual(result.body,results[0]!.body);
      const rows=(await registry.db.pool.query('SELECT id FROM principals WHERE name=$1',[invitation.name])).rows;
      assert.equal(rows.length,1); assert.equal(rows[0]!.id,results[0]!.body.id);
      expectInvalid(await redeem(invitation.code,newToken()));
    });

    await t.test('different-token concurrent redemption has one winner and cannot overwrite its principal',async () => {
      const invitation=await registry.issueInvitation({name:'concurrent-competing'});
      const tokens=[newToken(),newToken()];
      const results=await Promise.all(tokens.map(token=>redeem(invitation.code,token)));
      assert.deepEqual(results.map(result=>result.status).sort(),[200,410]);
      const winner=results.findIndex(result=>result.status===200);
      const loser=results.findIndex(result=>result.status===410);
      expectInvalid(results[loser]!);
      const stored=await principal(invitation.name); assert.ok(stored);
      assert.equal(stored.token_hash,digestBytes(tokens[winner]!));
      assert.equal(stored.id,results[winner]!.body.id);
      assert.deepEqual((await redeem(invitation.code,tokens[winner]!)).body,results[winner]!.body);
    });

    await t.test('unknown expired and revoked invitations have one denial and do not allocate accounts',async () => {
      const expired=await registry.issueInvitation({name:'expired-user',expiresInHours:1});
      await registry.db.pool.query("UPDATE invitations SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.id]);
      const revoked=await registry.issueInvitation({name:'revoked-user'});
      assert.deepEqual(await registry.revokeInvitation(revoked.id),{id:revoked.id,revoked:true});
      expectInvalid(await redeem(unknownCode(),newToken()));
      expectInvalid(await redeem(expired.code,newToken()));
      expectInvalid(await redeem(revoked.code,newToken()));
      assert.equal(await principal(expired.name),undefined);
      assert.equal(await principal(revoked.name),undefined);
      await assert.rejects(registry.issueInvitation({name:'invalid-duration-zero',expiresInHours:0}));
      await assert.rejects(registry.issueInvitation({name:'invalid-duration-fraction',expiresInHours:1.5}));
      await assert.rejects(registry.issueInvitation({name:'invalid-duration-excess',expiresInHours:721}));
    });

    await t.test('a name collision leaves the invitation unconsumed and never changes the existing login',async () => {
      const name='preexisting-name';
      const oldToken=newToken();
      const invitation=await registry.issueInvitation({name});
      const existing=await registry.provisionPrincipal({name,token:oldToken});
      await assert.rejects(registry.issueInvitation({name}));
      const before=(await registry.db.pool.query<{record:string}>('SELECT row_to_json(i)::text AS record FROM invitations i WHERE id=$1',[invitation.id])).rows[0]!.record;
      const result=await redeem(invitation.code,newToken());
      assert.equal(result.status,409); assert.equal(result.body.error,'conflict');
      const stored=await principal(name); assert.ok(stored);
      assert.equal(stored.id,existing.id); assert.equal(stored.token_hash,digestBytes(oldToken));
      const after=(await registry.db.pool.query<{record:string}>('SELECT row_to_json(i)::text AS record FROM invitations i WHERE id=$1',[invitation.id])).rows[0]!.record;
      assert.equal(after,before,'Failed redemption must atomically preserve the unused invitation');
    });

    await t.test('two separately issued invitations for one name cannot allocate two accounts or consume the losing invitation',async () => {
      const name='two-invitations-one-name';
      const invitations=[await registry.issueInvitation({name}),await registry.issueInvitation({name})];
      const tokens=[newToken(),newToken()];
      const results=await Promise.all(invitations.map((invitation,index)=>redeem(invitation.code,tokens[index]!)));
      assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
      const winner=results.findIndex(result=>result.status===200);
      const loser=results.findIndex(result=>result.status===409);
      const stored=await principal(name); assert.ok(stored);
      assert.equal(stored.token_hash,digestBytes(tokens[winner]!));
      const rows=(await registry.db.pool.query<{id:string;accepted_at:Date|null;accepted_principal_id:string|null}>(
        'SELECT id,accepted_at,accepted_principal_id FROM invitations WHERE name=$1',[name])).rows;
      const unconsumed=rows.find(row=>row.id===invitations[loser]!.id)!;
      assert.equal(unconsumed.accepted_at,null); assert.equal(unconsumed.accepted_principal_id,null);
      assert.equal(rows.find(row=>row.id===invitations[winner]!.id)!.accepted_principal_id,stored.id);
    });

    await t.test('redeemed invitation retries cannot reverse token rotation or principal revocation',async () => {
      const rotated=await registry.issueInvitation({name:'rotated-login'});
      const oldToken=newToken();
      const accepted=await redeem(rotated.code,oldToken); assert.equal(accepted.status,200);
      const newLogin=newToken();
      const current=await registry.provisionPrincipal({name:rotated.name,token:newLogin});
      assert.equal(current.id,accepted.body.id);
      expectInvalid(await redeem(rotated.code,oldToken));
      assert.equal((await principal(rotated.name))!.token_hash,digestBytes(newLogin));
      const revoked=await registry.issueInvitation({name:'revoked-login'});
      const token=newToken();
      const registered=await redeem(revoked.code,token); assert.equal(registered.status,200);
      await registry.revokePrincipal(registered.body.id as string);
      expectInvalid(await redeem(revoked.code,token));
      assert.equal((await principal(revoked.name))!.revoked,true);
      const existing=await registry.revokeInvitation(rotated.id);
      assert.deepEqual(existing,{id:rotated.id,revoked:false},'Revocation cannot pretend to retract an already redeemed invitation');
    });

    await t.test('redemption enforces its small body schema and shared per-IP limit across query strings',async () => {
      const malformed=[{}, {invitation_code:unknownCode()}, {invitation_code:'short',token:newToken()},
        {invitation_code:unknownCode(),token:'0'.repeat(63)}, {invitation_code:unknownCode(),token:newToken(),name:'self-selected-name'}];
      for (const body of malformed) assert.equal((await request('POST','/api/v1/invitations/redeem',body)).status,400);
      const oversized=await request('POST','/api/v1/invitations/redeem',{invitation_code:unknownCode(),token:newToken(),padding:'x'.repeat(1024)});
      assert.equal(oversized.status,413);
      const address=ip();
      for (let index=0;index<5;index++) {
        expectInvalid(await redeem(unknownCode(),newToken(),{'x-forwarded-for':address},`?attempt=${index}`));
      }
      const limited=await redeem(unknownCode(),newToken(),{'x-forwarded-for':address},'?attempt=unique-final-query');
      assert.equal(limited.status,429);
      assert.ok(limited.headers.get('retry-after'));
      expectInvalid(await redeem(unknownCode(),newToken()));
    });

    await t.test('literal dot-segment paths cannot reach redemption through the general API route',async () => {
      const invitation=await registry.issueInvitation({name:'literal-dot-segment'});
      const token=newToken();
      // fetch normalizes dot segments before sending. Send the exact HTTP path
      // so the wildcard route cannot normalize itself into the special route.
      const body=JSON.stringify({invitation_code:invitation.code,token})+' '.repeat(2048);
      const response=await new Promise<{status:number}>( (done,reject) => {
        const origin=new URL(base);
        const connection=rawHttpRequest({hostname:origin.hostname,port:origin.port,method:'POST',path:'/api/v1/x/../invitations/redeem',
          headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),'x-forwarded-for':ip()},timeout:10_000},result=>{
          result.resume();
          result.once('end',()=>done({status:result.statusCode!}));
        });
        connection.once('error',reject);
        connection.once('timeout',()=>connection.destroy(new Error('Raw-path test request timed out')));
        connection.end(body);
      });
      assert.ok(response.status>=400 && response.status<500,'Only the dedicated redemption route may accept invitations');
      assert.equal(await principal(invitation.name),undefined);
      assert.equal((await redeem(invitation.code,token)).status,200,'Rejected path confusion must leave the invitation usable');
    });
  } finally {
    await app.close();
    await registry.close();
    if (schemaCreated) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
    if (previousProxy===undefined) delete process.env.TRUST_PROXY_CIDRS;
    else process.env.TRUST_PROXY_CIDRS=previousProxy;
  }
});
