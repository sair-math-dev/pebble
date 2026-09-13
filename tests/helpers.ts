// Shared fixtures for the integration tests: the private test environment,
// per-test PostgreSQL schemas, the pinned worker rootfs, real `slate` client
// invocations and small Slate packages.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { Registry } from '../src/registry.js';
import { objectStoreFromEnvironment, type ObjectStore } from '../src/object-store.js';
import { DEFAULT_POLICY, policyDigest, toolchainDigest } from '../src/protocol.js';
import { VerificationWorker } from '../src/worker.js';

export const environmentFile = process.env.PEBBLE_TEST_ENV ?? '.artifacts/test-env.json';
export const toolchainDirectory = resolve(process.env.PEBBLE_TEST_TOOLCHAIN ?? '.artifacts/toolchain-adr0188');
export const slateClient = resolve(process.env.SLATE_CLIENT ?? '../slate-kernel/target/release/slate');
export const slatec = resolve(process.env.SLATEC ?? '../slate-kernel/target/release/slatec');
export const TOOLCHAIN_TAG = 'local';
export const available = existsSync(environmentFile) && existsSync(`${toolchainDirectory}/toolchain.json`) && existsSync(slateClient) && existsSync(slatec);
export const skipReason = available ? false : 'Set PEBBLE_TEST_ENV, PEBBLE_TEST_TOOLCHAIN, SLATE_CLIENT and SLATEC for integration services';

export const THEORY = 'sealed theory Acme.Base.Theory\n    logic Logic.ClassicalManySortedFOL.EID\n\n    sort Object\n';
export const BASE = 'module Acme.Base.Core\n    under Acme.Base.Theory\n\n    theorem Core(x : Object): x = x\n        x = x from reflexivity\n';
export const BASE_RESTATED = 'module Acme.Base.Core\n    under Acme.Base.Theory\n\n    theorem Core(x : Object, y : Object): x = x\n        x = x from reflexivity\n';
export const BASE_EXTENDED = BASE + '\n    theorem Extra(x : Object): x = x\n        x = x from reflexivity\n';
export const APP = 'module Acme.App.Main\n    under Acme.Base.Theory\n    import Acme.Base.Core\n\n    theorem UseA(x : Object): x = x\n        x = x from Acme.Base.Core.Core(x)\n';

export interface TestContext {
  env: Record<string, string>;
  registry: Registry;
  worker: VerificationWorker;
  objectStore: ObjectStore;
  admin: pg.Pool;
  schema: string;
  close(): Promise<void>;
}

