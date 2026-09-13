// End-to-end acceptance: the real `slate` client over real HTTP against this
// registry with real PostgreSQL, S3, bubblewrap and the pinned compiler.
// Run: node_modules/.bin/tsx tests/registry-e2e.ts (needs the integration environment).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from '../src/server.js';
import { indexPath } from '../src/protocol.js';
import { publicKey } from '../src/registry.js';
import { APP, BASE, BASE_RESTATED, THEORY, dryRunPublish, manifest, skipReason, slate, slateOk, slatec, testContext, writePackage } from './helpers.js';

if (skipReason) { console.error(skipReason); process.exit(1); }
const artifact = resolve('.artifacts/registry-e2e-' + new Date().toISOString().replaceAll(/[:.]/g, '-'));
await mkdir(artifact, { recursive: true });
const context = await testContext();
const { registry, worker, objectStore } = context;
const app = createServer(registry);
app.log.level = 'silent';
const publisherToken = randomUUID() + randomUUID();
const reviewerToken = randomUUID() + randomUUID();
await registry.provisionPrincipal({ name: 'e2e-publisher', token: publisherToken });
await registry.provisionPrincipal({ name: 'e2e-reviewer', token: reviewerToken });
const evidence: Record<string, unknown> = { schema: 'Pebble.RegistryAcceptance', started_at: new Date().toISOString(),
  infrastructure: ['HTTP', 'PostgreSQL', 'S3', 'bubblewrap', 'real slate client', 'real slatec'] };
