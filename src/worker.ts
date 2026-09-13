import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  canonical, digest, digestBytes, snapshotDigest, toolchainDigest, policyDigest,
  validateBundle, type Bundle, type FileEntry, type Policy, type Toolchain,
} from './protocol.js';
import { loadToolchain } from './toolchain.js';
import type { JobLease, JobResult, Registry } from './registry.js';

export function verificationInputDigest(root: Bundle, dependencies: Bundle[], toolchain: string, policy: string): string {
  return digest('Pebble.VerificationInput.v1', {
    root_snapshot_digest: snapshotDigest(root.snapshot),
    dependency_snapshots: dependencies.map(bundle => ({
      package_id: bundle.snapshot.package_id, snapshot_digest: snapshotDigest(bundle.snapshot),
    })).sort((a, b) => a.package_id.localeCompare(b.package_id)),
    toolchain_digest: toolchain, policy_digest: policy,
  });
}

export function reportMatchesInput(value: unknown, expected: FileEntry[], policy: Policy): boolean {
  if (!value || typeof value !== 'object') return false;
  const report = value as Record<string, unknown>;
  if (report.schema !== 'Slate.PackageCheckReport.v1' || report.report_scope !== 'source_only'
      || report.publication_status !== 'not_published' || report.release_eligible !== false
      || report.source_inventory_complete !== true || !Array.isArray(report.files)
      || report.source_check_policy !== policy.source_check_policy
      || typeof report.formal_checks_eligible !== 'boolean' || typeof report.complete !== 'boolean') return false;
  try {
    const files = report.files as Record<string, unknown>[];
    const actual = files.map(file => ({ path: file.path, byte_length: file.byte_length, sha256: file.sha256 }));
    if (canonical(actual) !== canonical(expected)) return false;
    if (report.formal_checks_eligible !== report.complete) return false;
    if (report.complete) {
      if (!Array.isArray(report.diagnostics) || report.diagnostics.length) return false;
      for (const file of files) {
        if (!Array.isArray(file.declarations)) return false;
        if (typeof file.path !== 'string') return false;
        if (!file.path.endsWith('.slate')) {
          if (file.kind !== 'attachment') return false;
          if (file.status !== 'not_applicable' || file.declarations.length) return false;
        } else {
          if (file.status !== 'passed' || typeof file.module_id !== 'string' || !file.module_id) return false;
          const hash = file.kind === 'module' ? file.module_object_hash : file.kind === 'theory' ? file.theory_package_hash : null;
          if (typeof hash !== 'string' || !hash) return false;
        }
        for (const declaration of file.declarations as Record<string, unknown>[]) {
          if (declaration.kind === 'program') return false;
          if (declaration.kind === 'theorem') {
            const checked = declaration.checked as Record<string, unknown> | null;
            if (declaration.status !== 'passed' || !checked || checked.publication_profile !== 'DirectExactProof'
                || checked.source_proof_kind !== 'inline') return false;
            for (const key of ['fact_id', 'theory_id', 'canonical_target', 'theory_hash', 'source_hash',
              'target_hash', 'certificate_hash', 'dependency_closure_hash', 'assumption_closure_hash']) {
              if (typeof checked[key] !== 'string' || !checked[key]) return false;
            }
          } else if (declaration.status !== 'checked_declaration' && declaration.status !== 'checked_theory') return false;
        }
      }
    }
    return true;
  } catch { return false; }
}

function sandboxArguments(rootfs: string, input: string): string[] {
  return ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    '--ro-bind', rootfs, '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', input, '/input', '--chdir', '/input', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8', '--cap-drop', 'ALL', '/slatec', 'check-package', '/input'];
}

