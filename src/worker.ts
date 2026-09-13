// The verification worker: for one candidate it rebuilds the publisher's
// release-mode check inside bubblewrap with the real `slate` client and
// `slatec`, against a `file://` mirror of the registry it materializes itself,
// and compares what the compiler produced with what was uploaded.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  compareInterfaces, digestBytes, encloses, levelAtLeast, parseInterface, parseManifest, policyDigest,
  readArchive, toolchainDigest, validateInterfacePath, validatePackagePath, type Level, type Policy, type Toolchain,
} from './protocol.js';
import { loadToolchain } from './toolchain.js';
import type { JobLease, JobResult, Registry } from './registry.js';

const MIRROR_INDEX = 'file:///work/registry/index/';

export interface IsolatedRun { code: number | null; outcome: 'exited' | 'timeout' | 'error'; stdout: Buffer; stderr: string }

function sandboxArguments(rootfs: string, work: string, argv: string[]): string[] {
  return ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    '--ro-bind', rootfs, '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--bind', work, '/work', '--chdir', '/work',
    '--setenv', 'TMPDIR', '/tmp', '--setenv', 'HOME', '/work/home', '--setenv', 'SLATE_HOME', '/work/home',
    '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--cap-drop', 'ALL', ...argv];
}

/** Run one program from the fixed rootfs with `work` as its only writable directory. */
export async function runIsolated(rootfs: string, work: string, policy: Policy, argv: string[]): Promise<IsolatedRun> {
  // Process-count limits belong to the dedicated worker's cgroup (TasksMax),
  // not RLIMIT_NPROC, which would count unrelated processes of the host UID.
  const args = ['--as=' + policy.memory_bytes, '--nofile=256',
    '--cpu=' + Math.ceil(policy.timeout_ms / 1000 + 1), '--', '/usr/bin/bwrap', ...sandboxArguments(rootfs, work, argv)];
  return new Promise(resolveRun => {
    let outcome: 'exited' | 'timeout' | 'error' = 'exited';
    let size = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stderrSize = 0;
    const child = spawn('/usr/bin/prlimit', args, { env: { PATH: '/usr/bin:/bin' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } };
    const timer = setTimeout(() => { outcome = 'timeout'; kill(); }, policy.timeout_ms);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > policy.max_output_bytes) { outcome = 'error'; kill(); } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize <= 64 * 1024) stderr.push(chunk); else { outcome = 'error'; kill(); }
    });
    child.on('error', error => { outcome = 'error'; stderr.push(Buffer.from(error.message)); });
    child.on('close', code => {
      clearTimeout(timer);
      resolveRun({ code, outcome, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

async function writeTree(root: string, entries: Iterable<[string, Uint8Array]>, mode = 0o600) {
  for (const [path, bytes] of entries) {
    const target = join(root, path);
    if (!resolve(target).startsWith(resolve(root) + '/')) throw new Error('PathEscapesRoot');
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode });
  }
}

/** Every module and theory identity in a report package must lie under a declared prefix. */
export function modulesOutsidePrefixes(report: Record<string, unknown>, name: string, prefixes: string[]): string[] {
  const outside: string[] = [];
  for (const pkg of (report.packages as Array<Record<string, unknown>> | undefined) ?? []) {
    if (pkg.name !== name) continue;
    for (const file of (pkg.files as Array<Record<string, unknown>> | undefined) ?? []) {
      if (file.kind !== 'module' && file.kind !== 'theory') continue;
      const id = typeof file.module_id === 'string' ? file.module_id : '';
      if (!id || !prefixes.some(prefix => encloses(prefix, id))) outside.push(id || String(file.path));
    }
  }
  return outside;
}

export class VerificationWorker {
  private toolchain: Toolchain | undefined;
  constructor(readonly directory: string, readonly policy: Policy) {}

  /** Load the pinned rootfs and prove the sandbox runs its client: `slate` with no arguments must fail with usage. */
  async initialize(): Promise<Toolchain> {
    this.toolchain = await loadToolchain(this.directory);
    const scratch = await mkdtemp(join(tmpdir(), 'pebble-isolation-probe-'));
    try {
      const result = await runIsolated(join(resolve(this.directory), 'rootfs'), scratch, this.policy, ['/slate']);
      if (result.outcome !== 'exited' || result.code !== 1 || !result.stderr.includes('Usage: slate')) {
        throw new Error('WorkerIsolationProbeFailed: ' + result.stderr.slice(0, 2048));
      }
    } finally { await rm(scratch, { recursive: true, force: true }); }
    return this.toolchain;
  }

  async verify(lease: JobLease, registry: Registry): Promise<JobResult> {
    if (!this.toolchain) throw new Error('WorkerNotInitialized');
    if (lease.toolchain !== registry.options.toolchainTag || toolchainDigest(this.toolchain) !== registry.options.toolchainDigest
        || policyDigest(this.policy) !== registry.options.policyDigest) return { outcome: 'error', diagnostic: 'ToolchainMismatch' };
    let work: string | undefined;
    try {
      const store = registry.options.objectStore;
      const keys = registry.stagingKeys(lease);
      const snapshot = await store.get(keys.snapshot);
      const bundle = await store.get(keys.interface);
      if (digestBytes(snapshot) !== lease.cksum || digestBytes(bundle) !== lease.iface_cksum) throw new Error('StagedArchiveCorrupt');
      const sources = readArchive(snapshot, validatePackagePath);
      const manifestText = sources.get('Slate.toml');
      if (!manifestText) throw new Error('SnapshotManifestMissing');
      const manifest = parseManifest(manifestText.toString('utf8'));
      if (manifest.name !== lease.name || manifest.version !== lease.version || manifest.toolchain !== lease.toolchain
          || JSON.stringify(manifest.namespace_prefixes) !== JSON.stringify([...lease.prefixes].sort())) throw new Error('ManifestBindingMismatch');
      const uploaded = readArchive(bundle, validateInterfacePath);
      const uploadedInterface = uploaded.get('interface');
      if (!uploadedInterface) throw new Error('InterfaceEntryMissing');

      // An offline mirror of the registry: index files and archives of the dependency closure.
      const materials = await registry.mirrorMaterials(manifest.dependencies.map(dependency => dependency.name));
      work = await mkdtemp(join(tmpdir(), 'pebble-verification-'));
      await mkdir(join(work, 'home'), { mode: 0o700 });
      await writeTree(join(work, 'project'), sources);
      await writeTree(join(work, 'registry'), [
        ['index/config.json', Buffer.from(JSON.stringify({ dl: 'file:///work/registry/dl/{package}/{version}/{package}-{version}', api: 'file:///work/registry/api/' }))],
        ...materials.index.map(({ path, text }) => [`index/${path}`, Buffer.from(text)] as [string, Uint8Array]),
      ]);
      for (const archive of materials.archives) {
        const bytes = await store.get(archive.key);
        await writeTree(join(work, 'registry'), [[`dl/${archive.name}/${archive.version}/${archive.name}-${archive.version}.${archive.suffix}`, bytes]]);
      }
      await writeFile(join(work, 'home', 'config.toml'), `[source.registry]\nreplace-with = "mirror"\n[source.mirror]\nindex = "${MIRROR_INDEX}"\n`, { mode: 0o600 });
      // The client resolves the manifest's own index name through the replacement above.
      const run = await runIsolated(join(resolve(this.directory), 'rootfs'), work, this.policy,
        ['/slate', 'check', '--release', '--slatec', '/slatec', '--manifest', '/work/project/Slate.toml']);
      if (run.outcome !== 'exited') return { outcome: run.outcome, diagnostic: run.outcome === 'timeout' ? 'CheckerTimeout' : 'CheckerProcessError' };
      let checked: Record<string, unknown>;
      try { checked = JSON.parse(run.stdout.toString('utf8')) as Record<string, unknown>; }
      catch { return { outcome: 'incomplete', diagnostic: ('CheckFailed: ' + run.stderr.trim()).slice(0, 4096) }; }
      if (run.code !== 0 || checked.status !== 'checked' || checked.mode !== 'release' || checked.dev_mode !== false) {
        return { outcome: 'incomplete', diagnostic: ('CheckIncomplete: ' + run.stderr.trim()).slice(0, 4096) };
      }
      const report = JSON.parse(await readFile(join(work, 'project', '.slate', 'report.json'), 'utf8')) as Record<string, unknown>;
      if (report.complete !== true || report.release_eligible !== false || report.dev_mode !== false) throw new Error('ReportNotComplete');
      const interfaceText = await readFile(join(work, 'project', '.slate', 'interfaces', `${lease.name}.interface`), 'utf8');
      if (!Buffer.from(interfaceText).equals(uploadedInterface)) {
        const ours = interfaceText.split('\n'), theirs = uploadedInterface.toString('utf8').split('\n');
        const at = ours.findIndex((line, i) => line !== theirs[i]);
        throw new Error(`InterfaceMismatch: the uploaded interface differs from the checked one at line ${at + 1}: checked ${JSON.stringify((ours[at] ?? '').slice(0, 200))}, uploaded ${JSON.stringify((theirs[at] ?? '').slice(0, 200))}`);
      }
      // Every shipped statement must be exactly what this check persisted; nothing else may be shipped.
      const objects = join(work, 'project', '.slate', 'cache', 'objects');
      const expected = new Map<string, Buffer>([['interface', uploadedInterface]]);
      for (const pkg of (report.packages as Array<Record<string, unknown>>)) {
        if (pkg.name !== lease.name) continue;
        for (const file of pkg.files as Array<Record<string, unknown>>) {
          if (typeof file.module_id !== 'string' || typeof file.module_object_hash !== 'string') continue;
          for (const suffix of ['slateobj', 'slatecache']) {
            const path = `objects/${file.module_id}/${file.module_object_hash}.${suffix}`;
            expected.set(path, await readFile(join(objects, file.module_id, `${file.module_object_hash}.${suffix}`)));
          }
        }
      }
      if (uploaded.size !== expected.size || [...expected].some(([path, bytes]) => !uploaded.get(path)?.equals(bytes))) {
        throw new Error('StatementBundleMismatch: the uploaded statements differ from the checked ones');
      }
      const outside = modulesOutsidePrefixes(report, lease.name, manifest.namespace_prefixes);
      if (outside.length) throw new Error(`ModuleOutsideDeclaredPrefixes: ${outside.sort().join(', ')}`);
      const next = parseInterface(interfaceText);
      const previous = await registry.previousInterface(lease.name, lease.version);
      let computed: Level = 'patch';
      let reasons: string[] = ['first published version'];
      if (previous) ({ level: computed, reasons } = compareInterfaces(parseInterface(previous.interface_text), next));
      if (!levelAtLeast(lease.level, computed)) {
        return { outcome: 'rejected', report, computed_level: computed, interface_text: interfaceText,
          diagnostic: `DeclaredLevelBelowComputed: declared ${lease.level} but the interface change is ${computed} (${reasons.join('; ')})` };
      }
      // The sources must be untouched by the run.
      for (const [path, bytes] of sources) {
        if (!(await readFile(join(work, 'project', path))).equals(Buffer.from(bytes))) throw new Error('VerificationSourcesChanged');
      }
      return { outcome: 'passed', report, computed_level: computed, interface_text: interfaceText };
    } catch (error) {
      return { outcome: 'error', diagnostic: error instanceof Error ? error.message : 'VerificationFailed' };
    } finally { if (work) await rm(work, { recursive: true, force: true }); }
  }

  /** Claim, verify, record; a maintainer's passing candidate publishes immediately. */
  async runOne(registry: Registry): Promise<boolean> {
    const lease = await registry.claimJob();
    if (!lease) return false;
    const heartbeat = setInterval(() => { void registry.renewJob(lease).catch(() => false); }, 5000);
    let result: JobResult;
    try { result = await this.verify(lease, registry); await registry.completeJob(lease, result); }
    finally { clearInterval(heartbeat); }
    if (result.outcome === 'passed' && lease.creator_maintainer) await registry.publishCandidate(lease.candidate_id);
    return true;
  }
}

