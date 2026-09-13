import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Database } from './db.js';
import { canonical, digest, snapshotDigest, validateSnapshot, validateBundle, type Bundle, type Snapshot, type Toolchain, type Policy } from './protocol.js';
import type { ObjectStore } from './object-store.js';
import { reportMatchesInput } from './worker.js';

type JsonObject = Record<string, unknown>;
interface PrincipalRow { id: string; name?: string }
interface PackageRow { id: string; name: string; owner_id: string; visibility: 'private'|'public'; created_at: Date }
interface CandidateRow { id:string; package_id:string; snapshot_digest:string; creator_id:string; revision:number; status:string; input_digest:string; toolchain_digest:string; policy_digest:string; diagnostic:string|null; created_at:Date }
interface SettingsRow { registry_id:string; toolchain_digest:string; policy_digest:string; toolchain:Toolchain; policy:Policy }
interface ReviewRow { id:string; candidate_id:string; reviewer_id:string; snapshot_digest:string; approved:boolean; source_classification_confirmed:boolean; note:string; created_at:Date }
interface AttemptRow { id:string; job_id:string; attempt:number; input_digest:string; outcome:string; report:unknown; report_digest:string|null; diagnostic:string|null; completed_at:Date }
interface ReleaseRow { id:string; package_id:string; version:string; snapshot_digest:string; candidate_id:string; verification_id:string; review_id:string; published_by:string; published_at:Date; withdrawn?:boolean; verification_revoked?:boolean }
interface JobRow { id:string; candidate_id:string; requested_by:string; attempt:number; state:string; lease_token:string|null; lease_expires_at:Date|null; available_at:Date }
interface IdempotencyRow { request_digest:string;status:number;response:unknown }
interface InvitationRow {
  id:string; name:string; expires_at:Date; revoked_at:Date|null;
  accepted_principal_id:string|null;
}
type RouteBase = {method:string;path:string;query:URLSearchParams};
type CandidateRoute = RouteBase & {operation:'candidate'|'retry'|'review'|'publish';pkg:PackageRow;candidate:CandidateRow};
type PackageOperation = 'package'|'visibility'|'member'|'upload'|'create_candidate'|'versions'|'version'|'withdrawals'|'revocations';
type Route = (RouteBase & {operation:'meta'|'create_package'})
  | CandidateRoute
  | (RouteBase & {operation:'snapshot';pkg:PackageRow;snapshot:Snapshot})
  | (RouteBase & {operation:PackageOperation;pkg:PackageRow;principal?:string;version?:string});
export interface RegistryOptions {
  databaseUrl: string;
  registryId: string;
  toolchain: Toolchain;
  policy: Policy;
  toolchainDigest: string;
  policyDigest: string;
  objectStore: ObjectStore;
  leaseSeconds?: number;
  // A test can abort a transaction after insertion to exercise real rollback.
  beforePublishCommit?: () => Promise<void>;
}
export interface JobLease {
  id: string;
  candidate_id: string;
  token: string;
  lease_expires_at: string;
  attempt: number;
  input_digest: string;
  toolchain_digest: string;
  policy_digest: string;
  root: Bundle;
  dependencies: Bundle[];
}
export interface JobResult {
  outcome: 'passed' | 'incomplete' | 'timeout' | 'error';
  input_digest: string;
  toolchain_digest: string;
  policy_digest: string;
  report?: unknown;
  diagnostic?: string;
}
export interface ApiResponse { status: number; body: unknown; preparedSnapshot?:Snapshot }
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new ApiError(status, code, message); }
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const bytesHash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
function object(value: unknown): asserts value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request', 'Expected an object');
}
function fields(body: unknown, keys: string[]): asserts body is JsonObject {
  object(body);
  if (Object.keys(body).sort().join(',') !== [...keys].sort().join(',')) fail(400, 'invalid_request', `Expected fields: ${keys.join(', ')}`);
}
function string(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_request', `Invalid ${label}`);
}
function uuid(value: string) { if (!UUID.test(value)) fail(404, 'not_found', 'Resource not found'); return value; }

export class Registry {
  readonly db: Database;
  readonly options: RegistryOptions;
  constructor(options: RegistryOptions) {
    this.options = options;
    this.db = new Database(options.databaseUrl);
  }

  async initialize({ migrate = false }: {migrate?:boolean} = {}) {
    if (migrate) await this.db.migrate();
    await this.db.transaction(async db => {
      if (!(await db.query('SELECT 1 FROM schema_migrations WHERE version=2')).rowCount) {
        throw new Error('Registry schema requires migration 2; run the operator migration command');
      }
      const old = (await db.query<SettingsRow>('SELECT * FROM registry_settings WHERE singleton')).rows[0];
      if (old && old.registry_id !== this.options.registryId) throw new Error('Registry identity differs from persisted state');
      if (old && (old.toolchain_digest !== this.options.toolchainDigest || old.policy_digest !== this.options.policyDigest)) throw new Error('Running nodes must use the persisted policy and toolchain; operator migration is required to change them');
      if (old) return;
      if (!migrate) throw new Error('Registry has not been bootstrapped; run the operator migration command');
      await db.query(`INSERT INTO registry_settings(singleton,registry_id,toolchain_digest,policy_digest,toolchain,policy)
        VALUES(true,$1,$2,$3,$4,$5) ON CONFLICT(singleton) DO NOTHING`,
      [this.options.registryId, this.options.toolchainDigest, this.options.policyDigest, this.options.toolchain, this.options.policy]);
    }, migrate);
  }
  async close() { await this.db.close(); }

  // Operator-only provisioning: deliberately absent from the public HTTP API.
  async provisionPrincipal(input: { id?: string; name: string; token: string }) {
    string(input.name, 'principal name', 200);
    string(input.token, 'token', 512);
    if (input.token.length < 24) throw new Error('Principal tokens must contain at least 24 characters');
    return this.db.transaction(async db => {
      const existing = (await db.query<PrincipalRow>('SELECT id FROM principals WHERE name=$1', [input.name])).rows[0];
      const id = existing?.id ?? input.id ?? randomUUID();
      await db.query(`INSERT INTO principals(id,name,token_hash) VALUES($1,$2,$3)
        ON CONFLICT(name) DO UPDATE SET token_hash=EXCLUDED.token_hash,revoked=false`, [id, input.name, bytesHash(input.token)]);
      return { id, name: input.name };
    });
  }

