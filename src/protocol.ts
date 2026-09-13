import { createHash } from 'node:crypto';

export const SNAPSHOT_SCHEMA = 'Pebble.PackageSnapshot.v1';
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 4096;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HASH = /^[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export interface FileEntry { path: string; sha256: string; byte_length: number }
export interface Dependency { package_id: string; version: string; snapshot_digest: string }
export interface Research {
  title: string; summary: string; license: string; authors: string[];
  formalizers: string[]; maintainers: string[]; kind: 'formalization' | 'original';
  claims: string; assumptions: string; citations: string[]; usage: string;
}
export interface Snapshot {
  schema: typeof SNAPSHOT_SCHEMA; package_id: string; version: string;
  toolchain_digest: string; dependencies: Dependency[]; files: FileEntry[]; research: Research;
}
export interface Blob { sha256: string; content_base64: string }
export interface Bundle { snapshot: Snapshot; blobs: Blob[] }
export interface Toolchain {
  schema: 'Pebble.Toolchain.v1'; slatec_sha256: string; files: FileEntry[];
}
export interface Policy {
  schema: 'Pebble.VerificationPolicy.v1'; source_check_policy: 'Slate.SourcePackagePolicy.v1';
  timeout_ms: number; max_output_bytes: number; max_package_bytes: number;
  max_package_files: number; memory_bytes: number;
}
export const DEFAULT_POLICY: Policy = {
  schema: 'Pebble.VerificationPolicy.v1', source_check_policy: 'Slate.SourcePackagePolicy.v1',
  timeout_ms: 30_000, max_output_bytes: 32 * 1024 * 1024,
  max_package_bytes: MAX_PACKAGE_BYTES, max_package_files: MAX_PACKAGE_FILES,
  memory_bytes: 2 * 1024 * 1024 * 1024,
};

export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    // Reject unpaired surrogates: every admitted string has one UTF-8 encoding.
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('InvalidUnicode');
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('InvalidUnicode');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw new Error('InvalidInteger');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && value) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.some(key => !/^[a-z_][a-z0-9_]*$/.test(key))) throw new Error('InvalidObjectKey');
    return '{' + keys.map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
  }
  throw new Error('InvalidCanonicalValue');
}

export function digestBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function digest(domain: string, value: unknown): string {
  return digestBytes(domain + '\0' + canonical(value));
}
export function snapshotDigest(snapshot: Snapshot): string { return digest(SNAPSHOT_SCHEMA, snapshot); }
export function toolchainDigest(toolchain: Toolchain): string { return digest(toolchain.schema, toolchain); }
export function policyDigest(policy: Policy): string { return digest(policy.schema, policy); }

