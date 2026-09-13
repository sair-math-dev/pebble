import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { Registry } from '../src/registry.js';
import { createServer } from '../src/server.js';
import { objectStoreFromEnvironment } from '../src/object-store.js';
import { DEFAULT_POLICY, digestBytes, policyDigest, toolchainDigest } from '../src/protocol.js';
import { VerificationWorker } from '../src/worker.js';

// This acceptance runner deliberately uses the Rust client over real HTTP,
// real PostgreSQL/S3, and the isolated, pinned Slate checker.
const env = JSON.parse(await readFile(process.env.PEBBLE_TEST_ENV ?? '.artifacts/test-env.json', 'utf8')) as Record<string, string>;
Object.assign(process.env, env);
const rootfs = resolve(process.env.PEBBLE_TEST_TOOLCHAIN ?? '.artifacts/toolchain-pinned');
const client = resolve(process.env.SLATE_CLIENT ?? '../slate-pebble/tools/slate/target/release/slate');
const slatec = resolve(process.env.SLATEC ?? '../slate-pebble/tools/slatec/target/release/slatec');
const artifact = resolve('.artifacts/registry-e2e-' + new Date().toISOString().replaceAll(/[:.]/g, '-'));
await mkdir(artifact, { recursive: true });
const schema = 'e2e_' + randomUUID().replaceAll('-', '');
const admin = new pg.Pool({ connectionString: env.DATABASE_URL });
await admin.query(`CREATE SCHEMA "${schema}"`);
const database = new URL(env.DATABASE_URL!);
database.searchParams.set('options', '-c search_path=' + schema);
const worker = new VerificationWorker(rootfs, DEFAULT_POLICY);
const toolchain = await worker.initialize();
const registry = new Registry({ databaseUrl: database.toString(), registryId: randomUUID(),
  toolchain, toolchainDigest: toolchainDigest(toolchain), policy: DEFAULT_POLICY,
  policyDigest: policyDigest(DEFAULT_POLICY), objectStore: objectStoreFromEnvironment() });
const app = createServer(registry);
const token = randomUUID() + randomUUID();
type Candidate = { id: string; revision: number; status: string };
type Release = { id: string; snapshot_digest: string; version: string };
const evidence: Record<string, unknown> = { schema: 'Pebble.RegistryAcceptance.v1', started_at: new Date().toISOString(),
  client_sha256: digestBytes(await readFile(client)), toolchain_digest: toolchainDigest(toolchain),
  policy_digest: policyDigest(DEFAULT_POLICY), infrastructure: ['HTTP', 'PostgreSQL', 'S3', 'bubblewrap', 'real Slate'] };