  async revokePrincipal(id: string) {
    await this.db.transaction(async db => { await db.query('UPDATE principals SET revoked=true WHERE id=$1', [uuid(id)]); });
  }

  // Invites are issued only by the operator CLI, never by a public API or by
  // ordinary members. Possession of an invite permits one named account.
  async issueInvitation(input: {name:string;expiresInHours?:number}) {
    string(input.name,'principal name',200);
    const hours = input.expiresInHours ?? 168;
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) fail(400,'invalid_request','Invitation lifetime must be 1..720 hours');
    const id = randomUUID();
    const code = randomBytes(32).toString('base64url');
    return this.db.transaction(async db => {
      if ((await db.query('SELECT 1 FROM principals WHERE name=$1',[input.name])).rowCount) {
        fail(409,'conflict','An account with this name already exists');
      }
      const row = (await db.query<{expires_at:Date}>(`INSERT INTO invitations(id,name,code_hash,expires_at)
        VALUES($1,$2,$3,clock_timestamp()+($4 * interval '1 hour')) RETURNING expires_at`,
      [id,input.name,bytesHash(code),hours])).rows[0]!;
      return {id,name:input.name,code,expires_at:row.expires_at.toISOString()};
    });
  }

  async revokeInvitation(id:string) {
    return this.db.transaction(async db => {
      const updated = await db.query(`UPDATE invitations SET revoked_at=clock_timestamp()
        WHERE id=$1 AND accepted_principal_id IS NULL AND revoked_at IS NULL RETURNING id`,[uuid(id)]);
      return {id,revoked:!!updated.rowCount};
    });
  }

  private async redeemInvitation(body:unknown):Promise<ApiResponse> {
    fields(body,['invitation_code','token']);
    if (typeof body.invitation_code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.invitation_code)
      || typeof body.token !== 'string' || !HEX.test(body.token)) fail(400,'invalid_request','Invalid invitation or credential format');
    const codeHash = bytesHash(body.invitation_code);
    const tokenHash = bytesHash(body.token);
    const result = await this.db.transaction(async db => {
      const invite = (await db.query<InvitationRow>('SELECT * FROM invitations WHERE code_hash=$1 FOR UPDATE',[codeHash])).rows[0];
      if (!invite) fail(410,'invalid_invitation','Invitation is unavailable');
      if (invite.accepted_principal_id) {
        // The client creates and retains its new secret before sending. A lost
        // response can be retried without persisting plaintext credentials or
        // allowing another token to take over the already accepted account.
        const principal = (await db.query<{id:string;name:string}>(`SELECT id,name FROM principals
          WHERE id=$1 AND token_hash=$2 AND NOT revoked`,[invite.accepted_principal_id,tokenHash])).rows[0];
        if (!principal) fail(410,'invalid_invitation','Invitation is unavailable');
        return principal;
      }
      const usable = (await db.query(`SELECT 1 FROM invitations WHERE id=$1
        AND revoked_at IS NULL AND expires_at > clock_timestamp()`,[invite.id])).rowCount;
      if (!usable) fail(410,'invalid_invitation','Invitation is unavailable');
      const principal = (await db.query<{id:string;name:string}>(`INSERT INTO principals(id,name,token_hash)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id,name`,[randomUUID(),invite.name,tokenHash])).rows[0];
      if (!principal) fail(409,'conflict','Account name or credential is already in use');
      await db.query(`UPDATE invitations SET accepted_at=clock_timestamp(),accepted_principal_id=$2 WHERE id=$1`,[invite.id,principal.id]);
      return principal;
    });
    return {status:200,body:result};
  }

  private async actor(db: PoolClient, token?: string): Promise<PrincipalRow | null> {
    if (!token) return null;
    const actor = (await db.query<PrincipalRow>('SELECT id,name FROM principals WHERE token_hash=$1 AND NOT revoked', [bytesHash(token)])).rows[0];
    if (!actor) fail(401, 'unauthorized', 'Invalid or revoked token');
    return actor;
  }
  private async pkg(db: PoolClient, id: string): Promise<PackageRow> {
    const pkg = (await db.query<PackageRow>('SELECT * FROM packages WHERE id=$1', [uuid(id)])).rows[0];
    if (!pkg) fail(404, 'not_found', 'Package not found');
    return pkg;
  }
  private async role(db: PoolClient, pkg: PackageRow, actor: PrincipalRow | null): Promise<string | null> {
    if (!actor) return null;
    const active = (await db.query<PrincipalRow>('SELECT id FROM principals WHERE id=$1 AND NOT revoked', [actor.id])).rows[0];
    if (!active) return null;
    if (pkg.owner_id === actor.id) return 'owner';
    return (await db.query<{role:string}>('SELECT role FROM memberships WHERE package_id=$1 AND principal_id=$2', [pkg.id, actor.id])).rows[0]?.role ?? null;
  }
  private async access(db: PoolClient, pkg: PackageRow, actor: PrincipalRow | null, action: 'read' | 'write' | 'owner' | 'draft' = 'read') {
    const role = await this.role(db, pkg, actor);
    if (role === 'owner' || (action !== 'owner' && role === 'maintainer') || ((action === 'read' || action === 'draft') && role === 'viewer') || (action === 'read' && pkg.visibility === 'public')) return;
    fail(actor ? 403 : 401, 'forbidden', 'Current package permission does not allow this action');
  }
  private async candidate(db: PoolClient, id: string): Promise<CandidateRow> {
    const candidate = (await db.query<CandidateRow>('SELECT * FROM candidates WHERE id=$1', [uuid(id)])).rows[0];
    if (!candidate) fail(404, 'not_found', 'Candidate not found');
    return candidate;
  }
  private async snapshot(db: PoolClient, digest: string): Promise<Snapshot> {
    if (!HEX.test(digest)) fail(404, 'not_found', 'Snapshot not found');
    const snapshot = (await db.query<{descriptor:unknown}>('SELECT descriptor FROM snapshots WHERE digest=$1', [digest])).rows[0]?.descriptor;
    if (!snapshot) fail(404, 'not_found', 'Snapshot not found');
    if (snapshotDigest(validateSnapshot(snapshot)) !== digest) fail(500, 'corrupt_storage', 'Snapshot content digest does not match');
    return validateSnapshot(snapshot);
  }
  private async release(db: PoolClient, packageId: string, version: string): Promise<ReleaseRow> {
    const release = (await db.query<ReleaseRow>(`SELECT r.*,
      EXISTS(SELECT 1 FROM release_events e WHERE e.release_id=r.id AND e.kind='withdrawal') AS withdrawn,
      EXISTS(SELECT 1 FROM release_events e WHERE e.release_id=r.id AND e.kind='verification_revocation') AS verification_revoked
      FROM releases r WHERE r.package_id=$1 AND r.version=$2`, [packageId, version])).rows[0];
    if (!release) fail(404, 'not_found', 'Published package version not found');
    return release;
  }

  private async snapshotAccess(db: PoolClient, snapshot: Snapshot, actor: PrincipalRow | null) {
    const pkg = await this.pkg(db, snapshot.package_id);
    if (await this.role(db, pkg, actor)) return;
    await this.access(db, pkg, actor);
    const released = (await db.query('SELECT id FROM releases WHERE package_id=$1 AND snapshot_digest=$2', [pkg.id, snapshotDigest(snapshot)])).rows[0];
    if (!released) fail(404, 'not_found', 'Unpublished snapshot is private');
  }

  // Every traversal follows immutable, exact dependency references. No version
  // ranges are resolved on the server and no transitive dependency is replaced.
  private async graph(db: PoolClient, root: Snapshot, actor: PrincipalRow | null, mode: 'read' | 'select', requirePublic = false): Promise<Snapshot[]> {
    const nodes = new Map<string, { digest: string; version: string; snapshot: Snapshot }>();
    const visiting = new Set<string>();
    let totalBytes = 0;
    let totalFiles = 0;
    const visit = async (snapshot: Snapshot, isRoot: boolean) => {
      const digest = snapshotDigest(snapshot);
      const previous = nodes.get(snapshot.package_id);
      if (visiting.has(snapshot.package_id)) fail(409, 'dependency_cycle', 'Dependency graph contains a cycle');
      if (previous) {
        if (previous.digest !== digest || previous.version !== snapshot.version) fail(409, 'dependency_conflict', 'One package has conflicting exact dependency versions');
        return;
      }
      if (nodes.size >= 1024) fail(413, 'dependency_budget', 'Dependency graph exceeds 1024 packages');
      totalFiles += snapshot.files.length;
      for (const file of snapshot.files) totalBytes += file.byte_length;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > 256 * 1024 * 1024 || totalFiles > 16384) fail(413,'dependency_budget','Dependency graph exceeds its byte or file budget');
      nodes.set(snapshot.package_id, { digest, version: snapshot.version, snapshot });
      visiting.add(snapshot.package_id);
      if (!isRoot) {
        await this.snapshotAccess(db, snapshot, actor);
        const pkg = await this.pkg(db, snapshot.package_id);
        if (requirePublic && pkg.visibility !== 'public') fail(409, 'private_dependency', 'Public release requires public dependencies');
      }
      for (const dependency of snapshot.dependencies) {
        await this.access(db,await this.pkg(db,dependency.package_id),actor,'read');
        const release = await this.release(db, dependency.package_id, dependency.version);
        if (release.snapshot_digest !== dependency.snapshot_digest) fail(409, 'dependency_substitution', 'Dependency snapshot differs from its immutable published version');
        if (mode === 'select' && (release.withdrawn || release.verification_revoked)) fail(409, 'dependency_unavailable', 'A selected dependency is withdrawn or its verification is revoked');
        const next = await this.snapshot(db, dependency.snapshot_digest);
        if (next.package_id !== dependency.package_id || next.version !== dependency.version) fail(409, 'dependency_substitution', 'Dependency identity does not match snapshot');
        if (next.toolchain_digest !== root.toolchain_digest) fail(409, 'toolchain_conflict', 'Dependency uses a different fixed toolchain');
        await visit(next, false);
      }
      visiting.delete(snapshot.package_id);
    };
    await visit(root, true);
    return [...nodes.values()].filter(node => node.snapshot.package_id !== root.package_id).sort((a,b) => a.snapshot.package_id.localeCompare(b.snapshot.package_id)).map(node => node.snapshot);
  }
  private inputDigest(snapshot: Snapshot, dependencies: Snapshot[], policyDigest: string) {
    return digest('Pebble.VerificationInput.v1', { root_snapshot_digest: snapshotDigest(snapshot),
      dependency_snapshots: [...dependencies].sort((a,b) => a.package_id.localeCompare(b.package_id)).map(dependency => ({package_id:dependency.package_id,snapshot_digest:snapshotDigest(dependency)})),
      toolchain_digest: snapshot.toolchain_digest, policy_digest: policyDigest });
  }
  private async bundle(snapshot: Snapshot): Promise<Bundle> {
    const blobs = [];
    for (const digest of [...new Set(snapshot.files.map(file => file.sha256))]) {
      const bytes = await this.options.objectStore.get(digest);
      if (bytesHash(bytes) !== digest) fail(500, 'corrupt_storage', 'Stored source object failed digest verification');
      blobs.push({ sha256: digest, content_base64: bytes.toString('base64') });
    }
    return { snapshot, blobs };
  }
  private async currentSettings(db: PoolClient): Promise<SettingsRow> {
    return (await db.query<SettingsRow>('SELECT * FROM registry_settings WHERE singleton')).rows[0]!;
  }
  private async event(db: PoolClient, kind: string, resourceId: string, payload: unknown) {
    await db.query('INSERT INTO outbox_events(id,kind,resource_id,payload) VALUES($1,$2,$3,$4)', [randomUUID(), kind, resourceId, payload]);
  }

  async request(method: string, path: string, body: unknown = {}, token?: string, headers: Record<string, string | undefined> = {}): Promise<ApiResponse> {
    const write = method !== 'GET' && method !== 'HEAD';
    try {
      const pathname = new URL(path,'http://registry.invalid').pathname;
      if (method === 'POST' && pathname === '/api/v1/invitations/redeem') {
        if (path.split('?')[0] !== pathname) fail(404,'not_found','Route not found');
        return await this.redeemInvitation(body);
      }
      if (write) string(headers['idempotency-key'],'Idempotency-Key',200);
      // Staging S3 operations occur outside SQL transactions. State and current
      // authorization are checked again in the eventual mutation transaction.
      if (method === 'POST' && (/\/snapshots$/.test(pathname) || /\/publish$/.test(pathname))) {
        const prepared = await this.db.transaction(async db => {
          const actor = await this.actor(db, token);
          const route = await this.routeContext(db, method, path, actor);
          if (route.operation === 'upload') {
            let bundle:Bundle;
            try { bundle = validateBundle(body); } catch (error) { return fail(400,'invalid_bundle',(error as Error).message); }
            if (bundle.snapshot.package_id !== route.pkg.id) fail(400,'package_mismatch','Snapshot belongs to a different package');
            return {bundle,objects:[] as string[]};
          }
          if (route.operation === 'publish') {
            const {snapshot,dependencies} = await this.checkCandidateInput(db,route.candidate,actor);
            return {bundle:null,objects:[...new Set([snapshot,...dependencies].flatMap(snapshot => snapshot.files.map(file => file.sha256)))]};
          }
          return {bundle:null,objects:[] as string[]};
        },false);
        if (prepared.bundle) for (const blob of prepared.bundle.blobs) await this.options.objectStore.put(blob.sha256,Buffer.from(blob.content_base64,'base64'));
        for (const digest of prepared.objects) if (!(await this.options.objectStore.has(digest))) fail(409,'missing_object','A prepared source object is unavailable');
      }
      const response = await this.db.transaction<ApiResponse>(async db => {
        const actor = await this.actor(db, token);
        if (write && !actor) fail(401, 'unauthorized', 'A bearer token is required');
        const route = await this.routeContext(db, method, path, actor);
        if (!write) return this.read(db, route, actor);
        const key = headers['idempotency-key'];
        string(key, 'Idempotency-Key', 200);
        let requestDigest: string;
        try { requestDigest = hash({ body, if_match: headers['if-match'] ?? null }); }
        catch { return fail(400,'invalid_request','Request contains unsupported canonical JSON values'); }
        const previous = (await db.query<IdempotencyRow>('SELECT * FROM idempotency_keys WHERE principal_id=$1 AND method=$2 AND path=$3 AND key=$4', [actor!.id, method, path, key])).rows[0];
        if (previous) {
          if (previous.request_digest !== requestDigest) fail(409, 'idempotency_conflict', 'Idempotency key was used with different request content');
          // routeContext has already reauthorized; dependent material must also
          // remain readable before a previously saved private response is sent.
          if ('candidate' in route) await this.graph(db, await this.snapshot(db, route.candidate.snapshot_digest), actor, 'read');
          if ('snapshot' in route) await this.graph(db, route.snapshot, actor, 'read');
          if (route.operation === 'create_candidate' || route.operation === 'upload') {
            const previousBody = previous.response as {snapshot_digest?:string;id?:string};
            const digest = previousBody.snapshot_digest ?? (previousBody.id ? (await this.candidate(db,previousBody.id)).snapshot_digest : undefined);
            if (digest) await this.graph(db,await this.snapshot(db,digest),actor,'read');
          }
          if (route.operation === 'publish' || route.operation === 'withdrawals' || route.operation === 'revocations') {
            const stored = previous.response as {package_id:string;version:string};
            return {status:previous.status,body:this.releaseResponse(await this.release(db,stored.package_id,stored.version))};
          }
          return { status: previous.status, body: previous.response };
        }
        const response = await this.mutate(db, route, body, actor!, headers);
        await db.query(`INSERT INTO idempotency_keys(principal_id,method,path,key,request_digest,status,response)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor!.id, method, path, key, requestDigest, response.status, response.body]);
        return response;
      }, write);
      if (response.preparedSnapshot) {
        const bundle = await this.bundle(response.preparedSnapshot);
        // A slow object download cannot bypass a revocation that completed while
        // S3 was serving bytes. No private content is sent before this recheck.
        await this.db.transaction(async db => {
          const actor = await this.actor(db,token);
          await this.snapshotAccess(db,response.preparedSnapshot!,actor);
          await this.graph(db,response.preparedSnapshot!,actor,'read');
        },false);
        return {status:response.status,body:bundle};
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) return { status: error.status, body: { error: error.code, message: error.message } };
      if ((error as {code?: string}).code === '23505') {
        // A concurrent identical publication can encounter the release UNIQUE
        // index before SSI reports a serialization failure. Its winner has now
        // committed; re-enter normal current authorization and replay handling.
        const saved = token && headers['idempotency-key'] ? (await this.db.pool.query(`SELECT 1 FROM idempotency_keys i
          JOIN principals p ON p.id=i.principal_id WHERE p.token_hash=$1 AND NOT p.revoked
          AND i.method=$2 AND i.path=$3 AND i.key=$4`,[bytesHash(token),method,path,headers['idempotency-key']])).rowCount : 0;
        if (saved) return this.request(method,path,body,token,headers);
        return { status: 409, body: { error: 'conflict', message: 'An immutable identity or idempotency key already exists' } };
      }
      if (['40001','40P01'].includes((error as {code?: string}).code ?? '')) return { status: 503, body: { error: 'transaction_retry', message: 'Concurrent state change; retry the same idempotent request' } };
      throw error;
    }
  }

  private async routeContext(db: PoolClient, method: string, path: string, actor: PrincipalRow | null): Promise<Route> {
    const parsed = new URL(path,'http://registry.invalid');
    path = parsed.pathname;
    const base = { method, path, query:parsed.searchParams };
    if (path === '/api/v1/meta' && method === 'GET') return { ...base, operation: 'meta' };
    if (path === '/api/v1/packages' && method === 'POST') return { ...base, operation: 'create_package' };
    const candidateMatch = /^\/api\/v1\/candidates\/([^/]+)(?:\/(retry|review|publish))?$/.exec(path);
    if (candidateMatch && ((method === 'GET' && !candidateMatch[2]) || (method === 'POST' && candidateMatch[2]))) {
      const candidate = await this.candidate(db, candidateMatch[1]!);
      const pkg = await this.pkg(db, candidate.package_id);
      await this.access(db, pkg, actor, method === 'GET' ? 'draft' : 'write');
      const operation = candidateMatch[2] as 'retry'|'review'|'publish'|undefined;
      return { ...base, pkg, candidate, operation: operation ?? 'candidate' };
    }
    const packageMatch = /^\/api\/v1\/packages\/([^/]+)(.*)$/.exec(path);
    if (!packageMatch) return fail(404, 'not_found', 'Route not found');
    const pkg = await this.pkg(db, packageMatch[1]!);
    const tail = packageMatch[2]!;
    let operation: PackageOperation;
    let principal: string | undefined;
    let version: string | undefined;
    if (!tail && method === 'GET') operation = 'package';
    else if (tail === '/visibility' && method === 'PUT') operation = 'visibility';
    else if (/^\/members\/[^/]+$/.test(tail) && ['PUT','DELETE'].includes(method)) { operation = 'member'; principal = uuid(tail.split('/')[2]!); }
    else if (tail === '/snapshots' && method === 'POST') operation = 'upload';
    else if (tail === '/candidates' && method === 'POST') operation = 'create_candidate';
    else if (tail === '/versions' && method === 'GET') operation = 'versions';
    else if (/^\/snapshots\/[a-f0-9]{64}$/.test(tail) && method === 'GET') {
      const snapshot = await this.snapshot(db, tail.split('/')[2]!);
      if (snapshot.package_id !== pkg.id) return fail(404, 'not_found', 'Snapshot not found in package');
      await this.snapshotAccess(db, snapshot, actor);
      return { ...base, pkg, snapshot, operation: 'snapshot' };
    } else {
      const match = /^\/versions\/([^/]+)(?:\/(withdrawals|revocations))?$/.exec(tail);
      if (!match || !((method === 'GET' && !match[2]) || (method === 'POST' && match[2]))) return fail(404, 'not_found', 'Route not found');
      version = decodeURIComponent(match[1]!);
      operation = (match[2] as 'withdrawals'|'revocations'|undefined) ?? 'version';
    }
    await this.access(db, pkg, actor, ['visibility','member'].includes(operation) ? 'owner' : method === 'GET' ? 'read' : 'write');
    return { ...base, pkg, operation, principal, version };
  }

  private async read(db: PoolClient, route: Route, actor: PrincipalRow | null): Promise<ApiResponse> {
    let body: unknown;
    switch (route.operation) {
      case 'meta': {
        const settings = await this.currentSettings(db);
        body = { registry_id: settings.registry_id, registration:'invitation_only', toolchain_digest: settings.toolchain_digest, toolchain: settings.toolchain, policy_digest: settings.policy_digest }; break;
      }
      case 'package': body = route.pkg; break;
      case 'snapshot': await this.graph(db, route.snapshot, actor, 'read'); return {status:200,body:null,preparedSnapshot:route.snapshot};
      case 'candidate': {
        await this.graph(db, await this.snapshot(db, route.candidate.snapshot_digest), actor, 'read');
        const attempt = (await db.query<AttemptRow>(`SELECT a.* FROM verification_attempts a JOIN verification_jobs j ON j.id=a.job_id
          WHERE j.candidate_id=$1 ORDER BY a.attempt DESC LIMIT 1`, [route.candidate.id])).rows[0] ?? null;
        const review = (await db.query<ReviewRow>('SELECT * FROM research_reviews WHERE candidate_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [route.candidate.id])).rows[0] ?? null;
        body = { ...route.candidate, verification: attempt, review }; break;
      }
      case 'version': {
        const release = await this.release(db, route.pkg.id, route.version!);
        await this.graph(db, await this.snapshot(db, release.snapshot_digest), actor, 'read');
        body = this.releaseResponse(release); break;
      }
      case 'versions': {
        const limitText = route.query.get('limit') ?? '50';
        if (!/^[1-9][0-9]?$|^100$/.test(limitText)) fail(400,'invalid_request','Version page limit must be between 1 and 100');
        const limit = Number(limitText);
        const cursor = route.query.get('cursor');
        if (cursor) {
          uuid(cursor);
          const anchor = (await db.query<{snapshot_digest:string}>('SELECT snapshot_digest FROM releases WHERE id=$1 AND package_id=$2',[cursor,route.pkg.id])).rows[0];
          if (!anchor) fail(400,'invalid_cursor','Version cursor is unavailable');
          try { await this.graph(db,await this.snapshot(db,anchor.snapshot_digest),actor,'read'); }
          catch (error) { if (error instanceof ApiError && [401,403,404].includes(error.status)) fail(400,'invalid_cursor','Version cursor is unavailable'); throw error; }
        }
        // Apply the complete dependency ACL before LIMIT. Filtering a selected
        // page afterwards would hide later readable releases and leak scan IDs.
        const rows = (await db.query<{id:string;version:string}>(`SELECT r.id,r.version FROM releases r WHERE r.package_id=$1
          AND ($2::uuid IS NULL OR (r.published_at,r.id) > (SELECT published_at,id FROM releases WHERE id=$2 AND package_id=$1))
          AND NOT EXISTS (
            WITH RECURSIVE closure(digest) AS (
              SELECT r.snapshot_digest
              UNION
              SELECT dep.value->>'snapshot_digest' FROM closure c JOIN snapshots s ON s.digest=c.digest
                CROSS JOIN LATERAL jsonb_array_elements(s.descriptor->'dependencies') AS dep(value)
            )
            SELECT 1 FROM closure c JOIN snapshots s ON s.digest=c.digest JOIN packages p ON p.id=s.package_id
            WHERE p.visibility<>'public' AND p.owner_id IS DISTINCT FROM $4::uuid
              AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.package_id=p.id AND m.principal_id=$4)
          )
          ORDER BY r.published_at,r.id LIMIT $3`, [route.pkg.id,cursor,limit+1,actor?.id ?? null])).rows;
        const versions = [];
        for (const row of rows) {
          const release = await this.release(db, route.pkg.id, row.version);
          try { await this.graph(db, await this.snapshot(db, release.snapshot_digest), actor, 'read'); }
          catch (error) { if (error instanceof ApiError && [401,403,404].includes(error.status)) continue; throw error; }
          versions.push(this.releaseResponse(release));
        }
        const hasNext = versions.length > limit;
        body = { versions:versions.slice(0,limit),next_cursor:hasNext ? versions[limit-1]!.id : null }; break;
      }
      default: return fail(404, 'not_found', 'Route not found');
    }
    return { status: 200, body };
  }
  private releaseResponse(release: ReleaseRow) {
    return { ...release, withdrawn: release.withdrawn ?? false, verification_revoked: release.verification_revoked ?? false,
      citation_path: `/api/v1/packages/${release.package_id}/versions/${encodeURIComponent(release.version)}` };
  }

  private async mutate(db: PoolClient, route: Route, body: unknown, actor: PrincipalRow, headers: Record<string,string|undefined>): Promise<ApiResponse> {
    switch (route.operation) {
      case 'create_package': {
        fields(body, ['name']); string(body.name, 'package name', 200);
        if (!/^@?[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?$/.test(body.name)) fail(400, 'invalid_request', 'Invalid package name');
        const id = randomUUID();
        await db.query('INSERT INTO packages(id,name,owner_id) VALUES($1,$2,$3)', [id, body.name, actor.id]);
        await this.event(db, 'package.created', id, { actor_id: actor.id });
        return { status: 201, body: { id, name: body.name, visibility: 'private' } };
      }
      case 'member': {
        if (route.principal === route.pkg.owner_id) fail(409, 'owner_membership', 'Package ownership cannot be changed through membership');
        const target = (await db.query<PrincipalRow>('SELECT id FROM principals WHERE id=$1 AND NOT revoked', [route.principal])).rows[0];
        if (!target) fail(404, 'not_found', 'Principal not found');
        if (route.method === 'PUT') {
          fields(body, ['role']);
          if (body.role !== 'viewer' && body.role !== 'maintainer') fail(400, 'invalid_request', 'Invalid membership role');
          await db.query('INSERT INTO memberships(package_id,principal_id,role) VALUES($1,$2,$3) ON CONFLICT(package_id,principal_id) DO UPDATE SET role=EXCLUDED.role', [route.pkg.id, route.principal, body.role]);
        } else { fields(body, []); await db.query('DELETE FROM memberships WHERE package_id=$1 AND principal_id=$2', [route.pkg.id, route.principal]); }
        await this.event(db, 'package.membership_changed', route.pkg.id, { actor_id: actor.id, principal_id: route.principal });
        return { status: 200, body: { package_id: route.pkg.id, principal_id: route.principal, role: route.method === 'DELETE' ? null : (body as JsonObject).role } };
      }
      case 'visibility': {
        fields(body, ['visibility']);
        if (body.visibility !== 'public' && body.visibility !== 'private') fail(400, 'invalid_request', 'Invalid visibility');
        if (body.visibility === 'public') {
          const releases = (await db.query<{snapshot_digest:string}>('SELECT snapshot_digest FROM releases WHERE package_id=$1', [route.pkg.id])).rows;
          for (const release of releases) await this.graph(db, await this.snapshot(db, release.snapshot_digest), actor, 'read', true);
        }
        await db.query('UPDATE packages SET visibility=$1 WHERE id=$2', [body.visibility, route.pkg.id]);
        await this.event(db, 'package.visibility_changed', route.pkg.id, { actor_id: actor.id, visibility: body.visibility });
        return { status: 200, body: { id: route.pkg.id, visibility: body.visibility } };
      }
      case 'upload': {
        try { validateBundle(body as Bundle); } catch (error) { return fail(400, 'invalid_bundle', (error as Error).message); }
        const bundle = body as Bundle;
        if (bundle.snapshot.package_id !== route.pkg.id) fail(400, 'package_mismatch', 'Snapshot is bound to a different package');
        const settings = await this.currentSettings(db);
        if (bundle.snapshot.toolchain_digest !== settings.toolchain_digest) fail(409, 'toolchain_mismatch', 'Snapshot uses a different toolchain');
        await this.graph(db, bundle.snapshot, actor, 'select', route.pkg.visibility === 'public');
        const digest = snapshotDigest(bundle.snapshot);
        const released = (await db.query<{snapshot_digest:string}>('SELECT snapshot_digest FROM releases WHERE package_id=$1 AND version=$2', [route.pkg.id,bundle.snapshot.version])).rows[0];
        if (released && released.snapshot_digest !== digest) fail(409, 'immutable_version', 'Published version cannot be overwritten');
        for (const blob of bundle.blobs) {
          const bytes = Buffer.from(blob.content_base64, 'base64');
          await db.query('INSERT INTO blobs(digest,byte_length) VALUES($1,$2) ON CONFLICT DO NOTHING', [blob.sha256, bytes.length]);
        }
        await db.query('INSERT INTO snapshots(digest,package_id,version,descriptor) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [digest, route.pkg.id,bundle.snapshot.version,bundle.snapshot]);
        for (const file of bundle.snapshot.files) await db.query('INSERT INTO snapshot_blobs(snapshot_digest,blob_digest) VALUES($1,$2) ON CONFLICT DO NOTHING', [digest, file.sha256]);
        return { status: 201, body: { snapshot_digest: digest } };
      }
      case 'create_candidate': {
        fields(body, ['snapshot_digest']); string(body.snapshot_digest, 'snapshot digest', 64);
        const snapshot = await this.snapshot(db, body.snapshot_digest);
        if (snapshot.package_id !== route.pkg.id) fail(404, 'not_found', 'Snapshot not found in package');
        const settings = await this.currentSettings(db);
        if (snapshot.toolchain_digest !== settings.toolchain_digest) fail(409, 'toolchain_mismatch', 'Snapshot uses a different toolchain');
        const dependencies = await this.graph(db, snapshot, actor, 'select', route.pkg.visibility === 'public');
        const inputDigest = this.inputDigest(snapshot, dependencies, settings.policy_digest);
        // PostgreSQL predicate conflict detection makes concurrent queue inserts
        // respect these shared quotas across stateless API replicas.
        await this.queueQuota(db,actor.id);
        const id = randomUUID();
        await db.query(`INSERT INTO candidates(id,package_id,snapshot_digest,creator_id,input_digest,toolchain_digest,policy_digest)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [id,route.pkg.id,body.snapshot_digest,actor.id,inputDigest,settings.toolchain_digest,settings.policy_digest]);
        await db.query('INSERT INTO verification_jobs(id,candidate_id,requested_by) VALUES($1,$2,$3)', [randomUUID(),id,actor.id]);
        return { status: 202, body: { id,revision:1,status:'queued' } };
      }
      case 'retry': {
        fields(body, []);
        const candidate = route.candidate;
        if (!['error','timeout','incomplete'].includes(candidate.status)) fail(409, 'not_retryable', 'Only unresolved or incomplete checks can be retried');
        await this.checkCandidateInput(db, candidate, actor);
        await this.queueQuota(db,actor.id);
        await db.query("UPDATE verification_jobs SET state='queued',requested_by=$2,lease_token=NULL,lease_expires_at=NULL,available_at=clock_timestamp() WHERE candidate_id=$1", [candidate.id,actor.id]);
        const updated = (await db.query<Pick<CandidateRow,'id'|'revision'|'status'>>("UPDATE candidates SET status='queued',diagnostic=NULL,revision=revision+1 WHERE id=$1 RETURNING id,revision,status", [candidate.id])).rows[0];
        return { status: 202, body: updated };
      }
      case 'review': {
        fields(body, ['approved','note','source_classification_confirmed']);
        if (typeof body.approved !== 'boolean' || typeof body.source_classification_confirmed !== 'boolean') fail(400, 'invalid_request', 'Review requires explicit boolean decisions');
        string(body.note, 'review note');
        if (route.candidate.status === 'published') fail(409, 'already_published', 'Published review is immutable; use verification revocation for a published problem');
        await this.graph(db, await this.snapshot(db, route.candidate.snapshot_digest), actor, 'read');
        const id = randomUUID();
        await db.query(`INSERT INTO research_reviews(id,candidate_id,reviewer_id,snapshot_digest,approved,source_classification_confirmed,note)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [id,route.candidate.id,actor.id,route.candidate.snapshot_digest,body.approved,body.source_classification_confirmed,body.note]);
        const candidate = (await db.query<Pick<CandidateRow,'id'|'revision'|'status'>>('UPDATE candidates SET revision=revision+1 WHERE id=$1 RETURNING id,revision,status', [route.candidate.id])).rows[0];
        return { status: 200, body: { ...candidate, review_id:id } };
      }
      case 'publish': return this.publish(db, route, body, actor, headers);
      case 'withdrawals': case 'revocations': {
        fields(body, ['reason']); string(body.reason, 'reason');
        const release = await this.release(db, route.pkg.id, route.version!);
        const kind = route.operation === 'withdrawals' ? 'withdrawal' : 'verification_revocation';
        await db.query('INSERT INTO release_events(id,release_id,kind,actor_id,reason) VALUES($1,$2,$3,$4,$5)', [randomUUID(),release.id,kind,actor.id,body.reason]);
        await this.event(db, `release.${kind}`, release.id, { actor_id:actor.id,reason:body.reason });
        return { status:200,body:this.releaseResponse(await this.release(db,route.pkg.id,route.version!)) };
      }
      default: return fail(404,'not_found','Route not found');
    }
  }

  private async checkCandidateInput(db: PoolClient, candidate: CandidateRow, actor: PrincipalRow | null) {
    const pkg = await this.pkg(db, candidate.package_id);
    await this.access(db,pkg,actor,'write');
    const settings = await this.currentSettings(db);
    if (candidate.toolchain_digest !== settings.toolchain_digest || candidate.policy_digest !== settings.policy_digest) fail(409,'stale_policy','Candidate was checked under a different current policy or toolchain');
    const snapshot = await this.snapshot(db,candidate.snapshot_digest);
    const dependencies = await this.graph(db,snapshot,actor,'select',pkg.visibility === 'public');
    if (this.inputDigest(snapshot,dependencies,settings.policy_digest) !== candidate.input_digest) fail(409,'input_mismatch','Candidate input binding does not match fixed content');
    return {snapshot,dependencies};
  }

  private async queueQuota(db:PoolClient,principalId:string) {
    const pending = (await db.query<{total:string;actor_total:string}>(`SELECT count(*) AS total,
      count(*) FILTER (WHERE requested_by=$1) AS actor_total FROM verification_jobs WHERE state IN ('queued','running')`,[principalId])).rows[0]!;
    if (Number(pending.total) >= 1024 || Number(pending.actor_total) >= 4) fail(429,'verification_queue_full','Verification queue quota reached; retry after existing tasks finish');
  }

  private async publish(db: PoolClient, route: CandidateRoute, body: unknown, actor: PrincipalRow, headers: Record<string,string|undefined>): Promise<ApiResponse> {
    fields(body, []);
    const candidate = route.candidate;
    if (headers['if-match'] !== `"${candidate.revision}"`) fail(412,'stale_revision','If-Match must equal the current candidate revision');
    const {snapshot} = await this.checkCandidateInput(db,candidate,actor);
    if (candidate.status !== 'passed') fail(409,'checks_not_passed','Complete current formal checks are required');
    const verification = (await db.query<AttemptRow>(`SELECT a.* FROM verification_attempts a JOIN verification_jobs j ON j.id=a.job_id
      WHERE j.candidate_id=$1 AND a.attempt=j.attempt AND j.state='passed'`, [candidate.id])).rows[0];
    if (!verification || verification.outcome !== 'passed' || verification.input_digest !== candidate.input_digest || !this.formalReport(verification.report)) fail(409,'checks_not_passed','A current controlled complete Slate report is required');
    const review = (await db.query<ReviewRow>('SELECT * FROM research_reviews WHERE candidate_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [candidate.id])).rows[0];
    if (!review?.approved || !review.source_classification_confirmed || review.snapshot_digest !== candidate.snapshot_digest) fail(409,'review_required','Approved research metadata and source classification review is required');
    await this.access(db,route.pkg,{id:review.reviewer_id},'write');
    const id = randomUUID();
    const release = (await db.query<ReleaseRow>(`INSERT INTO releases(id,package_id,version,snapshot_digest,candidate_id,verification_id,review_id,published_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id,route.pkg.id,snapshot.version,candidate.snapshot_digest,candidate.id,verification.id,review.id,actor.id])).rows[0]!;
    await db.query("UPDATE candidates SET status='published',revision=revision+1 WHERE id=$1", [candidate.id]);
    await this.event(db,'release.published',id,{package_id:route.pkg.id,version:snapshot.version,snapshot_digest:candidate.snapshot_digest});
    if (this.options.beforePublishCommit) await this.options.beforePublishCommit();
    return {status:201,body:this.releaseResponse(release)};
  }
  private formalReport(report: unknown) {
    if (!report || typeof report !== 'object') return false;
    const value = report as JsonObject;
    return value.complete === true && value.source_inventory_complete === true && value.formal_checks_eligible === true && value.source_check_policy === 'Slate.SourcePackagePolicy.v1';
  }

  async claimJob(): Promise<JobLease | null> {
    const prepared = await this.db.transaction(async db => {
      const job = (await db.query<JobRow>(`SELECT * FROM verification_jobs WHERE
        (state='queued' AND available_at<=clock_timestamp()) OR (state='running' AND lease_expires_at<=clock_timestamp())
        ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if (!job) return null;
      const candidate = await this.candidate(db,job.candidate_id);
      let inputs;
      try { inputs = await this.checkCandidateInput(db,candidate,{id:job.requested_by}); }
      catch (error) {
        if (!(error instanceof ApiError)) throw error;
        await db.query("UPDATE verification_jobs SET state='error',lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [job.id]);
        await db.query("UPDATE candidates SET status='error',diagnostic=$2,revision=revision+1 WHERE id=$1", [candidate.id,error.message]);
        return null;
      }
      const token = randomUUID();
      const updated = (await db.query<JobRow>(`UPDATE verification_jobs SET state='running',attempt=attempt+1,lease_token=$2,
        lease_expires_at=clock_timestamp()+($3 * interval '1 second') WHERE id=$1 RETURNING *`, [job.id,token,this.options.leaseSeconds ?? 180])).rows[0]!;
      await db.query("UPDATE candidates SET status='running',diagnostic=NULL,revision=revision+1 WHERE id=$1", [candidate.id]);
      return {lease:{id:job.id,candidate_id:candidate.id,token,lease_expires_at:updated.lease_expires_at!.toISOString(),attempt:updated.attempt,
        input_digest:candidate.input_digest,toolchain_digest:candidate.toolchain_digest,policy_digest:candidate.policy_digest,
      },snapshot:inputs.snapshot,dependencies:inputs.dependencies};
    });
    if (!prepared) return null;
    try {
      const root = await this.bundle(prepared.snapshot);
      const dependencies = [];
      for (const snapshot of prepared.dependencies) dependencies.push(await this.bundle(snapshot));
      return {...prepared.lease,root,dependencies};
    } catch (error) {
      // The lease was committed before S3 reads. An infrastructure failure stays
      // unresolved and retryable; no stale attempt can mark this work complete.
      await this.completeJob({...prepared.lease,root:{snapshot:prepared.snapshot,blobs:[]},dependencies:[]}, {
        outcome:'error',input_digest:prepared.lease.input_digest,toolchain_digest:prepared.lease.toolchain_digest,
        policy_digest:prepared.lease.policy_digest,diagnostic:'Source object preparation failed',
      });
      throw error;
    }
  }

  async renewJob(lease: JobLease): Promise<boolean> {
    return this.db.transaction(async db => {
      const result = await db.query(`UPDATE verification_jobs SET lease_expires_at=clock_timestamp()+($4 * interval '1 second')
        WHERE id=$1 AND candidate_id=$2 AND lease_token=$3 AND state='running' AND lease_expires_at>clock_timestamp()`, [lease.id,lease.candidate_id,lease.token,this.options.leaseSeconds ?? 180]);
      return result.rowCount === 1;
    });
  }

  async completeJob(lease: JobLease, result: JobResult): Promise<boolean> {
    return this.db.transaction(async db => {
      const job = (await db.query<JobRow>(`SELECT * FROM verification_jobs WHERE id=$1 AND candidate_id=$2 AND lease_token=$3
        AND state='running' AND lease_expires_at>clock_timestamp() FOR UPDATE`, [lease.id,lease.candidate_id,lease.token])).rows[0];
      if (!job || job.attempt !== lease.attempt) return false;
      const candidate = await this.candidate(db,lease.candidate_id);
      let outcome = result.outcome;
      let diagnostic = result.diagnostic ?? null;
      if (!['passed','incomplete','timeout','error'].includes(outcome)) throw new Error('Unknown controlled worker outcome');
      try {
        const {snapshot,dependencies} = await this.checkCandidateInput(db,candidate,{id:job.requested_by});
        if (result.input_digest !== candidate.input_digest || result.toolchain_digest !== candidate.toolchain_digest || result.policy_digest !== candidate.policy_digest) fail(409,'input_mismatch','Worker report is bound to different input');
        if (outcome === 'passed' && !this.formalReport(result.report)) fail(409,'invalid_report','Slate formal acceptance fields are missing or incomplete');
        if (outcome === 'passed') {
          const expected = [snapshot,...dependencies].flatMap(snapshot => snapshot.files.map(file => ({...file,path:`packages/${snapshot.package_id}/${file.path}`})))
            .sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
          if (!reportMatchesInput(result.report,expected,(await this.currentSettings(db)).policy)) fail(409,'invalid_report','Slate report does not cover every exact fixed source file and declaration');
        }
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        outcome = 'error'; diagnostic = error.message;
      }
      await db.query(`INSERT INTO verification_attempts(id,job_id,attempt,input_digest,outcome,report,report_digest,diagnostic)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(),job.id,job.attempt,candidate.input_digest,outcome,result.report ?? null,result.report ? hash(result.report) : null,diagnostic]);
      await db.query('UPDATE verification_jobs SET state=$2,lease_token=NULL,lease_expires_at=NULL WHERE id=$1', [job.id,outcome]);
      await db.query('UPDATE candidates SET status=$2,diagnostic=$3,revision=revision+1 WHERE id=$1', [candidate.id,outcome,diagnostic]);
      return true;
    });
  }
}