type Candidate = { id: string; state: string; status?: string; review_required: boolean };
let origin = '';
async function http<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(origin + path, { method, headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const json: unknown = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json as T;
}
async function record(name: string, value: unknown) { await writeFile(join(artifact, name + '.json'), JSON.stringify(value, null, 2) + '\n'); }
try {
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  process.env.PEBBLE_INDEX_ROOT = `${origin}/index/`;
  process.env.PEBBLE_DL_TEMPLATE = `${origin}/static/packages/{package}/{version}/{package}-{version}`;
  process.env.PEBBLE_API_ROOT = `${origin}/api/v1`;
  await registry.writeIndexConfig();
  const index = `${origin}/index/`;
  const home = join(artifact, 'home');
  const cli = { SLATE_TOKEN: publisherToken };

  // 1. Publish `base` 0.1.0: the client checks, uploads, the worker re-checks, a reviewer approves.
  const baseRoot = join(artifact, 'base');
  await writePackage(baseRoot, manifest('base', '0.1.0', index, { prefixes: ['Acme.Base'] }), { 'theory.slate': THEORY, 'core.slate': BASE });
  const published = await slateOk(['publish', '--manifest', join(baseRoot, 'Slate.toml'), '--slatec', slatec], home, cli);
  await record('base-publish', published);
  assert.equal(published.status, 'candidate_submitted');
  const candidate = (published.registry_response as Candidate);
  assert.equal(candidate.state, 'queued'); assert.equal(candidate.review_required, true);
  assert.equal(await worker.runOne(registry), true);
  const afterCheck = await http<{ status: string; verification: { outcome: string } }>('GET', `/api/v1/candidates/${candidate.id}`, publisherToken);
  assert.equal(afterCheck.status, 'pending_review', JSON.stringify(afterCheck));
  assert.equal(afterCheck.verification.outcome, 'passed');
  await http('POST', `/api/v1/candidates/${candidate.id}/review`, reviewerToken, { approved: true, note: 'Format, attribution and license reviewed.' });
  const baseInfo = await http<{ versions: Array<{ version: string; yanked: boolean }> }>('GET', '/api/v1/packages/base', publisherToken);
  assert.deepEqual(baseInfo.versions.map(version => version.version), ['0.1.0']);
  const indexLine = await (await fetch(`${index}${indexPath('base')}`)).text();
  assert.match(indexLine, /"name":"base","vers":"0.1.0"/);
  // The publisher's tree and cache are gone before any consumer resolves.
  await rm(baseRoot, { recursive: true }); await rm(home, { recursive: true, force: true });

  // 2. A consumer in development mode consumes only the published statements; --release replays everything.
  const appRoot = join(artifact, 'app');
  await writePackage(appRoot, manifest('app', '0.1.0', index, { prefixes: ['Acme.App'], deps: [['base', '^0.1']] }), { 'a.slate': APP });
  const dev = await slateOk(['check', '--manifest', join(appRoot, 'Slate.toml'), '--slatec', slatec], home, cli);
  await record('app-check-dev', dev);
  assert.equal(dev.mode, 'development'); assert.equal(dev.dev_mode, true);
  assert.ok((dev.trusted_statement_count as number) > 0, JSON.stringify(dev));
  const basePackage = (dev.packages as Array<Record<string, unknown>>).find(pkg => pkg.name === 'base')!;
  assert.equal((basePackage.module_cache_status as Record<string, number>).loaded_from_trusted_cache, 1, JSON.stringify(dev));
  // Client finding: the statement-only objects a development check installs into `.slate/cache`
  // make a later `--release` check in the same tree fail with ModuleProofUnavailable instead of
  // rebuilding the dependency from source, so the release check starts from a clean build directory.
  await rm(join(appRoot, '.slate'), { recursive: true, force: true });
  const release = await slateOk(['check', '--release', '--manifest', join(appRoot, 'Slate.toml'), '--slatec', slatec], home, cli);
  await record('app-check-release', release);
  assert.equal(release.mode, 'release'); assert.equal(release.dev_mode, false);
  assert.equal((release.packages as Array<Record<string, unknown>>).find(pkg => pkg.name === 'app')!.checked_theorems, 1);
  const lock = await readFile(join(appRoot, 'Slate.lock'), 'utf8');
  assert.match(lock, /name = "base"\nversion = "0.1.0"\nsource = "registry\+http:\/\/127\.0\.0\.1/);
  // The consumer itself publishes: its dependency resolves through the worker's offline mirror.
  const appPublished = await slateOk(['publish', '--manifest', join(appRoot, 'Slate.toml'), '--slatec', slatec], home, cli);
  await record('app-publish', appPublished);
  assert.equal(await worker.runOne(registry), true);
  const appCandidate = await http<{ status: string; verification: { outcome: string; diagnostic: string | null } }>('GET', `/api/v1/candidates/${(appPublished.registry_response as Candidate).id}`, publisherToken);
  assert.equal(appCandidate.status, 'pending_review', JSON.stringify(appCandidate));

  // 3. Yank: `slate update` keeps a locked yanked version but never selects it afresh.
  const yanked = await slateOk(['yank', 'base@0.1.0', '--manifest', join(appRoot, 'Slate.toml')], home, cli);
  await record('base-yank', yanked);
  const yankedLine = await (await fetch(`${index}${indexPath('base')}`)).text();
  assert.match(yankedLine, /"yanked":true/);
  const kept = await slateOk(['update', '--manifest', join(appRoot, 'Slate.toml')], home, cli);
  await record('app-update-after-yank', kept);
  assert.equal(kept.status, 'updated'); assert.deepEqual(kept.changes, []);
  assert.match(await readFile(join(appRoot, 'Slate.lock'), 'utf8'), /name = "base"\nversion = "0.1.0"/);
  const fresh = join(artifact, 'fresh');
  await writePackage(fresh, manifest('fresh', '0.1.0', index, { prefixes: ['Acme.Fresh'], deps: [['base', '^0.1']] }), { 'a.slate': APP.replace('Acme.App.Main', 'Acme.Fresh.Main') });
  const unresolved = await slate(['update', '--manifest', join(fresh, 'Slate.toml')], home, cli);
  assert.equal(unresolved.code, 1, unresolved.stdout);
  assert.match(unresolved.stderr, /NoVersionSatisfiesRequirements: base/);
  await slateOk(['yank', 'base@0.1.0', '--undo', '--manifest', join(appRoot, 'Slate.toml')], home, cli);
  assert.equal((await slateOk(['update', '--manifest', join(fresh, 'Slate.toml')], home, cli)).status, 'updated');

  // 4. base 0.2.0 restates the theorem. The client refuses to upload it as a patch; a request that
  // declares `patch` anyway (built from the client's own archives) is rejected by the registry's check.
  const restatedRoot = join(artifact, 'base-0.2.0');
  await writePackage(restatedRoot, manifest('base', '0.2.0', index, { prefixes: ['Acme.Base'] }), { 'theory.slate': THEORY, 'core.slate': BASE_RESTATED });
  const clientGate = await slate(['publish', '--level', 'patch', '--manifest', join(restatedRoot, 'Slate.toml'), '--slatec', slatec], home, cli);
  assert.equal(clientGate.code, 1, 'the client refuses an understated level before uploading');
  assert.match(clientGate.stderr, /DeclaredLevelBelowComputed/);
  const { body } = await dryRunPublish(restatedRoot, home, 'major');
  const understated = await http<Candidate>('PUT', '/api/v1/packages/new', publisherToken, { ...body, level: 'patch' });
  assert.equal(understated.state, 'queued');
  assert.equal(await worker.runOne(registry), true);
  const rejected = await http<{ status: string; diagnostic: string }>('GET', `/api/v1/candidates/${understated.id}`, publisherToken);
  assert.equal(rejected.status, 'rejected', JSON.stringify(rejected));
  assert.match(rejected.diagnostic, /DeclaredLevelBelowComputed.*Acme\.Base\.Core\.Core statement changed/);
  assert.equal(await objectStore.has(publicKey('packages/base/0.2.0/base-0.2.0.slatepkg')), false);
  assert.doesNotMatch(await (await fetch(`${index}${indexPath('base')}`)).text(), /0\.2\.0/);

  const stats = (await registry.db.pool.query<{ versions: string; passed: string }>(`SELECT
    (SELECT count(*) FROM package_versions) AS versions, (SELECT count(*) FROM verification_jobs WHERE state='passed') AS passed`)).rows[0];
  Object.assign(evidence, { outcome: 'passed', stats, finished_at: new Date().toISOString() });
  await record('summary', evidence);
  console.log(JSON.stringify({ outcome: 'passed', artifact, ...stats }));
} finally {
  await app.close();
  await context.close();
}