let origin = '';
async function http<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(origin + path, { method, headers: { authorization: 'Bearer ' + token,
    ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': randomUUID() }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const json: unknown = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json as T;
}
async function cli(command: string, directory: string, cache: string, extra: string[] = []): Promise<Record<string, unknown>> {
  const args = [command, '--manifest', join(directory, 'slate.toml'), ...extra];
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(client, args, { env: { ...process.env, PEBBLE_TOKEN: token, SLATE_CACHE_DIR: cache }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', code => done({ code, stdout, stderr }));
  });
  await writeFile(join(artifact, `${directory.split('/').at(-1)}-${command}.json`), result.stdout);
  assert.equal(result.code, 0, `slate ${command}: ${result.stderr}\n${result.stdout.slice(0, 3000)}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
async function prepare(kind: string, name: string, dependencies: Array<{ package_id: string; version: string }> = []) {
  const pkg = await http<{ id: string }>('POST', '/api/v1/packages', { name: 'acceptance/' + name });
  const directory = join(artifact, name);
  await cp(resolve('experiments/fixtures/package-reuse', kind), directory, { recursive: true });
  await cp(resolve('experiments/fixtures/package-reuse/LICENSE'), join(directory, 'LICENSE.txt'));
  const attribution = await readFile('experiments/fixtures/package-reuse/README.md', 'utf8');
  await writeFile(join(directory, 'NOTICE.md'), attribution.replace('(LICENSE)', '(LICENSE.txt)'));
  const fields = {
    title: name === 'consumer' ? 'Inverse involution using an exact published dependency' : 'Reusable formal source fixture: ' + name,
    summary: 'Real formal-source integration fixture; existing mathematical results, not a novelty claim.',
    license: 'Apache-2.0', authors: ['Existing mathematical literature'], formalizers: ['Slate project contributors', 'Pebble fixture contributors'],
    maintainers: ['Integration test operator'], kind: 'formalization', claims: 'The exact statements contained in this fixed source snapshot.',
    assumptions: kind === 'set-membership' ? 'Explicit set membership theory axioms in theory/sets.slate.' : 'Explicit group theory axioms in the pinned provider.',
    citations: [], usage: 'Import the exact ModuleId shown in the source and run slate check with the generated lock.',
  };
  const manifest = `[package]\nid = "${pkg.id}"\nversion = "0.1.0"\n[registry]\nurl = "${origin}"\n[research]\n`
    + Object.entries(fields).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n') + '\n'
    + dependencies.map((dep, index) => `[dependencies.d${index}]\npackage_id = "${dep.package_id}"\nversion = "${dep.version}"\n`).join('');
  await writeFile(join(directory, 'slate.toml'), manifest);
  return { ...pkg, directory, cache: join(artifact, name + '-cache') };
}
async function release(pkg: { id: string; directory: string; cache: string }): Promise<Release> {
  const staged = await cli('publish', pkg.directory, pkg.cache);
  assert.equal(staged.publication_status, 'not_published');
  const candidate = staged.candidate as Candidate;
  const lease = await registry.claimJob();
  assert.ok(lease); assert.equal(lease.candidate_id, candidate.id);
  const checked = await worker.verify(lease);
  assert.equal(checked.outcome, 'passed', JSON.stringify(checked));
  assert.equal(await registry.completeJob(lease, checked), true);
  const reviewed = await http<Candidate>('POST', `/api/v1/candidates/${candidate.id}/review`, {
    approved: true, source_classification_confirmed: true,
    note: 'Fixture sources and attribution reviewed; explicit theory assumptions retained; no claim of scientific novelty.',
  });
  const released = await http<Release>('POST', `/api/v1/candidates/${candidate.id}/publish`, {}, { 'if-match': `"${reviewed.revision}"` });
  await http('PUT', `/api/v1/packages/${pkg.id}/visibility`, { visibility: 'public' });
  return released;
}
try {
  await registry.initialize({ migrate: true });
  await registry.provisionPrincipal({ name: 'acceptance owner', token });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const provider = await prepare('algebra-provider', 'provider');
  await cli('lock', provider.directory, provider.cache);
  const providerRelease = await release(provider);
  await rm(provider.directory, { recursive: true });
  await rm(provider.cache, { recursive: true, force: true });
  // The producer work tree and download cache are gone before the consumer
  // resolves or reads its first dependency byte.
  const consumer = await prepare('algebra-consumer', 'consumer', [{ package_id: provider.id, version: '0.1.0' }]);
  await cli('lock', consumer.directory, consumer.cache);
  const fetched = await cli('fetch', consumer.directory, consumer.cache);
  assert.equal(fetched.dependencies, 1);
  const checked = await cli('check', consumer.directory, consumer.cache, ['--slatec', slatec]);
  assert.equal(checked.status, 'checked');
  const consumerRelease = await release(consumer);
  const offline = await cli('check', consumer.directory, consumer.cache, ['--slatec', slatec, '--offline']);
  assert.equal(offline.status, 'checked');
  const sets = await prepare('set-membership', 'sets');
  await cli('lock', sets.directory, sets.cache);
  const setsChecked = await cli('check', sets.directory, sets.cache, ['--slatec', slatec]);
  assert.equal(setsChecked.status, 'checked');
  const setsRelease = await release(sets);
  const stats = (await registry.db.pool.query<{ releases: string; passed_jobs: string }>(`SELECT
    (SELECT count(*) FROM releases) AS releases,
    (SELECT count(*) FROM verification_jobs WHERE state='passed') AS passed_jobs`)).rows[0];
  assert.equal(stats?.releases, '3'); assert.equal(stats?.passed_jobs, '3');
  Object.assign(evidence, { outcome: 'passed', producer_removed_before_dependency_fetch: true, clean_online_reuse: true,
    offline_recheck: true, independent_theory_checked: true, stats,
    releases: { provider: providerRelease, consumer: consumerRelease, sets: setsRelease }, finished_at: new Date().toISOString() });
  await writeFile(join(artifact, 'summary.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ outcome: 'passed', artifact, ...stats }));
} finally {
  await app.close(); await registry.close();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end();
}