/** A registry on a fresh PostgreSQL schema with the real object store and the pinned worker. */
export async function testContext(options: { objectStore?: (base: ObjectStore) => ObjectStore; beforePublishCommit?: () => Promise<void> } = {}): Promise<TestContext> {
  const env = JSON.parse(await readFile(environmentFile, 'utf8')) as Record<string, string>;
  Object.assign(process.env, env);
  const admin = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
  const schema = 'registry_test_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const databaseUrl = new URL(env.DATABASE_URL!);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const worker = new VerificationWorker(toolchainDirectory, DEFAULT_POLICY);
  const toolchain = await worker.initialize();
  // Published keys are immutable, so every run gets its own bucket; local buckets are cheap and left for inspection.
  const bucket = `${env.S3_BUCKET}-${randomUUID().slice(0, 8)}`;
  process.env.S3_BUCKET = bucket;
  const base = objectStoreFromEnvironment();
  await base.client.send(new CreateBucketCommand({ Bucket: bucket }));
  const objectStore = options.objectStore ? options.objectStore(base) : base;
  const registry = new Registry({
    databaseUrl: databaseUrl.toString(), registryId: randomUUID(), toolchain, policy: DEFAULT_POLICY, toolchainTag: TOOLCHAIN_TAG,
    toolchainDigest: toolchainDigest(toolchain), policyDigest: policyDigest(DEFAULT_POLICY), objectStore, leaseSeconds: 120,
    beforePublishCommit: options.beforePublishCommit,
  });
  await registry.initialize({ migrate: true });
  return {
    env, registry, worker, objectStore, admin, schema,
    async close() {
      await registry.close();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}

export interface ClientResult { code: number | null; stdout: string; stderr: string; json: Record<string, unknown> | null }

/** Run the real `slate` binary with an isolated `SLATE_HOME`. */
export async function slate(args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<ClientResult> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  return new Promise((done, reject) => {
    const child = spawn(slateClient, args, { env: { PATH: '/usr/bin:/bin', HOME: home, SLATE_HOME: home, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      let json: Record<string, unknown> | null = null;
      try { json = JSON.parse(stdout) as Record<string, unknown>; } catch { json = null; }
      done({ code, stdout, stderr, json });
    });
  });
}
export async function slateOk(args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const result = await slate(args, home, extraEnv);
  assert.equal(result.code, 0, `slate ${args.join(' ')}: ${result.stderr}\n${result.stdout.slice(0, 2000)}`);
  assert.ok(result.json, 'client output must be JSON');
  return result.json;
}

export function manifest(name: string, version: string, index: string, options: { prefixes?: string[]; deps?: Array<[string, string]>; toolchain?: string } = {}): string {
  const prefixes = (options.prefixes ?? []).map(prefix => JSON.stringify(prefix)).join(', ');
  return `[package]\nname = "${name}"\nversion = "${version}"\nnamespace_prefixes = [${prefixes}]\ntoolchain = "${options.toolchain ?? TOOLCHAIN_TAG}"\nlicense = "Apache-2.0"\n\n`
    + `[registry]\nindex = "${index}"\n\n`
    + '[research]\ntitle = "Test fixture: reflexivity"\nsummary = "Existing trivial results formalized for registry integration tests."\n'
    + 'authors = ["Existing mathematical literature"]\nformalizers = ["Slate project contributors"]\nmaintainers = ["Integration test operator"]\n'
    + 'kind = "formalization"\nclaims = "Reflexivity of equality in a one-sort theory."\nassumptions = "No nonlogical axioms."\ncitations = []\n'
    + 'usage = "Import the exact ModuleId shown in the source."\n\n[dependencies]\n'
    + (options.deps ?? []).map(([dependency, requirement]) => `${dependency} = "${requirement}"\n`).join('');
}

export async function writePackage(root: string, manifestText: string, files: Record<string, string>): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'Slate.toml'), manifestText);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** A `file://` index root holding only `config.json`, enough for `slate publish --dry-run` of a dependency-free package. */
export async function emptyIndex(directory: string): Promise<string> {
  await mkdir(join(directory, 'index'), { recursive: true });
  await writeFile(join(directory, 'index', 'config.json'), JSON.stringify({ dl: `file://${directory}/dl/{package}/{version}/{package}-{version}`, api: `file://${directory}/api/` }));
  return `file://${directory}/index/`;
}

/** Produce a package's archives through the real client and shape the publish request the client sends. */
export async function dryRunPublish(root: string, home: string, level?: string): Promise<{ body: Record<string, unknown>; snapshot: Buffer; bundle: Buffer; result: Record<string, unknown> }> {
  const result = await slateOk(['publish', '--dry-run', '--manifest', join(root, 'Slate.toml'), '--slatec', slatec, ...(level ? ['--level', level] : [])], home);
  const name = result.name as string, version = result.version as string;
  const snapshot = await readFile(join(root, '.slate', `${name}-${version}.slatepkg`));
  const bundle = await readFile(join(root, '.slate', `${name}-${version}.interface`));
  const text = await readFile(join(root, 'Slate.toml'), 'utf8');
  const prefixes = /namespace_prefixes = \[(.*)\]/.exec(text)?.[1]?.split(',').map(entry => entry.trim().replaceAll('"', '')).filter(Boolean) ?? [];
  const toolchain = /toolchain = "([^"]+)"/.exec(text)?.[1] ?? TOOLCHAIN_TAG;
  const deps = [...text.matchAll(/^([a-z][a-z0-9_-]*) = "([^"]+)"$/gm)].filter(match => !['name', 'version', 'toolchain', 'license', 'index', 'title', 'summary', 'kind', 'claims', 'assumptions', 'usage'].includes(match[1]!)).map(match => ({ name: match[1]!, req: match[2]! }));
  const body = {
    name, version, level: result.declared_level as string, prefixes, toolchain, deps,
    cksum: result.cksum as string, iface_cksum: result.iface_cksum as string,
    snapshot_base64: snapshot.toString('base64'), interface_base64: bundle.toString('base64'),
  };
  return { body, snapshot, bundle, result };
}