function record(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) throw new Error('InvalidFields');
}
function text(value: unknown, max = 8192): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('InvalidText');
  canonical(value);
}
function names(value: unknown, allowEmpty = false): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 64 || (!allowEmpty && value.length === 0)) throw new Error('InvalidNames');
  for (const name of value) text(name, 2048);
}
export function validatePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length > 512 || !path.length) throw new Error('InvalidPath');
  const parts = path.split('/');
  if (parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..'
      || /\.(slateobj|slatecache)$/i.test(part))) throw new Error('InvalidPath');
  if (path === 'slate.toml' || path === 'slate.lock') throw new Error('ManifestIsSeparate');
  if (!/\.(slate|md|txt)$/.test(path)) throw new Error('UnsupportedFileKind');
}
export function validateSnapshot(value: unknown): Snapshot {
  record(value, ['schema', 'package_id', 'version', 'toolchain_digest', 'dependencies', 'files', 'research']);
  if (value.schema !== SNAPSHOT_SCHEMA || typeof value.package_id !== 'string' || !UUID.test(value.package_id)
      || typeof value.version !== 'string' || !VERSION.test(value.version)
      || typeof value.toolchain_digest !== 'string' || !HASH.test(value.toolchain_digest)) throw new Error('InvalidSnapshotIdentity');
  const research = value.research;
  record(research, ['title', 'summary', 'license', 'authors', 'formalizers', 'maintainers', 'kind', 'claims', 'assumptions', 'citations', 'usage']);
  for (const key of ['title', 'summary', 'license', 'claims', 'assumptions', 'usage']) text(research[key]);
  if (research.kind !== 'formalization' && research.kind !== 'original') throw new Error('InvalidResearchKind');
  for (const key of ['authors', 'formalizers', 'maintainers']) names(research[key]);
  names(research.citations, true);
  if (!Array.isArray(value.dependencies) || value.dependencies.length > 128) throw new Error('InvalidDependencies');
  let last = '';
  for (const dep of value.dependencies) {
    record(dep, ['package_id', 'version', 'snapshot_digest']);
    if (typeof dep.package_id !== 'string' || !UUID.test(dep.package_id) || dep.package_id <= last
        || dep.package_id === value.package_id || typeof dep.version !== 'string' || !VERSION.test(dep.version)
        || typeof dep.snapshot_digest !== 'string' || !HASH.test(dep.snapshot_digest)) throw new Error('InvalidDependency');
    last = dep.package_id;
  }
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > MAX_PACKAGE_FILES) throw new Error('InvalidFiles');
  last = '';
  let total = 0;
  const pathKinds = new Map<string, string>();
  const blobLengths = new Map<string, number>();
  for (const file of value.files) {
    record(file, ['path', 'sha256', 'byte_length']);
    validatePath(file.path);
    if (file.path <= last || typeof file.sha256 !== 'string' || !HASH.test(file.sha256)
        || typeof file.byte_length !== 'number' || !Number.isSafeInteger(file.byte_length)
        || file.byte_length <= 0 || file.byte_length > MAX_PACKAGE_BYTES) throw new Error('InvalidFile');
    total += file.byte_length;
    if (blobLengths.has(file.sha256) && blobLengths.get(file.sha256) !== file.byte_length) throw new Error('InconsistentBlobLength');
    blobLengths.set(file.sha256, file.byte_length);
    if (total > MAX_PACKAGE_BYTES) throw new Error('PackageTooLarge');
    last = file.path;
    const parts = file.path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const kind = prefix + (i === parts.length ? ':file' : ':directory');
      const existing = pathKinds.get(prefix.toLowerCase());
      if (existing && existing !== kind) throw new Error('PathCollision');
      pathKinds.set(prefix.toLowerCase(), kind);
    }
  }
  if (!value.files.some(file => file.path.endsWith('.slate'))) throw new Error('NoFormalSources');
  canonical(value);
  return value as unknown as Snapshot;
}
export function validateBundle(value: unknown): Bundle {
  record(value, ['snapshot', 'blobs']);
  const snapshot = validateSnapshot(value.snapshot);
  if (!Array.isArray(value.blobs) || value.blobs.length > MAX_PACKAGE_FILES) throw new Error('InvalidBlobs');
  const wanted = new Map(snapshot.files.map(file => [file.sha256, file.byte_length]));
  const seen = new Set<string>();
  for (const blob of value.blobs) {
    record(blob, ['sha256', 'content_base64']);
    if (typeof blob.sha256 !== 'string' || !wanted.has(blob.sha256) || seen.has(blob.sha256)
        || typeof blob.content_base64 !== 'string' || blob.content_base64.length > Math.ceil(MAX_PACKAGE_BYTES / 3) * 4) throw new Error('UnexpectedBlob');
    const bytes = Buffer.from(blob.content_base64, 'base64');
    if (bytes.toString('base64') !== blob.content_base64 || bytes.length !== wanted.get(blob.sha256)
        || digestBytes(bytes) !== blob.sha256) throw new Error('BlobDigestMismatch');
    seen.add(blob.sha256);
  }
  if (seen.size !== wanted.size) throw new Error('MissingBlob');
  return { snapshot, blobs: value.blobs as Blob[] };
}
