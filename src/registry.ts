import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Database } from './db.js';
import {
  HASH, LEVELS, VERSION, canonical, compareVersions, digestBytes, downloadKey, indexPath, isReservedPrefix, levelAtLeast,
  parseInterface, parseManifest, parseVersion, prefixConflict, readArchive, renderIndexLine, validateInterfacePath,
  validateName, validatePackagePath, validatePrefix, validatePublishRequest,
  type IndexEntry, type Level, type Manifest, type Policy, type PublishRequest, type Toolchain,
} from './protocol.js';
import type { ObjectStore } from './object-store.js';

type JsonObject = Record<string, unknown>;
interface PrincipalRow { id: string; name?: string; maintainer?: boolean }
interface PackageRow { id: string; name: string; owner_id: string; visibility: 'private'|'public'; created_at: Date }
interface CandidateRow {
  id:string; package_id:string; version:string; level:Level; manifest:string; deps:Array<{name:string;req:string}>; prefixes:string[];
  toolchain:string; cksum:string; iface_cksum:string; creator_id:string; revision:number; status:string; diagnostic:string|null; created_at:Date;
}
interface SettingsRow { registry_id:string; toolchain_digest:string; policy_digest:string; toolchain:Toolchain; policy:Policy }
interface ReviewRow { id:string; candidate_id:string; reviewer_id:string; revision:number; approved:boolean; note:string; created_at:Date }
interface AttemptRow { id:string; job_id:string; attempt:number; outcome:string; report:unknown; report_digest:string|null; computed_level:Level|null; interface_text:string|null; diagnostic:string|null; completed_at:Date }
interface VersionRow {
  id:string; package_id:string; version:string; candidate_id:string; verification_id:string; review_id:string|null; published_by:string;
  published_at:Date; cksum:string; iface_cksum:string; deps:Array<{name:string;req:string}>; prefixes:string[]; toolchain:string;
  interface_text:string; yanked:boolean; yanked_at:Date|null; yanked_by:string|null;
}
interface JobRow { id:string; candidate_id:string; requested_by:string; attempt:number; state:string; lease_token:string|null; lease_expires_at:Date|null; available_at:Date }
interface IdempotencyRow { request_digest:string;status:number;response:unknown }
interface InvitationRow { id:string; name:string; expires_at:Date; revoked_at:Date|null; accepted_principal_id:string|null }
type RouteBase = {method:string;path:string;query:URLSearchParams};
type Route = (RouteBase & {operation:'meta'|'publish'|'yield'|'pending_reviews'|'create_package'})
  | (RouteBase & {operation:'candidate'|'retry'|'review';candidate:CandidateRow;pkg:PackageRow})
  | (RouteBase & {operation:'package'|'visibility'|'member'|'yank'|'unyank';pkg:PackageRow;principal?:string;version?:string});

export interface RegistryOptions {
  databaseUrl: string;
  registryId: string;
  toolchain: Toolchain;
  policy: Policy;
  toolchainDigest: string;
  policyDigest: string;
  /** The `toolchain` tag manifests must name to be checked by this registry's worker. */
  toolchainTag: string;
  objectStore: ObjectStore;
  leaseSeconds?: number;
  // A test can abort a transaction after insertion to exercise real rollback.
  beforePublishCommit?: () => Promise<void>;
}
export interface JobLease {
  id: string; candidate_id: string; token: string; lease_expires_at: string; attempt: number;
  name: string; version: string; level: Level; deps: Array<{name:string;req:string}>; prefixes: string[];
  toolchain: string; cksum: string; iface_cksum: string; creator_maintainer: boolean;
}
export interface JobResult {
  outcome: 'passed' | 'rejected' | 'incomplete' | 'timeout' | 'error';
  report?: unknown;
  computed_level?: Level;
  interface_text?: string;
  diagnostic?: string;
}
/** Everything a worker needs to build an offline `file://` mirror for one dependency closure. */
export interface MirrorMaterials {
  index: Array<{ path: string; text: string }>;
  archives: Array<{ key: string; name: string; version: string; suffix: 'slatepkg' | 'interface' }>;
}
export interface ApiResponse { status: number; body: unknown; afterCommit?: () => Promise<void> }
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new ApiError(status, code, message); }
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const bytesHash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = HASH;
export const STAGING_PREFIX = 'staging';
export const PUBLIC_PREFIX = 'public';
function object(value: unknown): asserts value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request', 'Expected an object');
}
function fields(body: unknown, keys: string[], optional: string[] = []): asserts body is JsonObject {
  object(body);
  const present = Object.keys(body);
  if (keys.some(key => !present.includes(key)) || present.some(key => !keys.includes(key) && !optional.includes(key))) {
    fail(400, 'invalid_request', `Expected fields: ${keys.join(', ')}${optional.length ? ` (optional: ${optional.join(', ')})` : ''}`);
  }
}
function string(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_request', `Invalid ${label}`);
}
function uuid(value: string) { if (!UUID.test(value)) fail(404, 'not_found', 'Resource not found'); return value; }
function stagingKey(name: string, version: string, digest: string, suffix: 'slatepkg' | 'interface') {
  return `${STAGING_PREFIX}/${name}/${version}/${digest}.${suffix}`;
}
export function publicKey(key: string) { return `${PUBLIC_PREFIX}/${key}`; }