export async function runIsolated(rootfs: string, input: string, policy: Policy): Promise<{
  code: number | null; outcome: 'exited' | 'timeout' | 'error'; stdout: Buffer; stderr: string;
}> {
  // Process-count limits belong to the dedicated worker's cgroup (TasksMax),
  // not RLIMIT_NPROC, which would count unrelated processes of the host UID.
  const args = ['--as=' + policy.memory_bytes, '--nofile=128',
    '--cpu=' + Math.ceil(policy.timeout_ms / 1000 + 1), '--', '/usr/bin/bwrap', ...sandboxArguments(rootfs, input)];
  return new Promise(resolveRun => {
    let outcome: 'exited' | 'timeout' | 'error' = 'exited';
    let size = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stderrSize = 0;
    const process = spawn('/usr/bin/prlimit', args, {
      env: { PATH: '/usr/bin:/bin' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const kill = () => {
      if (process.pid) try { globalThis.process.kill(-process.pid, 'SIGKILL'); } catch { /* already exited */ }
    };
    const timer = setTimeout(() => { outcome = 'timeout'; kill(); }, policy.timeout_ms);
    process.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > policy.max_output_bytes) { outcome = 'error'; kill(); }
      else stdout.push(chunk);
    });
    process.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize <= 64 * 1024) stderr.push(chunk);
      else { outcome = 'error'; kill(); }
    });
    process.on('error', error => { outcome = 'error'; stderr.push(Buffer.from(error.message)); });
    process.on('close', code => {
      clearTimeout(timer);
      resolveRun({ code, outcome, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

export class VerificationWorker {
  private toolchain: Toolchain | undefined;
  constructor(readonly directory: string, readonly policy: Policy) {}
  async initialize(): Promise<Toolchain> {
    // This rootfs is operator-owned and must remain read-only to the service.
    this.toolchain = await loadToolchain(this.directory);
    const scratch = await mkdtemp(join(tmpdir(), 'pebble-isolation-probe-'));
    try {
      const result = await runIsolated(join(resolve(this.directory), 'rootfs'), scratch, this.policy);
      if (!result.stdout.length) throw new Error('WorkerIsolationProbeFailed: ' + result.stderr.slice(0, 2048));
      const report = JSON.parse(result.stdout.toString('utf8')) as Record<string, unknown>;
      if (result.outcome !== 'exited' || result.code !== 1 || report.schema !== 'Slate.PackageCheckReport.v1'
          || report.formal_checks_eligible !== false || report.source_check_policy !== this.policy.source_check_policy) {
        throw new Error('WorkerIsolationProbeFailed');
      }
    } finally { await rm(scratch, { recursive: true, force: true }); }
    return this.toolchain;
  }
  async verify(lease: JobLease): Promise<JobResult> {
    if (!this.toolchain) throw new Error('WorkerNotInitialized');
    const result: JobResult = { outcome: 'error', input_digest: lease.input_digest,
      toolchain_digest: toolchainDigest(this.toolchain), policy_digest: policyDigest(this.policy) };
    let scratch: string | undefined;
    try {
      if (lease.toolchain_digest !== result.toolchain_digest || lease.policy_digest !== result.policy_digest
          || lease.input_digest !== verificationInputDigest(lease.root, lease.dependencies, result.toolchain_digest, result.policy_digest)) throw new Error('VerificationInputBindingMismatch');
      const all = [lease.root, ...lease.dependencies];
      if (all.length > 1024) throw new Error('DependencyGraphBudgetExceeded');
      const nodes = new Map(all.map(bundle => [bundle.snapshot.package_id, bundle]));
      if (nodes.size !== all.length) throw new Error('DependencyIdentityConflict');
      // Independently check the exact reachable graph before materialization.
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const stack: Array<{ id: string; exit: boolean }> = [{ id: lease.root.snapshot.package_id, exit: false }];
      while (stack.length) {
        const next = stack.pop()!;
        if (next.exit) { visiting.delete(next.id); visited.add(next.id); continue; }
        if (visiting.has(next.id)) throw new Error('DependencyCycle');
        if (visited.has(next.id)) continue;
        const node = nodes.get(next.id)!;
        visiting.add(next.id);
        stack.push({ id: next.id, exit: true });
        for (const edge of node.snapshot.dependencies) {
          const dependency = nodes.get(edge.package_id);
          if (!dependency || dependency.snapshot.version !== edge.version
              || snapshotDigest(dependency.snapshot) !== edge.snapshot_digest) throw new Error('DependencyEdgeMismatch');
          stack.push({ id: edge.package_id, exit: false });
        }
      }
      if (visited.size !== nodes.size) throw new Error('UnreachableDependency');
      const ids = new Set<string>();
      const expected: FileEntry[] = [];
      let total = 0;
      scratch = await mkdtemp(join(tmpdir(), 'pebble-verification-'));
      for (const raw of all) {
        const bundle = validateBundle(raw);
        if (ids.has(bundle.snapshot.package_id) || bundle.snapshot.toolchain_digest !== result.toolchain_digest) throw new Error('DependencyIdentityConflict');
        ids.add(bundle.snapshot.package_id);
        const blobs = new Map(bundle.blobs.map(blob => [blob.sha256, Buffer.from(blob.content_base64, 'base64')]));
        for (const file of bundle.snapshot.files) {
          total += file.byte_length;
          if (total > 256 * 1024 * 1024 || expected.length >= 16384) throw new Error('DependencyGraphBudgetExceeded');
          const path = `packages/${bundle.snapshot.package_id}/${file.path}`;
          const target = join(scratch, path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, blobs.get(file.sha256)!, { flag: 'wx', mode: 0o400 });
          expected.push({ ...file, path });
        }
      }
      expected.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const run = await runIsolated(join(resolve(this.directory), 'rootfs'), scratch, this.policy);
      if (run.outcome !== 'exited') return { ...result, outcome: run.outcome, diagnostic: run.outcome === 'timeout' ? 'CheckerTimeout' : 'CheckerProcessError' };
      if (run.code !== 0 && run.code !== 1) return { ...result, diagnostic: 'CheckerProcessFailed: ' + run.stderr.slice(0, 2048) };
      const report = JSON.parse(run.stdout.toString('utf8')) as Record<string, unknown>;
      if (!reportMatchesInput(report, expected, this.policy)) throw new Error('IncompleteOrMismatchedCheckerReport');
      if ((run.code === 0) !== (report.formal_checks_eligible === true)) throw new Error('CheckerExitReportMismatch');
      for (const file of expected) {
        const bytes = await readFile(join(scratch, file.path));
        if (bytes.length !== file.byte_length || digestBytes(bytes) !== file.sha256) throw new Error('VerificationSourcesChanged');
      }
      return { ...result, outcome: report.formal_checks_eligible ? 'passed' : 'incomplete', report,
        diagnostic: report.formal_checks_eligible ? undefined : 'FormalSourceChecksIncomplete' };
    } catch (error) {
      return { ...result, diagnostic: error instanceof Error ? error.message : 'VerificationFailed' };
    } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }
  async runOne(registry: Registry): Promise<boolean> {
    const lease = await registry.claimJob();
    if (!lease) return false;
    const heartbeat = setInterval(() => { void registry.renewJob(lease).catch(() => false); }, 5000);
    try { await registry.completeJob(lease, await this.verify(lease)); }
    finally { clearInterval(heartbeat); }
    return true;
  }
}
