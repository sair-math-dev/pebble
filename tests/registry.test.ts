import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publicKey, type ApiResponse } from '../src/registry.js';
import { indexPath } from '../src/protocol.js';
import {
  APP, BASE, BASE_EXTENDED, BASE_RESTATED, THEORY, dryRunPublish, emptyIndex, manifest, skipReason, testContext, writePackage,
} from './helpers.js';

function response<T>(result: ApiResponse, status = 200): T {
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body as T;
}
type Candidate = { id: string; status: string; state?: string; revision: number; level: string; diagnostic?: string | null };

test('registry invariants with real PostgreSQL, S3, the real client and the isolated compiler', { skip: skipReason, timeout: 600_000 }, async t => {
  const context = await testContext();
  const { registry, worker, objectStore } = context;
  const scratch = await mkdtemp(join(tmpdir(), 'pebble-registry-test-'));
  const index = await emptyIndex(join(scratch, 'fake-registry'));
  const home = join(scratch, 'home');
  const ownerToken = randomUUID() + randomUUID();
  const reviewerToken = randomUUID() + randomUUID();
  const strangerToken = randomUUID() + randomUUID();
  const maintainerToken = randomUUID() + randomUUID();
  const owner = await registry.provisionPrincipal({ name: 'test-owner', token: ownerToken });
  await registry.provisionPrincipal({ name: 'test-reviewer', token: reviewerToken });
  await registry.provisionPrincipal({ name: 'test-stranger', token: strangerToken });
  await registry.provisionPrincipal({ name: 'test-maintainer', token: maintainerToken, maintainer: true });
  const request = (method: string, path: string, body: unknown = {}, token: string | undefined = ownerToken, headers: Record<string, string> = {}) =>
    registry.request(method, path, body, token, headers);
  const verify = async (candidate: Candidate, expected: string) => {
    const lease = await registry.claimJob(); assert.ok(lease); assert.equal(lease.candidate_id, candidate.id);
    const result = await worker.verify(lease, registry);
    assert.equal(result.outcome, expected, JSON.stringify(result).slice(0, 4000));
    assert.equal(await registry.completeJob(lease, result), true);
    return { lease, result };
  };
  const current = async (candidate: Candidate) => response<Candidate>(await request('GET', `/api/v1/candidates/${candidate.id}`));
  const packageDir = async (name: string, version: string, files: Record<string, string>, options: { prefixes?: string[]; deps?: Array<[string, string]> } = {}) => {
    const root = join(scratch, `${name}-${version}-${randomUUID().slice(0, 8)}`);
    await writePackage(root, manifest(name, version, index, options), files);
    return root;
  };
  let baseCandidate: Candidate;
  let baseBody: Record<string, unknown>;
  try {
    await t.test('a publish request stages archives, a worker check is required, and community review gates publication', async () => {
      const root = await packageDir('base', '1.0.0', { 'theory.slate': THEORY, 'core.slate': BASE }, { prefixes: ['Acme.Base'] });
      const { body } = await dryRunPublish(root, home);
      baseBody = body;
      baseCandidate = response<Candidate>(await request('PUT', '/api/v1/packages/new', body), 202);
      assert.equal(baseCandidate.state, 'queued');
      assert.equal(await objectStore.has(`staging/base/1.0.0/${body.cksum}.slatepkg`), true);
      assert.equal(await objectStore.has(publicKey('packages/base/1.0.0/base-1.0.0.slatepkg')), false);
      // The same upload again is the same candidate, not a duplicate job.
      const again = response<Candidate>(await request('PUT', '/api/v1/packages/new', body), 200);
      assert.equal(again.id, baseCandidate.id);
      // A stranger cannot publish into somebody else's package name, even the identical upload.
      response(await request('PUT', '/api/v1/packages/new', body, strangerToken), 403);
      await verify(baseCandidate, 'passed');
      assert.equal((await current(baseCandidate)).status, 'pending_review');
      assert.deepEqual(await registry.publishCandidate(baseCandidate.id), { published: false, reason: 'review required' });
      response(await request('POST', `/api/v1/candidates/${baseCandidate.id}/review`, { approved: true, note: 'self' }), 403);
      const pending = response<{ candidates: Candidate[] }>(await request('GET', '/api/v1/reviews/pending', {}, reviewerToken));
      assert.deepEqual(pending.candidates.map(candidate => candidate.id), [baseCandidate.id]);
      response(await request('POST', `/api/v1/candidates/${baseCandidate.id}/review`, { approved: true, note: 'Attribution, license and source classification reviewed.' }, reviewerToken));
      const published = await current(baseCandidate);
      assert.equal(published.status, 'published', JSON.stringify(published));
      const indexText = (await objectStore.get(publicKey('index/' + indexPath('base')))).toString('utf8');
      const line = JSON.parse(indexText.trim()) as Record<string, unknown>;
      assert.equal(line.vers, '1.0.0'); assert.equal(line.cksum, body.cksum); assert.equal(line.yanked, false); assert.deepEqual(line.prefixes, ['Acme.Base']);
      assert.equal(await objectStore.has(publicKey('packages/base/1.0.0/base-1.0.0.interface')), true);
      const config = JSON.parse((await objectStore.get(publicKey('index/config.json'))).toString('utf8')) as Record<string, string>;
      assert.ok(config.dl && config.api);
      const info = response<{ versions: Array<{ version: string }>; namespace_prefixes: string[] }>(await registry.request('GET', '/api/v1/packages/base'));
      assert.deepEqual(info.versions.map(version => version.version), ['1.0.0']);
      assert.deepEqual(info.namespace_prefixes, ['Acme.Base']);
      response(await request('PUT', '/api/v1/packages/new', body), 409);
    });

    await t.test('prefix ownership: overlap and reserved prefixes reject, a yielded sub-prefix is allowed', async () => {
      const enclosing = await packageDir('acme', '0.1.0', { 'theory.slate': THEORY.replace('Acme.Base.Theory', 'Acme.Theory') }, { prefixes: ['Acme'] });
      const { body: enclosingBody } = await dryRunPublish(enclosing, home);
      assert.equal(response<{ error: string }>(await request('PUT', '/api/v1/packages/new', enclosingBody, strangerToken), 409).error, 'prefix_conflict');
      // The compiler itself refuses source under `Std.`, so the reserved claim can only arrive as a manifest prefix.
      const reserved = await packageDir('stdlike', '0.1.0', { 'theory.slate': THEORY.replace('Acme.Base.Theory', 'Acme.Stdlike.Theory') }, { prefixes: ['Std.Fake'] });
      const { body: reservedBody } = await dryRunPublish(reserved, home);
      assert.equal(response<{ error: string }>(await request('PUT', '/api/v1/packages/new', reservedBody, strangerToken), 403).error, 'prefix_reserved');
      const sub = await packageDir('base-sub', '0.1.0', { 'theory.slate': THEORY.replace('Acme.Base.Theory', 'Acme.Base.Sub.Theory') }, { prefixes: ['Acme.Base.Sub'] });
      const { body: subBody } = await dryRunPublish(sub, home);
      assert.equal(response<{ error: string }>(await request('PUT', '/api/v1/packages/new', subBody, strangerToken), 409).error, 'prefix_conflict');
      // The stranger reserves a name; only the owner of the enclosing prefix can yield to it; then publishing works.
      response(await request('POST', '/api/v1/packages', { name: 'base-sub' }, strangerToken), 201);
      response(await request('POST', '/api/v1/prefixes/yield', { prefix: 'Acme.Base.Sub', to: 'base-sub' }, strangerToken), 403);
      response(await request('POST', '/api/v1/prefixes/yield', { prefix: 'Acme.Base.Sub', to: 'base-sub' }));
      const yielded = response<Candidate>(await request('PUT', '/api/v1/packages/new', subBody, strangerToken), 202);
      await verify(yielded, 'passed');
    });

    await t.test('a restated theorem declared as a patch is rejected by the worker; the correct level passes', async () => {
      const restated = await packageDir('base', '1.0.1', { 'theory.slate': THEORY, 'core.slate': BASE_RESTATED }, { prefixes: ['Acme.Base'] });
      const { body } = await dryRunPublish(restated, home, 'patch');
      assert.equal(body.level, 'patch');
      const candidate = response<Candidate>(await request('PUT', '/api/v1/packages/new', body), 202);
      const { result } = await verify(candidate, 'rejected');
      assert.match(result.diagnostic!, /DeclaredLevelBelowComputed.*Acme\.Base\.Core\.Core statement changed/);
      assert.equal((await current(candidate)).status, 'rejected');
      // An additive change declared minor passes, and a maintainer publishes without review.
      const extended = await packageDir('base', '1.1.0', { 'theory.slate': THEORY, 'core.slate': BASE_EXTENDED }, { prefixes: ['Acme.Base'] });
      const { body: minorBody } = await dryRunPublish(extended, home, 'minor');
      const minor = response<Candidate>(await request('PUT', '/api/v1/packages/new', minorBody, maintainerToken), 202);
      const lease = await registry.claimJob(); assert.ok(lease); assert.equal(lease.creator_maintainer, true);
      const outcome = await worker.verify(lease, registry);
      assert.equal(outcome.outcome, 'passed', JSON.stringify(outcome).slice(0, 4000));
      assert.equal(outcome.computed_level, 'minor');
      assert.equal(await registry.completeJob(lease, outcome), true);
      assert.deepEqual(await registry.publishCandidate(minor.id), { published: true, version: '1.1.0', reason: undefined });
      const lines = (await objectStore.get(publicKey('index/' + indexPath('base')))).toString('utf8').trim().split('\n').map(line => JSON.parse(line) as { vers: string });
      assert.deepEqual(lines.map(line => line.vers), ['1.0.0', '1.1.0']);
    });

    await t.test('yank rewrites the index line and keeps the files; dependencies must be published; private packages leave the index', async () => {
      response(await request('DELETE', '/api/v1/packages/base/1.1.0/yank', {}, strangerToken), 403);
      response(await request('DELETE', '/api/v1/packages/base/1.1.0/yank', {}));
      let lines = (await objectStore.get(publicKey('index/' + indexPath('base')))).toString('utf8').trim().split('\n').map(line => JSON.parse(line) as { vers: string; yanked: boolean });
      assert.deepEqual(lines.map(line => [line.vers, line.yanked]), [['1.0.0', false], ['1.1.0', true]]);
      assert.equal(await objectStore.has(publicKey('packages/base/1.1.0/base-1.1.0.slatepkg')), true);
      response(await request('PUT', '/api/v1/packages/base/1.1.0/unyank', {}));
      lines = (await objectStore.get(publicKey('index/' + indexPath('base')))).toString('utf8').trim().split('\n').map(line => JSON.parse(line) as { vers: string; yanked: boolean });
      assert.deepEqual(lines.map(line => line.yanked), [false, false]);
      // A dependency nobody published cannot be declared.
      const consumer = await packageDir('app', '0.1.0', { 'a.slate': APP }, { prefixes: ['Acme.App'], deps: [['nothing', '^1.0']] });
      const { body } = await dryRunPublish(consumer, home).catch(() => ({ body: null as Record<string, unknown> | null }));
      if (body) assert.equal(response<{ error: string }>(await request('PUT', '/api/v1/packages/new', body), 409).error, 'dependency_unavailable');
      // Visibility: a private package has no index lines; its files stay.
      response(await request('PUT', '/api/v1/packages/base/visibility', { visibility: 'private' }));
      assert.equal((await objectStore.get(publicKey('index/' + indexPath('base')))).toString('utf8'), '');
      response(await request('PUT', '/api/v1/packages/base/visibility', { visibility: 'public' }));
      assert.equal((await objectStore.get(publicKey('index/' + indexPath('base')))).toString('utf8').trim().split('\n').length, 2);
      // Published rows are immutable except for yank state.
      await assert.rejects(registry.db.pool.query("UPDATE package_versions SET version='9.9.9'"), /immutable registry record/);
      assert.equal(owner.name, 'test-owner');
      assert.ok(baseBody);
    });
  } finally {
    await context.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