/** The public read roots advertised in `config.json`; overridable for local runs. */
export function indexConfig() {
  return {
    index: process.env.PEBBLE_INDEX_ROOT ?? 'https://index.verifiable.ai/',
    dl: process.env.PEBBLE_DL_TEMPLATE ?? 'https://static.verifiable.ai/packages/{package}/{version}/{package}-{version}',
    api: process.env.PEBBLE_API_ROOT ?? 'https://slate.verifiable.ai/api/v1',
  };
}

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
      if (!(await db.query('SELECT 1 FROM schema_migrations WHERE version=3')).rowCount) {
        throw new Error('Registry schema requires migration 3; run the operator migration command');
      }
      const old = (await db.query<SettingsRow>('SELECT * FROM registry_settings WHERE singleton')).rows[0];
      if (old && old.registry_id !== this.options.registryId) throw new Error('Registry identity differs from persisted state');
      if (old && (old.toolchain_digest !== this.options.toolchainDigest || old.policy_digest !== this.options.policyDigest)) {
        if (!migrate) throw new Error('Running nodes must use the persisted policy and toolchain; operator migration is required to change them');
        await db.query('UPDATE registry_settings SET toolchain_digest=$1,policy_digest=$2,toolchain=$3,policy=$4 WHERE singleton',
          [this.options.toolchainDigest, this.options.policyDigest, this.options.toolchain, this.options.policy]);
        return;
      }
      if (old) return;
      if (!migrate) throw new Error('Registry has not been bootstrapped; run the operator migration command');
      await db.query(`INSERT INTO registry_settings(singleton,registry_id,toolchain_digest,policy_digest,toolchain,policy)
        VALUES(true,$1,$2,$3,$4,$5) ON CONFLICT(singleton) DO NOTHING`,
      [this.options.registryId, this.options.toolchainDigest, this.options.policyDigest, this.options.toolchain, this.options.policy]);
    }, migrate);
    if (migrate) await this.writeIndexConfig();
  }
  async close() { await this.db.close(); }

  /** `config.json` at the index root, from the advertised roots. */
  async writeIndexConfig() {
    const { dl, api } = indexConfig();
    await this.options.objectStore.put(publicKey('index/config.json'), Buffer.from(JSON.stringify({ dl, api }) + '\n'), { contentType: 'application/json' });
  }

  // Operator-only provisioning: deliberately absent from the public HTTP API.
  async provisionPrincipal(input: { id?: string; name: string; token: string; maintainer?: boolean }) {
    string(input.name, 'principal name', 200);
    string(input.token, 'token', 512);
    if (input.token.length < 24) throw new Error('Principal tokens must contain at least 24 characters');
    return this.db.transaction(async db => {
      const existing = (await db.query<PrincipalRow>('SELECT id FROM principals WHERE name=$1', [input.name])).rows[0];
      const id = existing?.id ?? input.id ?? randomUUID();
      await db.query(`INSERT INTO principals(id,name,token_hash,maintainer) VALUES($1,$2,$3,$4)
        ON CONFLICT(name) DO UPDATE SET token_hash=EXCLUDED.token_hash,revoked=false,maintainer=EXCLUDED.maintainer`,
      [id, input.name, bytesHash(input.token), input.maintainer ?? false]);
      return { id, name: input.name, maintainer: input.maintainer ?? false };
    });
  }
  async revokePrincipal(id: string) {
    await this.db.transaction(async db => { await db.query('UPDATE principals SET revoked=true WHERE id=$1', [uuid(id)]); });
  }
  /** Membership of the maintainer organization: publishes without community review and may yank any version. */
  async setMaintainer(name: string, maintainer: boolean) {
    return this.db.transaction(async db => {
      const updated = (await db.query<{id:string}>('UPDATE principals SET maintainer=$2 WHERE name=$1 AND NOT revoked RETURNING id', [name, maintainer])).rows[0];
      if (!updated) throw new Error('Principal not found');
      return { id: updated.id, name, maintainer };
    });
  }
  /** Operator transfer of a package (and its prefixes) to another principal. */
  async transferPackage(name: string, ownerName: string) {
    return this.db.transaction(async db => {
      const pkg = (await db.query<PackageRow>('SELECT * FROM packages WHERE name=$1', [name])).rows[0];
      if (!pkg) throw new Error('Package not found');
      const owner = (await db.query<PrincipalRow>('SELECT id FROM principals WHERE name=$1 AND NOT revoked', [ownerName])).rows[0];
      if (!owner) throw new Error('Principal not found');
      await db.query('UPDATE packages SET owner_id=$2 WHERE id=$1', [pkg.id, owner.id]);
      await db.query('DELETE FROM memberships WHERE package_id=$1 AND principal_id=$2', [pkg.id, owner.id]);
      await this.event(db, 'package.transferred', pkg.id, { owner_id: owner.id });
      return { name, owner: ownerName };
    });
  }

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
    const actor = (await db.query<PrincipalRow>('SELECT id,name,maintainer FROM principals WHERE token_hash=$1 AND NOT revoked', [bytesHash(token)])).rows[0];
    if (!actor) fail(401, 'unauthorized', 'Invalid or revoked token');
    return actor;
  }
  private async pkgByName(db: PoolClient, name: string): Promise<PackageRow> {
    try { validateName(name); } catch { fail(404, 'not_found', 'Package not found'); }
    const pkg = (await db.query<PackageRow>('SELECT * FROM packages WHERE name=$1', [name])).rows[0];
    if (!pkg) fail(404, 'not_found', 'Package not found');
    return pkg;
  }
  private async role(db: PoolClient, pkg: PackageRow, actor: PrincipalRow | null): Promise<string | null> {
    if (!actor) return null;
    const active = (await db.query<PrincipalRow>('SELECT id,maintainer FROM principals WHERE id=$1 AND NOT revoked', [actor.id])).rows[0];
    if (!active) return null;
    if (pkg.owner_id === actor.id) return 'owner';
    if (active.maintainer) return 'registry_maintainer';
    return (await db.query<{role:string}>('SELECT role FROM memberships WHERE package_id=$1 AND principal_id=$2', [pkg.id, actor.id])).rows[0]?.role ?? null;
  }
  private async access(db: PoolClient, pkg: PackageRow, actor: PrincipalRow | null, action: 'read' | 'write' | 'owner' = 'read') {
    const role = await this.role(db, pkg, actor);
    if (role === 'owner' || (action !== 'owner' && (role === 'maintainer' || role === 'registry_maintainer'))
        || (action === 'read' && (role === 'viewer' || pkg.visibility === 'public'))) return;
    fail(actor ? 403 : 401, 'forbidden', 'Current package permission does not allow this action');
  }
  private async candidate(db: PoolClient, id: string): Promise<CandidateRow> {
    const candidate = (await db.query<CandidateRow>('SELECT * FROM candidates WHERE id=$1', [uuid(id)])).rows[0];
    if (!candidate) fail(404, 'not_found', 'Candidate not found');
    return candidate;
  }
  private async currentSettings(db: PoolClient): Promise<SettingsRow> {
    return (await db.query<SettingsRow>('SELECT * FROM registry_settings WHERE singleton')).rows[0]!;
  }
  private async event(db: PoolClient, kind: string, resourceId: string, payload: unknown) {
    await db.query('INSERT INTO outbox_events(id,kind,resource_id,payload) VALUES($1,$2,$3,$4)', [randomUUID(), kind, resourceId, payload]);
  }
  private async maintainer(db: PoolClient, principalId: string): Promise<boolean> {
    return !!(await db.query<{maintainer:boolean}>('SELECT maintainer FROM principals WHERE id=$1 AND NOT revoked', [principalId])).rows[0]?.maintainer;
  }

  async request(method: string, path: string, body: unknown = {}, token?: string, headers: Record<string, string | undefined> = {}): Promise<ApiResponse> {
    const write = method !== 'GET' && method !== 'HEAD';
    try {
      const pathname = new URL(path,'http://registry.invalid').pathname;
      if (method === 'POST' && pathname === '/api/v1/invitations/redeem') {
        if (path.split('?')[0] !== pathname) fail(404,'not_found','Route not found');
        return await this.redeemInvitation(body);
      }
      // Archive staging happens outside SQL transactions; state and current
      // authorization are checked again in the mutation transaction.
      let publish: PublishRequest | undefined;
      if (method === 'PUT' && pathname === '/api/v1/packages/new') {
        publish = await this.stagePublish(body, token);
      }
      const response = await this.db.transaction<ApiResponse>(async db => {
        const actor = await this.actor(db, token);
        if (write && !actor) fail(401, 'unauthorized', 'A bearer token is required');
        const route = await this.routeContext(db, method, path, actor);
        if (!write) return this.read(db, route, actor);
        const key = headers['idempotency-key'];
        if (key === undefined) return this.mutate(db, route, body, actor!, publish);
        string(key, 'Idempotency-Key', 200);
        let requestDigest: string;
        try { requestDigest = hash({ body: publish ? { name: publish.name, version: publish.version, cksum: publish.cksum, iface_cksum: publish.iface_cksum } : body }); }
        catch { return fail(400,'invalid_request','Request contains unsupported canonical JSON values'); }
        const previous = (await db.query<IdempotencyRow>('SELECT * FROM idempotency_keys WHERE principal_id=$1 AND method=$2 AND path=$3 AND key=$4', [actor!.id, method, path, key])).rows[0];
        if (previous) {
          if (previous.request_digest !== requestDigest) fail(409, 'idempotency_conflict', 'Idempotency key was used with different request content');
          return { status: previous.status, body: previous.response };
        }
        const response = await this.mutate(db, route, body, actor!, publish);
        await db.query(`INSERT INTO idempotency_keys(principal_id,method,path,key,request_digest,status,response)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [actor!.id, method, path, key, requestDigest, response.status, response.body]);
        return response;
      }, write);
      if (response.afterCommit) {
        const after = response.afterCommit;
        delete response.afterCommit;
        await after();
      }
      return response;
    } catch (error) {
      if (error instanceof ApiError) return { status: error.status, body: { error: error.code, message: error.message } };
      if ((error as {code?: string}).code === '23505') return { status: 409, body: { error: 'conflict', message: 'An immutable identity or idempotency key already exists' } };
      if (['40001','40P01'].includes((error as {code?: string}).code ?? '')) return { status: 503, body: { error: 'transaction_retry', message: 'Concurrent state change; retry the same request' } };
      throw error;
    }
  }

  /** Validate a publish request and store both archives under content-addressed staging keys. */
  private async stagePublish(body: unknown, token: string | undefined): Promise<PublishRequest> {
    if (!token) fail(401, 'unauthorized', 'A bearer token is required');
    let request: PublishRequest;
    try { request = validatePublishRequest(body); } catch (error) { return fail(400, 'invalid_request', (error as Error).message); }
    let manifest: Manifest;
    try {
      const entries = readArchive(request.snapshot, validatePackagePath);
      const text = entries.get('Slate.toml');
      if (!text) throw new Error('SnapshotManifestMissing');
      manifest = parseManifest(text.toString('utf8'));
      request.manifest = text.toString('utf8');
      if (![...entries.keys()].some(path => path.endsWith('.slate'))) throw new Error('NoFormalSources');
      const bundle = readArchive(request.interface, validateInterfacePath);
      const iface = bundle.get('interface');
      if (!iface) throw new Error('InterfaceEntryMissing');
      if (parseInterface(iface.toString('utf8')).package !== request.name) throw new Error('InterfacePackageMismatch');
    } catch (error) { return fail(400, 'invalid_archive', (error as Error).message); }
    const same = manifest.name === request.name && manifest.version === request.version && manifest.toolchain === request.toolchain
      && canonical(manifest.namespace_prefixes) === canonical(request.prefixes)
      && canonical(manifest.dependencies) === canonical([...request.deps].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (!same) fail(400, 'manifest_mismatch', 'The request fields differ from the archived Slate.toml');
    const store = this.options.objectStore;
    await store.put(stagingKey(request.name, request.version, request.cksum, 'slatepkg'), request.snapshot, { immutable: true });
    await store.put(stagingKey(request.name, request.version, request.iface_cksum, 'interface'), request.interface, { immutable: true });
    return request;
  }

  private async routeContext(db: PoolClient, method: string, path: string, actor: PrincipalRow | null): Promise<Route> {
    const parsed = new URL(path,'http://registry.invalid');
    path = parsed.pathname;
    const base = { method, path, query:parsed.searchParams };
    if (path === '/api/v1/meta' && method === 'GET') return { ...base, operation: 'meta' };
    if (path === '/api/v1/packages/new' && method === 'PUT') return { ...base, operation: 'publish' };
    if (path === '/api/v1/packages' && method === 'POST') return { ...base, operation: 'create_package' };
    if (path === '/api/v1/prefixes/yield' && method === 'POST') return { ...base, operation: 'yield' };
    if (path === '/api/v1/reviews/pending' && method === 'GET') return { ...base, operation: 'pending_reviews' };
    const candidateMatch = /^\/api\/v1\/candidates\/([^/]+)(?:\/(retry|review))?$/.exec(path);
    if (candidateMatch && ((method === 'GET' && !candidateMatch[2]) || (method === 'POST' && candidateMatch[2]))) {
      if (!actor) fail(401, 'unauthorized', 'A bearer token is required');
      const candidate = await this.candidate(db, candidateMatch[1]!);
      const pkg = (await db.query<PackageRow>('SELECT * FROM packages WHERE id=$1', [candidate.package_id])).rows[0]!;
      if (candidateMatch[2] === 'retry') await this.access(db, pkg, actor, 'write');
      return { ...base, pkg, candidate, operation: (candidateMatch[2] as 'retry'|'review'|undefined) ?? 'candidate' };
    }
    const packageMatch = /^\/api\/v1\/packages\/([^/]+)(.*)$/.exec(path);
    if (!packageMatch) return fail(404, 'not_found', 'Route not found');
    const pkg = await this.pkgByName(db, packageMatch[1]!);
    const tail = packageMatch[2]!;
    let operation: 'package'|'visibility'|'member'|'yank'|'unyank';
    let principal: string | undefined;
    let version: string | undefined;
    if (!tail && method === 'GET') operation = 'package';
    else if (tail === '/visibility' && method === 'PUT') operation = 'visibility';
    else if (/^\/members\/[^/]+$/.test(tail) && ['PUT','DELETE'].includes(method)) { operation = 'member'; principal = uuid(tail.split('/')[2]!); }
    else {
      const match = /^\/([^/]+)\/(yank|unyank)$/.exec(tail);
      if (!match || !((match[2] === 'yank' && method === 'DELETE') || (match[2] === 'unyank' && method === 'PUT'))) return fail(404, 'not_found', 'Route not found');
      version = decodeURIComponent(match[1]!);
      if (!VERSION.test(version)) fail(404, 'not_found', 'Version not found');
      operation = match[2] as 'yank'|'unyank';
    }
    await this.access(db, pkg, actor, ['visibility','member'].includes(operation) ? 'owner' : method === 'GET' ? 'read' : 'write');
    return { ...base, pkg, operation, principal, version };
  }

  private async read(db: PoolClient, route: Route, actor: PrincipalRow | null): Promise<ApiResponse> {
    let body: unknown;
    switch (route.operation) {
      case 'meta': {
        const settings = await this.currentSettings(db);
        const config = indexConfig();
        body = { registry_id: settings.registry_id, registration:'invitation_only', index: config.index, dl: config.dl, api: config.api,
          toolchain: this.options.toolchainTag, toolchain_digest: settings.toolchain_digest, policy_digest: settings.policy_digest }; break;
      }
      case 'package': {
        const versions = (await db.query<VersionRow>('SELECT * FROM package_versions WHERE package_id=$1 ORDER BY published_at,id', [route.pkg.id])).rows;
        const prefixes = (await db.query<{prefix:string}>('SELECT prefix FROM namespace_prefixes WHERE package_id=$1 ORDER BY prefix', [route.pkg.id])).rows.map(row => row.prefix);
        const owner = (await db.query<PrincipalRow>('SELECT name FROM principals WHERE id=$1', [route.pkg.owner_id])).rows[0];
        body = { name: route.pkg.name, owner: owner?.name ?? null, visibility: route.pkg.visibility, namespace_prefixes: prefixes,
          versions: versions.map(version => this.versionResponse(version)) };
        break;
      }
      case 'candidate': body = await this.candidateResponse(db, route.candidate); break;
      case 'pending_reviews': {
        if (!actor) fail(401, 'unauthorized', 'A bearer token is required');
        const rows = (await db.query<CandidateRow & {name:string}>(`SELECT c.*,p.name FROM candidates c JOIN packages p ON p.id=c.package_id
          WHERE c.status='pending_review' AND p.visibility='public' ORDER BY c.created_at,c.id LIMIT 100`)).rows;
        body = { candidates: rows.map(row => ({ id: row.id, name: row.name, version: row.version, level: row.level, revision: row.revision, created_at: row.created_at })) };
        break;
      }
      default: return fail(404, 'not_found', 'Route not found');
    }
    return { status: 200, body };
  }
  private versionResponse(version: VersionRow) {
    return { version: version.version, cksum: version.cksum, iface_cksum: version.iface_cksum, deps: version.deps, prefixes: version.prefixes,
      toolchain: version.toolchain, yanked: version.yanked, published_at: version.published_at };
  }
  private async candidateResponse(db: PoolClient, candidate: CandidateRow) {
    const pkg = (await db.query<PackageRow>('SELECT name FROM packages WHERE id=$1', [candidate.package_id])).rows[0]!;
    const attempt = (await db.query<AttemptRow>(`SELECT a.* FROM verification_attempts a JOIN verification_jobs j ON j.id=a.job_id
      WHERE j.candidate_id=$1 ORDER BY a.attempt DESC LIMIT 1`, [candidate.id])).rows[0] ?? null;
    const review = (await db.query<ReviewRow>('SELECT * FROM research_reviews WHERE candidate_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [candidate.id])).rows[0] ?? null;
    const published = (await db.query<{version:string}>('SELECT version FROM package_versions WHERE candidate_id=$1', [candidate.id])).rows[0] ?? null;
    return { id: candidate.id, name: pkg.name, version: candidate.version, level: candidate.level, revision: candidate.revision, status: candidate.status,
      diagnostic: candidate.diagnostic, cksum: candidate.cksum, iface_cksum: candidate.iface_cksum, created_at: candidate.created_at,
      verification: attempt && { attempt: attempt.attempt, outcome: attempt.outcome, computed_level: attempt.computed_level, report_digest: attempt.report_digest, diagnostic: attempt.diagnostic, completed_at: attempt.completed_at },
      review: review && { reviewer_id: review.reviewer_id, approved: review.approved, note: review.note, created_at: review.created_at },
      published: !!published };
  }

  private async mutate(db: PoolClient, route: Route, body: unknown, actor: PrincipalRow, publish?: PublishRequest): Promise<ApiResponse> {
    switch (route.operation) {
      case 'publish': return this.createCandidate(db, publish!, actor);
      case 'create_package': {
        // Reserve a name without publishing, so that a prefix can be yielded to it.
        fields(body, ['name'], ['visibility']);
        try { validateName(body.name); } catch { fail(400, 'invalid_request', 'Invalid package name'); }
        const visibility = body.visibility ?? 'public';
        if (visibility !== 'public' && visibility !== 'private') fail(400, 'invalid_request', 'Invalid visibility');
        if ((await db.query('SELECT 1 FROM packages WHERE name=$1', [body.name])).rowCount) fail(409, 'conflict', 'Package name already exists');
        const id = randomUUID();
        await db.query('INSERT INTO packages(id,name,owner_id,visibility) VALUES($1,$2,$3,$4)', [id, body.name, actor.id, visibility]);
        await this.event(db, 'package.created', id, { actor_id: actor.id, visibility });
        return { status: 201, body: { name: body.name, visibility } };
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
        return { status: 200, body: { name: route.pkg.name, principal_id: route.principal, role: route.method === 'DELETE' ? null : (body as JsonObject).role } };
      }
      case 'visibility': {
        fields(body, ['visibility']);
        if (body.visibility !== 'public' && body.visibility !== 'private') fail(400, 'invalid_request', 'Invalid visibility');
        await db.query('UPDATE packages SET visibility=$1 WHERE id=$2', [body.visibility, route.pkg.id]);
        await this.event(db, 'package.visibility_changed', route.pkg.id, { actor_id: actor.id, visibility: body.visibility });
        const name = route.pkg.name;
        return { status: 200, body: { name, visibility: body.visibility }, afterCommit: () => this.reindex(name) };
      }
      case 'yield': {
        fields(body, ['prefix', 'to']);
        try { validatePrefix(body.prefix); validateName(body.to); } catch (error) { return fail(400, 'invalid_request', (error as Error).message); }
        const target = await this.pkgByName(db, body.to);
        const rows = (await db.query<{prefix:string;package_id:string}>('SELECT prefix,package_id FROM namespace_prefixes')).rows;
        const enclosing = rows.filter(row => row.prefix === body.prefix || (body.prefix as string).startsWith(row.prefix + '.'))
          .sort((a, b) => b.prefix.length - a.prefix.length)[0];
        if (!enclosing) fail(409, 'prefix_unowned', 'No package owns an enclosing prefix to yield from');
        const owner = (await db.query<PackageRow>('SELECT * FROM packages WHERE id=$1', [enclosing.package_id])).rows[0]!;
        await this.access(db, owner, actor, 'owner');
        const blocked = rows.find(row => row.prefix !== body.prefix && row.package_id !== enclosing.package_id && row.package_id !== target.id && row.prefix.startsWith(body.prefix + '.'));
        if (blocked) fail(409, 'prefix_overlap', `An enclosed prefix is owned by another package: ${blocked.prefix}`);
        await db.query(`INSERT INTO namespace_prefixes(prefix,package_id,granted_by) VALUES($1,$2,$3)
          ON CONFLICT(prefix) DO UPDATE SET package_id=EXCLUDED.package_id,granted_by=EXCLUDED.granted_by`, [body.prefix, target.id, actor.id]);
        await this.event(db, 'prefix.yielded', target.id, { prefix: body.prefix, from: owner.id, actor_id: actor.id });
        return { status: 200, body: { prefix: body.prefix, package: target.name } };
      }
      case 'yank': case 'unyank': {
        fields(body, []);
        const version = (await db.query<VersionRow>('SELECT * FROM package_versions WHERE package_id=$1 AND version=$2 FOR UPDATE', [route.pkg.id, route.version])).rows[0];
        if (!version) fail(404, 'not_found', 'Published version not found');
        const yanked = route.operation === 'yank';
        if (version.yanked !== yanked) {
          await db.query('UPDATE package_versions SET yanked=$2,yanked_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,yanked_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END WHERE id=$1', [version.id, yanked, actor.id]);
          await this.event(db, yanked ? 'version.yanked' : 'version.unyanked', version.id, { actor_id: actor.id });
        }
        const name = route.pkg.name;
        return { status: 200, body: { name, version: route.version, yanked }, afterCommit: () => this.reindex(name) };
      }
      case 'retry': {
        fields(body, []);
        const candidate = route.candidate;
        if (!['error','timeout','incomplete'].includes(candidate.status)) fail(409, 'not_retryable', 'Only unresolved or incomplete checks can be retried');
        await this.queueQuota(db,actor.id);
        await db.query("UPDATE verification_jobs SET state='queued',requested_by=$2,lease_token=NULL,lease_expires_at=NULL,available_at=clock_timestamp() WHERE candidate_id=$1", [candidate.id,actor.id]);
        const updated = (await db.query<Pick<CandidateRow,'id'|'revision'|'status'>>("UPDATE candidates SET status='queued',diagnostic=NULL,revision=revision+1 WHERE id=$1 RETURNING id,revision,status", [candidate.id])).rows[0];
        return { status: 202, body: updated };
      }
      case 'review': {
        fields(body, ['approved','note']);
        if (typeof body.approved !== 'boolean') fail(400, 'invalid_request', 'Review requires an explicit boolean decision');
        string(body.note, 'review note');
        const candidate = route.candidate;
        if (candidate.status !== 'pending_review') fail(409, 'not_reviewable', 'Only verified candidates awaiting review can be reviewed');
        if (candidate.creator_id === actor.id) fail(403, 'self_review', 'A candidate cannot be reviewed by its publisher');
        const id = randomUUID();
        await db.query(`INSERT INTO research_reviews(id,candidate_id,reviewer_id,revision,approved,note) VALUES($1,$2,$3,$4,$5,$6)`,
          [id, candidate.id, actor.id, candidate.revision, body.approved, body.note]);
        const status = body.approved ? 'pending_review' : 'rejected';
        const updated = (await db.query<Pick<CandidateRow,'id'|'revision'|'status'>>('UPDATE candidates SET status=$2,diagnostic=$3,revision=revision+1 WHERE id=$1 RETURNING id,revision,status',
          [candidate.id, status, body.approved ? null : 'ReviewRejected: ' + body.note])).rows[0]!;
        const approved = body.approved;
        return { status: 200, body: { ...updated, review_id: id, approved }, afterCommit: approved ? () => this.publishCandidate(candidate.id).then(() => undefined) : undefined };
      }
      default: return fail(404,'not_found','Route not found');
    }
  }

  private async createCandidate(db: PoolClient, request: PublishRequest, actor: PrincipalRow): Promise<ApiResponse> {
    if (request.toolchain !== this.options.toolchainTag) fail(409, 'toolchain_mismatch', `This registry checks toolchain ${this.options.toolchainTag}`);
    let pkg = (await db.query<PackageRow>('SELECT * FROM packages WHERE name=$1', [request.name])).rows[0];
    const maintainer = await this.maintainer(db, actor.id);
    if (pkg) await this.access(db, pkg, actor, 'write');
    else {
      pkg = (await db.query<PackageRow>('INSERT INTO packages(id,name,owner_id) VALUES($1,$2,$3) RETURNING *', [randomUUID(), request.name, actor.id])).rows[0]!;
      await this.event(db, 'package.created', pkg.id, { actor_id: actor.id });
    }
    if ((await db.query('SELECT 1 FROM package_versions WHERE package_id=$1 AND version=$2', [pkg.id, request.version])).rowCount) {
      fail(409, 'immutable_version', 'This version is already published');
    }
    const owned = (await db.query<{prefix:string;package_id:string}>('SELECT prefix,package_id FROM namespace_prefixes')).rows;
    for (const prefix of request.prefixes) {
      if (isReservedPrefix(prefix) && !maintainer && !owned.some(row => row.prefix === prefix && row.package_id === pkg!.id)) {
        fail(403, 'prefix_reserved', `Prefix ${prefix} is reserved for the maintainer organization`);
      }
      const conflict = prefixConflict(prefix, pkg.id, owned);
      if (conflict) fail(409, 'prefix_conflict', conflict);
    }
    for (const dep of request.deps) {
      const available = (await db.query(`SELECT 1 FROM package_versions v JOIN packages p ON p.id=v.package_id WHERE p.name=$1 AND NOT v.yanked`, [dep.name])).rowCount;
      if (!available) fail(409, 'dependency_unavailable', `Dependency ${dep.name} has no published version`);
    }
    const existing = (await db.query<CandidateRow>(`SELECT * FROM candidates WHERE package_id=$1 AND version=$2 AND cksum=$3 AND iface_cksum=$4
      AND status NOT IN ('rejected','error','timeout','incomplete','published') ORDER BY created_at DESC LIMIT 1`, [pkg.id, request.version, request.cksum, request.iface_cksum])).rows[0];
    if (existing) return { status: 200, body: { status: 'candidate', id: existing.id, name: request.name, version: request.version, level: existing.level, revision: existing.revision, state: existing.status, review_required: !maintainer } };
    await this.queueQuota(db, actor.id);
    const id = randomUUID();
    await db.query(`INSERT INTO candidates(id,package_id,version,level,manifest,deps,prefixes,toolchain,cksum,iface_cksum,creator_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, pkg.id, request.version, request.level, request.manifest ?? '', JSON.stringify(request.deps), JSON.stringify(request.prefixes),
      request.toolchain, request.cksum, request.iface_cksum, actor.id]);
    await db.query('INSERT INTO verification_jobs(id,candidate_id,requested_by) VALUES($1,$2,$3)', [randomUUID(), id, actor.id]);
    await this.event(db, 'candidate.created', id, { package_id: pkg.id, version: request.version, actor_id: actor.id });
    return { status: 202, body: { status: 'candidate', id, name: request.name, version: request.version, level: request.level, revision: 1, state: 'queued', review_required: !maintainer } };
  }

  private async queueQuota(db:PoolClient,principalId:string) {
    const pending = (await db.query<{total:string;actor_total:string}>(`SELECT count(*) AS total,
      count(*) FILTER (WHERE requested_by=$1) AS actor_total FROM verification_jobs WHERE state IN ('queued','running')`,[principalId])).rows[0]!;
    if (Number(pending.total) >= 1024 || Number(pending.actor_total) >= 4) fail(429,'verification_queue_full','Verification queue quota reached; retry after existing tasks finish');
  }

  /** Staging keys of a candidate's archives. */
  stagingKeys(lease: { name: string; version: string; cksum: string; iface_cksum: string }) {
    return { snapshot: stagingKey(lease.name, lease.version, lease.cksum, 'slatepkg'), interface: stagingKey(lease.name, lease.version, lease.iface_cksum, 'interface') };
  }

  /** The index files and archives of the dependency closure of `names`, from published public versions. */
  async mirrorMaterials(names: string[]): Promise<MirrorMaterials> {
    return this.db.transaction(async db => {
      const index: Array<{ path: string; text: string }> = [];
      const archives: MirrorMaterials['archives'] = [];
      const pending = [...new Set(names)];
      const seen = new Set<string>();
      while (pending.length) {
        const name = pending.pop()!;
        if (seen.has(name)) continue;
        seen.add(name);
        if (seen.size > 1024) throw new Error('DependencyGraphBudgetExceeded');
        const entries = await this.indexEntries(db, name);
        index.push({ path: indexPath(name), text: entries.map(renderIndexLine).join('\n') + (entries.length ? '\n' : '') });
        for (const entry of entries) {
          archives.push({ key: publicKey(downloadKey(name, entry.vers, 'slatepkg')), name, version: entry.vers, suffix: 'slatepkg' });
          archives.push({ key: publicKey(downloadKey(name, entry.vers, 'interface')), name, version: entry.vers, suffix: 'interface' });
          for (const dep of entry.deps) pending.push(dep.name);
        }
      }
      return { index, archives };
    }, false);
  }
  private async indexEntries(db: PoolClient, name: string): Promise<IndexEntry[]> {
    const rows = (await db.query<VersionRow & {visibility:string}>(`SELECT v.*,p.visibility FROM package_versions v JOIN packages p ON p.id=v.package_id
      WHERE p.name=$1 ORDER BY v.published_at,v.id`, [name])).rows;
    return rows.filter(row => row.visibility === 'public').map(row => ({ name, vers: row.version, deps: row.deps, cksum: row.cksum,
      iface_cksum: row.iface_cksum, yanked: row.yanked, prefixes: row.prefixes, toolchain: row.toolchain }));
  }
  /** The interface of the greatest published, unyanked version below `version`, if any. */
  async previousInterface(name: string, version: string): Promise<{ version: string; interface_text: string } | null> {
    const target = parseVersion(version);
    return this.db.transaction(async db => {
      const rows = (await db.query<VersionRow>(`SELECT v.* FROM package_versions v JOIN packages p ON p.id=v.package_id WHERE p.name=$1 AND NOT v.yanked`, [name])).rows;
      let best: VersionRow | undefined;
      for (const row of rows) {
        const candidate = parseVersion(row.version);
        if (compareVersions(candidate, target) >= 0) continue;
        if (!best || compareVersions(candidate, parseVersion(best.version)) > 0) best = row;
      }
      return best ? { version: best.version, interface_text: best.interface_text } : null;
    }, false);
  }

  /** Regenerate one package's sparse-index file from the database. Serialized per package. */
  async reindex(name: string): Promise<void> {
    validateName(name);
    const client = await this.db.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', ['index:' + name]);
      try {
        const entries = await this.indexEntries(client, name);
        const text = entries.map(renderIndexLine).join('\n') + (entries.length ? '\n' : '');
        await this.options.objectStore.put(publicKey('index/' + indexPath(name)), Buffer.from(text), { contentType: 'text/plain' });
      } finally { await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['index:' + name]); }
    } finally { client.release(); }
  }
  async reindexAll(): Promise<string[]> {
    const names = (await this.db.pool.query<{name:string}>('SELECT DISTINCT p.name FROM package_versions v JOIN packages p ON p.id=v.package_id ORDER BY p.name')).rows.map(row => row.name);
    await this.writeIndexConfig();
    for (const name of names) await this.reindex(name);
    return names;
  }

  /**
   * Publish a candidate that passed verification and, unless its publisher is
   * a registry maintainer, an approving community review. Archives move to
   * the public tree first (immutable keys, harmless if the transaction fails),
   * then the version row is inserted and the index regenerated.
   */
  async publishCandidate(candidateId: string): Promise<{ published: boolean; version?: string; reason?: string }> {
    const prepared = await this.db.transaction(async db => {
      const candidate = await this.candidate(db, candidateId);
      if (candidate.status === 'published') return { skip: 'already published' } as const;
      if (candidate.status !== 'pending_review') return { skip: `status ${candidate.status}` } as const;
      const pkg = (await db.query<PackageRow>('SELECT * FROM packages WHERE id=$1', [candidate.package_id])).rows[0]!;
      const attempt = (await db.query<AttemptRow>(`SELECT a.* FROM verification_attempts a JOIN verification_jobs j ON j.id=a.job_id
        WHERE j.candidate_id=$1 AND a.attempt=j.attempt AND j.state='passed'`, [candidate.id])).rows[0];
      if (!attempt || attempt.outcome !== 'passed' || !attempt.interface_text || !attempt.computed_level || !levelAtLeast(candidate.level, attempt.computed_level)) return { skip: 'no passing verification' } as const;
      const maintainer = await this.maintainer(db, candidate.creator_id);
      const review = (await db.query<ReviewRow>('SELECT * FROM research_reviews WHERE candidate_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [candidate.id])).rows[0];
      if (!maintainer && !(review?.approved)) return { skip: 'review required' } as const;
      return { candidate, pkg, attempt, review: review ?? null } as const;
    }, false);
    if ('skip' in prepared) return { published: false, reason: prepared.skip };
    const { candidate, pkg, attempt, review } = prepared;
    const store = this.options.objectStore;
    const staging = this.stagingKeys({ name: pkg.name, version: candidate.version, cksum: candidate.cksum, iface_cksum: candidate.iface_cksum });
    for (const [from, key] of [[staging.snapshot, downloadKey(pkg.name, candidate.version, 'slatepkg')], [staging.interface, downloadKey(pkg.name, candidate.version, 'interface')]] as const) {
      const bytes = await store.get(from);
      const expected = key.endsWith('.slatepkg') ? candidate.cksum : candidate.iface_cksum;
      if (digestBytes(bytes) !== expected) throw new Error('StagedArchiveCorrupt');
      await store.put(publicKey(key), bytes, { immutable: true });
    }
    let reason = 'candidate changed';
    const published = await this.db.transaction(async db => {
      const current = await this.candidate(db, candidate.id);
      if (current.status !== 'pending_review' || current.revision !== candidate.revision) return false;
      if ((await db.query('SELECT 1 FROM package_versions WHERE package_id=$1 AND version=$2', [pkg.id, candidate.version])).rowCount) fail(409, 'immutable_version', 'This version is already published');
      // Ownership is decided at publication: a queued candidate cannot pre-empt a prefix
      // that another package published first, so the conflict rules run again here.
      const owned = (await db.query<{prefix:string;package_id:string}>('SELECT prefix,package_id FROM namespace_prefixes')).rows;
      const conflict = candidate.prefixes.map(prefix => prefixConflict(prefix, pkg.id, owned)).find(Boolean);
      if (conflict) {
        reason = 'PrefixConflictAtPublication: ' + conflict;
        await db.query("UPDATE candidates SET status='rejected',diagnostic=$2,revision=revision+1 WHERE id=$1", [candidate.id, reason]);
        return false;
      }
      await db.query(`INSERT INTO package_versions(id,package_id,version,candidate_id,verification_id,review_id,published_by,cksum,iface_cksum,deps,prefixes,toolchain,interface_text)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [randomUUID(), pkg.id, candidate.version, candidate.id, attempt.id, review?.approved ? review.id : null, candidate.creator_id, candidate.cksum, candidate.iface_cksum,
        JSON.stringify(candidate.deps), JSON.stringify(candidate.prefixes), candidate.toolchain, attempt.interface_text]);
      for (const prefix of candidate.prefixes) {
        await db.query('INSERT INTO namespace_prefixes(prefix,package_id,granted_by) VALUES($1,$2,$3) ON CONFLICT(prefix) DO NOTHING', [prefix, pkg.id, candidate.creator_id]);
      }
      await db.query("UPDATE candidates SET status='published',revision=revision+1 WHERE id=$1", [candidate.id]);
      await this.event(db, 'version.published', candidate.id, { package_id: pkg.id, version: candidate.version });
      if (this.options.beforePublishCommit) await this.options.beforePublishCommit();
      return true;
    });
    if (published) await this.reindex(pkg.name);
    return { published, version: candidate.version, reason: published ? undefined : reason };
  }

  async claimJob(): Promise<JobLease | null> {
    return this.db.transaction(async db => {
      const job = (await db.query<JobRow>(`SELECT * FROM verification_jobs WHERE
        (state='queued' AND available_at<=clock_timestamp()) OR (state='running' AND lease_expires_at<=clock_timestamp())
        ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if (!job) return null;
      const candidate = await this.candidate(db,job.candidate_id);
      const pkg = (await db.query<PackageRow>('SELECT * FROM packages WHERE id=$1', [candidate.package_id])).rows[0]!;
      const settings = await this.currentSettings(db);
      if (candidate.toolchain !== this.options.toolchainTag || settings.toolchain_digest !== this.options.toolchainDigest) {
        await db.query("UPDATE verification_jobs SET state='error',lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [job.id]);
        await db.query("UPDATE candidates SET status='error',diagnostic='ToolchainMismatch',revision=revision+1 WHERE id=$1", [candidate.id]);
        return null;
      }
      const token = randomUUID();
      const updated = (await db.query<JobRow>(`UPDATE verification_jobs SET state='running',attempt=attempt+1,lease_token=$2,
        lease_expires_at=clock_timestamp()+($3 * interval '1 second') WHERE id=$1 RETURNING *`, [job.id,token,this.options.leaseSeconds ?? 300])).rows[0]!;
      await db.query("UPDATE candidates SET status='running',diagnostic=NULL,revision=revision+1 WHERE id=$1", [candidate.id]);
      return { id: job.id, candidate_id: candidate.id, token, lease_expires_at: updated.lease_expires_at!.toISOString(), attempt: updated.attempt,
        name: pkg.name, version: candidate.version, level: candidate.level, deps: candidate.deps, prefixes: candidate.prefixes, toolchain: candidate.toolchain,
        cksum: candidate.cksum, iface_cksum: candidate.iface_cksum, creator_maintainer: await this.maintainer(db, candidate.creator_id) };
    });
  }
  async renewJob(lease: JobLease): Promise<boolean> {
    return this.db.transaction(async db => {
      const result = await db.query(`UPDATE verification_jobs SET lease_expires_at=clock_timestamp()+($4 * interval '1 second')
        WHERE id=$1 AND candidate_id=$2 AND lease_token=$3 AND state='running' AND lease_expires_at>clock_timestamp()`, [lease.id,lease.candidate_id,lease.token,this.options.leaseSeconds ?? 300]);
      return result.rowCount === 1;
    });
  }
  /** Record a worker's result. A passed check leaves the candidate awaiting publication (`pending_review`). */
  async completeJob(lease: JobLease, result: JobResult): Promise<boolean> {
    return this.db.transaction(async db => {
      const job = (await db.query<JobRow>(`SELECT * FROM verification_jobs WHERE id=$1 AND candidate_id=$2 AND lease_token=$3
        AND state='running' AND lease_expires_at>clock_timestamp() FOR UPDATE`, [lease.id,lease.candidate_id,lease.token])).rows[0];
      if (!job || job.attempt !== lease.attempt) return false;
      const candidate = await this.candidate(db,lease.candidate_id);
      let outcome = result.outcome;
      let diagnostic = result.diagnostic ?? null;
      if (!['passed','rejected','incomplete','timeout','error'].includes(outcome)) throw new Error('Unknown controlled worker outcome');
      if (outcome === 'passed') {
        if (!result.report || typeof result.report !== 'object' || (result.report as JsonObject).complete !== true || (result.report as JsonObject).release_eligible !== false
            || !result.interface_text || !result.computed_level || !(LEVELS as readonly string[]).includes(result.computed_level)) {
          outcome = 'error'; diagnostic = 'InvalidWorkerResult';
        } else if (!levelAtLeast(candidate.level, result.computed_level)) {
          outcome = 'rejected'; diagnostic = `DeclaredLevelBelowComputed: declared ${candidate.level} but the interface change is ${result.computed_level}`;
        }
      }
      await db.query(`INSERT INTO verification_attempts(id,job_id,attempt,outcome,report,report_digest,computed_level,interface_text,diagnostic)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(),job.id,job.attempt,outcome,result.report ?? null,result.report ? hash(result.report) : null,
        result.computed_level ?? null,result.interface_text ?? null,diagnostic]);
      await db.query('UPDATE verification_jobs SET state=$2,lease_token=NULL,lease_expires_at=NULL WHERE id=$1', [job.id,outcome]);
      await db.query('UPDATE candidates SET status=$2,diagnostic=$3,revision=revision+1 WHERE id=$1', [candidate.id,outcome === 'passed' ? 'pending_review' : outcome,diagnostic]);
      return true;
    });
  }
}
