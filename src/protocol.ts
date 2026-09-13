// The registry protocol shared with the Slate client (SPEC-0227): package
// names, versions, requirements, the manifest subset the registry reads, the
// sparse index line, the `Slate.PackageInterface` comparison and the archive
// reader. Nothing here decides mathematical acceptance.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
export const MAX_PACKAGE_FILES = 4096;
export const MAX_DEPENDENCIES = 128;
export const MAX_TEXT_UNITS = 8192;
export const MAX_LIST_ENTRIES = 64;
export const MAX_ENTRY_UNITS = 2048;
export const HASH = /^[0-9a-f]{64}$/;
export const PACKAGE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
export const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/;
export const PREFIX = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;
export const TOOLCHAIN_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const RESERVED_PREFIXES = ['Std', 'Math', 'Slate'];
export const LEVELS = ['patch', 'minor', 'major'] as const;
export type Level = typeof LEVELS[number];
export const INTERFACE_SCHEMA = 'Slate.PackageInterface';
export const RESEARCH_TEXT = ['title', 'summary', 'claims', 'assumptions', 'usage'] as const;
export const RESEARCH_LISTS = ['authors', 'formalizers', 'maintainers'] as const;

export interface Toolchain {
  schema: 'Pebble.Toolchain'; slatec_sha256: string; slate_sha256: string; files: FileEntry[];
}
export interface FileEntry { path: string; sha256: string; byte_length: number }
export interface Policy {
  schema: 'Pebble.VerificationPolicy'; timeout_ms: number; max_output_bytes: number;
  max_package_bytes: number; max_package_files: number; memory_bytes: number;
}
export const DEFAULT_POLICY: Policy = {
  schema: 'Pebble.VerificationPolicy', timeout_ms: 120_000, max_output_bytes: 32 * 1024 * 1024,
  max_package_bytes: MAX_PACKAGE_BYTES, max_package_files: MAX_PACKAGE_FILES,
  memory_bytes: 4 * 1024 * 1024 * 1024,
};

export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
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
export function toolchainDigest(toolchain: Toolchain): string { return digest(toolchain.schema, toolchain); }
export function policyDigest(policy: Policy): string { return digest(policy.schema, policy); }

// ---- versions and requirements (cargo semantics, as the client implements them)

export interface Version { major: number; minor: number; patch: number; pre: string[] }
export function parseVersion(text: string): Version {
  const match = VERSION.exec(text);
  if (!match) throw new Error('InvalidVersion');
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].slice(1).split('.') : [] };
}
function compareIdentifiers(a: string, b: string): number {
  const na = /^[0-9]+$/.test(a), nb = /^[0-9]+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (i >= a.pre.length) return -1;
    if (i >= b.pre.length) return 1;
    const c = compareIdentifiers(a.pre[i]!, b.pre[i]!);
    if (c) return c;
  }
  return 0;
}
/** The level a version step declares: the most significant changed component. */
export function levelOfVersions(previous: Version, next: Version): Level {
  if (compareVersions(next, previous) <= 0) throw new Error('VersionMustIncrease');
  if (next.major !== previous.major) return 'major';
  if (next.minor !== previous.minor) return 'minor';
  return 'patch';
}
export function levelAtLeast(declared: Level, computed: Level): boolean {
  return LEVELS.indexOf(declared) >= LEVELS.indexOf(computed);
}
/** Syntactic check of a cargo requirement (comparators, caret, tilde, wildcard partials); `*` alone is rejected. */
export function validateRequirement(text: string): void {
  if (typeof text !== 'string' || !text.trim() || text.length > 200) throw new Error('InvalidRequirement');
  if (text.trim() === '*') throw new Error('WildcardRequirementForbidden');
  const comparator = /^(?:[<>]=?|=|\^|~)?\s*(?:\d+|\*)(?:\.(?:\d+|\*))?(?:\.(?:\d+|\*))?(?:-[0-9A-Za-z.-]+)?$/;
  for (const part of text.split(',')) {
    if (!comparator.test(part.trim())) throw new Error('InvalidRequirement');
  }
}

// ---- names, prefixes, manifest

export function validateName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) throw new Error('InvalidPackageName');
}
export function validatePrefix(prefix: unknown): asserts prefix is string {
  if (typeof prefix !== 'string' || prefix.length > 512 || !PREFIX.test(prefix)) throw new Error('InvalidNamespacePrefix');
}
/** `Set` encloses `Set.Quotient`; a prefix encloses itself. */
export function encloses(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(outer + '.');
}
export function isReservedPrefix(prefix: string): boolean {
  return RESERVED_PREFIXES.some(reserved => encloses(reserved, prefix));
}
/**
 * Whether `declared` may be published by `packageId` given the registry's
 * prefix ownership. A prefix is free when nobody owns it, an enclosing prefix
 * or an enclosed prefix; a prefix owned exactly by this package is always
 * allowed (a sub-prefix yielded to another package does not block its owner).
 */
export function prefixConflict(declared: string, packageId: string, owned: Iterable<{ prefix: string; package_id: string }>): string | null {
  let exact: string | undefined;
  const others: string[] = [];
  for (const row of owned) {
    if (row.prefix === declared) exact = row.package_id;
    else if (row.package_id !== packageId && (encloses(row.prefix, declared) || encloses(declared, row.prefix))) others.push(row.prefix);
  }
  if (exact !== undefined) return exact === packageId ? null : `PrefixOwnedByAnotherPackage: ${declared}`;
  if (others.length) return `PrefixOverlap: ${declared} with ${others.sort()[0]}`;
  return null;
}

export interface Research {
  title: string; summary: string; authors: string[]; formalizers: string[]; maintainers: string[];
  kind: 'formalization' | 'original'; claims: string; assumptions: string; citations: string[]; usage: string;
}
export interface Manifest {
  name: string; version: string; namespace_prefixes: string[]; toolchain: string; license: string;
  index?: string; research: Research; dependencies: Array<{ name: string; req: string }>;
}

interface TomlTable { [key: string]: TomlValue }
type TomlValue = string | boolean | number | TomlValue[] | TomlTable;

/** The TOML subset `Slate.toml` uses: tables, `key = value`, strings, arrays, inline tables, comments. */
export function parseToml(text: string): Record<string, TomlTable> {
  if (text.length > MAX_PACKAGE_BYTES) throw new Error('ManifestTooLarge');
  const result: Record<string, TomlTable> = {};
  let table: TomlTable | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]!).trim();
    if (!line) continue;
    const header = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
    if (header) {
      const name = header[1]!;
      if (result[name]) throw new Error(`DuplicateTable: ${name}`);
      table = result[name] = {};
      continue;
    }
    const separator = line.indexOf('=');
    if (separator < 1 || !table) throw new Error(`ManifestSyntax: line ${i + 1}`);
    let key = line.slice(0, separator).trim();
    const quoted = /^"([^"\\]*)"$/.exec(key);
    if (quoted) key = quoted[1]!;
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`ManifestKey: line ${i + 1}`);
    let value = line.slice(separator + 1).trim();
    // Arrays may span lines; join until brackets balance outside strings.
    while (bracketDepth(value) > 0 && i + 1 < lines.length) value += ' ' + stripComment(lines[++i]!).trim();
    if (key in table) throw new Error(`DuplicateKey: ${key}`);
    table[key] = parseTomlValue(value);
  }
  return result;
}
function stripComment(line: string): string {
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inString) {
      if (c === '\\' && inString === '"') i++;
      else if (c === inString) inString = null;
    } else if (c === '"' || c === "'") inString = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}
function bracketDepth(text: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === '\\' && inString === '"') i++;
      else if (c === inString) inString = null;
    } else if (c === '"' || c === "'") inString = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth;
}
function parseTomlValue(text: string): TomlValue {
  const [value, rest] = readTomlValue(text.trim());
  if (rest.trim()) throw new Error('ManifestSyntax: trailing content');
  return value;
}
function readTomlValue(text: string): [TomlValue, string] {
  if (text.startsWith('"')) {
    let out = '';
    for (let i = 1; i < text.length; i++) {
      const c = text[i]!;
      if (c === '\\') {
        const next = text[++i];
        const simple: Record<string, string> = { '"': '"', '\\': '\\', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
        if (next !== undefined && next in simple) out += simple[next];
        else if (next === 'u' || next === 'U') {
          const width = next === 'u' ? 4 : 8;
          const hex = text.slice(i + 1, i + 1 + width);
          if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) throw new Error('ManifestEscape');
          out += String.fromCodePoint(parseInt(hex, 16));
          i += width;
        } else throw new Error('ManifestEscape');
      } else if (c === '"') return [out, text.slice(i + 1)];
      else out += c;
    }
    throw new Error('ManifestSyntax: unterminated string');
  }
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    if (end < 0) throw new Error('ManifestSyntax: unterminated string');
    return [text.slice(1, end), text.slice(end + 1)];
  }
  if (text.startsWith('[')) {
    const items: TomlValue[] = [];
    let rest = text.slice(1).trim();
    while (!rest.startsWith(']')) {
      if (!rest) throw new Error('ManifestSyntax: unterminated array');
      const [item, after] = readTomlValue(rest);
      items.push(item);
      rest = after.trim();
      if (rest.startsWith(',')) rest = rest.slice(1).trim();
      else if (!rest.startsWith(']')) throw new Error('ManifestSyntax: array separator');
    }
    return [items, rest.slice(1)];
  }
  if (text.startsWith('{')) {
    const record: TomlTable = {};
    let rest = text.slice(1).trim();
    while (!rest.startsWith('}')) {
      const match = /^([A-Za-z0-9_-]+)\s*=\s*/.exec(rest);
      if (!match) throw new Error('ManifestSyntax: inline table');
      const [item, after] = readTomlValue(rest.slice(match[0].length));
      if (match[1]! in record) throw new Error(`DuplicateKey: ${match[1]}`);
      record[match[1]!] = item;
      rest = after.trim();
      if (rest.startsWith(',')) rest = rest.slice(1).trim();
      else if (!rest.startsWith('}')) throw new Error('ManifestSyntax: inline table separator');
    }
    return [record, rest.slice(1)];
  }
  const literal = /^(true|false|-?\d+)/.exec(text);
  if (literal) {
    const token = literal[1]!;
    return [token === 'true' ? true : token === 'false' ? false : Number(token), text.slice(token.length)];
  }
  throw new Error('ManifestSyntax: value');
}

function text(value: unknown, max: number, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`InvalidResearchText: ${label}`);
  canonical(value);
}
function stringList(value: unknown, label: string, allowEmpty: boolean): asserts value is string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES || (!allowEmpty && !value.length)) throw new Error(`InvalidResearchList: ${label}`);
  for (const entry of value) text(entry, MAX_ENTRY_UNITS, label);
}
function exactKeys(record: Record<string, unknown> | undefined, keys: readonly string[], label: string): Record<string, unknown> {
  if (!record) throw new Error(`ManifestSectionRequired: ${label}`);
  const actual = Object.keys(record).sort().join(',');
  if (actual !== [...keys].sort().join(',')) throw new Error(`ManifestSectionFields: ${label}`);
  return record;
}

/** Parse and validate a publishable `Slate.toml`: one package with research metadata and registry dependencies only. */
export function parseManifest(source: string): Manifest {
  const toml = parseToml(source);
  const allowed = new Set(['package', 'registry', 'research', 'dependencies']);
  for (const table of Object.keys(toml)) if (!allowed.has(table)) throw new Error(`ManifestTableForbidden: ${table}`);
  const pkg = toml.package as Record<string, unknown> | undefined;
  const packageKeys = ['name', 'version', 'toolchain', 'license', ...(pkg && 'namespace_prefixes' in pkg ? ['namespace_prefixes'] : [])];
  exactKeys(pkg, packageKeys, 'package');
  validateName(pkg!.name);
  if (typeof pkg!.version !== 'string') throw new Error('InvalidVersion');
  const version = parseVersion(pkg!.version);
  if (version.pre.length) throw new Error('PrereleasePublicationUnsupported');
  if (typeof pkg!.toolchain !== 'string' || !TOOLCHAIN_TAG.test(pkg!.toolchain)) throw new Error('InvalidToolchainTag');
  text(pkg!.license, MAX_ENTRY_UNITS, 'license');
  const prefixes = (pkg!.namespace_prefixes ?? []) as unknown;
  if (!Array.isArray(prefixes) || prefixes.length > MAX_LIST_ENTRIES) throw new Error('InvalidNamespacePrefix');
  const seen = new Set<string>();
  for (const prefix of prefixes) {
    validatePrefix(prefix);
    if (seen.has(prefix)) throw new Error(`DuplicateNamespacePrefix: ${prefix}`);
    seen.add(prefix);
  }
  let index: string | undefined;
  if (toml.registry) {
    const registry = exactKeys(toml.registry, ['index'], 'registry');
    if (typeof registry.index !== 'string' || !/^(https:\/\/|file:\/\/\/|http:\/\/127\.0\.0\.1|http:\/\/localhost)/.test(registry.index)) throw new Error('InvalidRegistryIndex');
    index = registry.index;
  }
  const research = exactKeys(toml.research, ['title', 'summary', 'authors', 'formalizers', 'maintainers', 'kind', 'claims', 'assumptions', 'citations', 'usage'], 'research');
  for (const key of RESEARCH_TEXT) text(research[key], MAX_TEXT_UNITS, key);
  for (const key of RESEARCH_LISTS) stringList(research[key], key, false);
  stringList(research.citations, 'citations', true);
  if (research.kind !== 'formalization' && research.kind !== 'original') throw new Error('InvalidResearchKind');
  const dependencies: Array<{ name: string; req: string }> = [];
  for (const [name, spec] of Object.entries(toml.dependencies ?? {})) {
    validateName(name);
    if (name === pkg!.name) throw new Error('SelfDependency');
    let req: unknown;
    if (typeof spec === 'string') req = spec;
    else if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
      const keys = Object.keys(spec).sort().join(',');
      if (keys === 'version') req = (spec as Record<string, unknown>).version;
      else if (keys === 'path') throw new Error(`PathDependencyCannotBePublished: ${name}`);
      else throw new Error(`InvalidDependency: ${name}`);
    } else throw new Error(`InvalidDependency: ${name}`);
    if (typeof req !== 'string') throw new Error(`InvalidDependency: ${name}`);
    validateRequirement(req);
    dependencies.push({ name, req });
  }
  if (dependencies.length > MAX_DEPENDENCIES) throw new Error('TooManyDependencies');
  dependencies.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    name: pkg!.name, version: pkg!.version, namespace_prefixes: [...seen].sort(), toolchain: pkg!.toolchain,
    license: pkg!.license, index, research: research as unknown as Research, dependencies,
  };
}

// ---- publish request (PUT /api/v1/packages/new, as the client sends it)

export interface PublishRequest {
  name: string; version: string; level: Level; prefixes: string[]; toolchain: string;
  deps: Array<{ name: string; req: string }>; cksum: string; iface_cksum: string;
  snapshot: Buffer; interface: Buffer;
  /** The archived `Slate.toml`, filled in after the snapshot is read. */
  manifest?: string;
}
export function validatePublishRequest(body: unknown): PublishRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('InvalidRequestBody');
  const record = body as Record<string, unknown>;
  const keys = ['name', 'version', 'level', 'prefixes', 'toolchain', 'deps', 'cksum', 'iface_cksum', 'snapshot_base64', 'interface_base64'];
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) throw new Error('InvalidRequestFields');
  validateName(record.name);
  if (typeof record.version !== 'string') throw new Error('InvalidVersion');
  if (parseVersion(record.version).pre.length) throw new Error('PrereleasePublicationUnsupported');
  if (typeof record.level !== 'string' || !(LEVELS as readonly string[]).includes(record.level)) throw new Error('InvalidLevel');
  if (!Array.isArray(record.prefixes) || record.prefixes.length > MAX_LIST_ENTRIES) throw new Error('InvalidNamespacePrefix');
  for (const prefix of record.prefixes) validatePrefix(prefix);
  if (typeof record.toolchain !== 'string' || !TOOLCHAIN_TAG.test(record.toolchain)) throw new Error('InvalidToolchainTag');
  if (!Array.isArray(record.deps) || record.deps.length > MAX_DEPENDENCIES) throw new Error('InvalidDependencies');
  const deps: Array<{ name: string; req: string }> = [];
  for (const dep of record.deps) {
    if (!dep || typeof dep !== 'object' || Object.keys(dep).sort().join(',') !== 'name,req') throw new Error('InvalidDependency');
    const { name, req } = dep as Record<string, unknown>;
    validateName(name);
    if (typeof req !== 'string') throw new Error('InvalidDependency');
    validateRequirement(req);
    deps.push({ name, req });
  }
  if (typeof record.cksum !== 'string' || !HASH.test(record.cksum) || typeof record.iface_cksum !== 'string' || !HASH.test(record.iface_cksum)) throw new Error('InvalidDigest');
  const snapshot = decodeBase64(record.snapshot_base64, 'snapshot');
  const iface = decodeBase64(record.interface_base64, 'interface');
  if (digestBytes(snapshot) !== record.cksum || digestBytes(iface) !== record.iface_cksum) throw new Error('ArchiveDigestMismatch');
  return {
    name: record.name, version: record.version, level: record.level as Level, prefixes: [...new Set(record.prefixes as string[])].sort(),
    toolchain: record.toolchain, deps, cksum: record.cksum, iface_cksum: record.iface_cksum, snapshot, interface: iface,
  };
}
function decodeBase64(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_PACKAGE_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`InvalidBase64: ${label}`);
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_PACKAGE_BYTES || bytes.toString('base64') !== value) throw new Error(`InvalidBase64: ${label}`);
  return bytes;
}

// ---- archives: deterministic gzip tar written by the client; read-only here

export function readArchive(bytes: Buffer, validatePath: (path: string) => void): Map<string, Buffer> {
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_PACKAGE_BYTES + MAX_PACKAGE_FILES * 1024 + 4096 });
  const entries = new Map<string, Buffer>();
  let offset = 0;
  let longName: string | null = null;
  let total = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156]!);
    let name = cstring(header.subarray(0, 100));
    const magic = cstring(header.subarray(257, 263));
    const prefix = magic === 'ustar' ? cstring(header.subarray(345, 500)) : '';
    if (prefix) name = prefix + '/' + name;
    const content = tar.subarray(offset + 512, offset + 512 + size);
    if (content.length !== size) throw new Error('ArchiveTruncated');
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = cstring(content); continue; }
    if (longName !== null) { name = longName; longName = null; }
    if (type === '5') continue;
    if (type !== '0' && type !== '\0') throw new Error('ArchiveEntryMustBeRegularFile');
    validatePath(name);
    total += size;
    if (total > MAX_PACKAGE_BYTES) throw new Error('ArchiveBudgetExceeded');
    if (entries.has(name)) throw new Error(`ArchiveDuplicateEntry: ${name}`);
    entries.set(name, Buffer.from(content));
    if (entries.size > MAX_PACKAGE_FILES + 1) throw new Error('ArchiveEntryCountExceeded');
  }
  return entries;
}
function cstring(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return Buffer.from(end < 0 ? bytes : bytes.subarray(0, end)).toString('utf8');
}
function octal(bytes: Uint8Array): number {
  if (bytes[0]! & 0x80) {
    let value = 0;
    for (let i = 1; i < bytes.length; i++) value = value * 256 + bytes[i]!;
    return value;
  }
  const text = cstring(bytes).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('ArchiveHeaderInvalid');
  return text ? parseInt(text, 8) : 0;
}
export function validatePackagePath(path: string): void {
  if (path === 'Slate.toml') return;
  if (!path || path.length > 512 || !/^[\x21-\x7e]+$/.test(path)) throw new Error(`InvalidPackagePath: ${path}`);
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part)) throw new Error(`InvalidPackagePath: ${path}`);
  }
  if (/\.(slateobj|slateproof|slatecache|receipt)$/i.test(path)) throw new Error(`CacheFileNotAPackageFile: ${path}`);
}
export function validateInterfacePath(path: string): void {
  if (path === 'interface') return;
  const match = /^objects\/([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\/([0-9a-f]{64})\.(slateobj|slatecache)$/.exec(path);
  if (!match) throw new Error(`InterfaceBundlePathInvalid: ${path}`);
}

// ---- Slate.PackageInterface

export interface InterfaceDeclaration { kind: string; visibility: string; canonical_target?: string; target_hash?: string }
export interface InterfaceModule {
  module_object_hash: string; theory_id: string; theory_hash: string; definition_environment_hash: string;
  declarations: Map<string, InterfaceDeclaration>;
}
export interface PackageInterface { package: string; origin: string; modules: Map<string, InterfaceModule> }

export function parseInterface(text: string): PackageInterface {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== `schema=${INTERFACE_SCHEMA}`) throw new Error('InterfaceSchemaMismatch');
  const result: PackageInterface = { package: '', origin: '', modules: new Map() };
  const modules: Array<[string, InterfaceModule]> = [];
  let pending: { index: number; name?: string; declaration: InterfaceDeclaration } | null = null;
  const flush = () => {
    if (!pending) return;
    if (pending.name === undefined) throw new Error('InterfaceDeclarationNameMissing');
    const module = modules[pending.index]![1];
    if (module.declarations.has(pending.name)) throw new Error(`InterfaceDuplicateDeclaration: ${pending.name}`);
    module.declarations.set(pending.name, pending.declaration);
    pending = null;
  };
  for (const line of lines.slice(1)) {
    const separator = line.indexOf('=');
    if (separator < 0) throw new Error(`InterfaceLineInvalid: ${line}`);
    const key = line.slice(0, separator), value = line.slice(separator + 1);
    if (key === 'package') { result.package = value; continue; }
    if (key === 'origin') { result.origin = value; continue; }
    if (key === 'module_count') continue;
    const match = /^module\.(\d+)\.(.+)$/.exec(key);
    if (!match) throw new Error(`InterfaceKeyInvalid: ${key}`);
    const index = Number(match[1]);
    const field = match[2]!;
    if (field === 'module_id') {
      flush();
      if (index !== modules.length) throw new Error('InterfaceModuleOrderInvalid');
      if (modules.some(([id]) => id === value)) throw new Error(`InterfaceDuplicateModule: ${value}`);
      modules.push([value, { module_object_hash: '', theory_id: '', theory_hash: '', definition_environment_hash: '', declarations: new Map() }]);
      continue;
    }
    if (index + 1 !== modules.length) throw new Error(`InterfaceModuleUnknown: ${key}`);
    const module = modules[index]![1];
    switch (field) {
      case 'module_object_hash': module.module_object_hash = value; continue;
      case 'theory_id': module.theory_id = value; continue;
      case 'theory_hash': module.theory_hash = value; continue;
      case 'definition_environment_hash': module.definition_environment_hash = value; continue;
      case 'declaration_count': continue;
    }
    const declaration = /^declaration\.\d+\.(.+)$/.exec(field);
    if (!declaration) throw new Error(`InterfaceKeyInvalid: ${key}`);
    const attribute = declaration[1]!;
    if (attribute === 'kind') { flush(); pending = { index, declaration: { kind: value, visibility: '' } }; continue; }
    if (!pending) throw new Error('InterfaceDeclarationKindMissing');
    if (attribute === 'name') pending.name = value;
    else if (attribute === 'visibility') pending.declaration.visibility = value;
    else if (attribute === 'canonical_target') pending.declaration.canonical_target = value;
    else if (attribute === 'target_hash') pending.declaration.target_hash = value;
    else throw new Error(`InterfaceKeyInvalid: ${key}`);
  }
  flush();
  if (!result.package) throw new Error('InterfacePackageMissing');
  for (const [id, module] of modules) result.modules.set(id, module);
  return result;
}

/** The change level from `previous` to `next`, exactly as the client computes it. */
export function compareInterfaces(previous: PackageInterface, next: PackageInterface): { level: Level; reasons: string[] } {
  let level: Level = 'patch';
  const reasons: string[] = [];
  const raise = (candidate: Level, reason: string) => {
    if (LEVELS.indexOf(candidate) > LEVELS.indexOf(level)) level = candidate;
    reasons.push(`${candidate}: ${reason}`);
  };
  for (const [moduleId, old] of previous.modules) {
    const current = next.modules.get(moduleId);
    if (!current) { raise('major', `module ${moduleId} removed`); continue; }
    if (old.definition_environment_hash !== current.definition_environment_hash) raise('major', `module ${moduleId} definitions changed`);
    for (const [name, oldDeclaration] of old.declarations) {
      if (oldDeclaration.visibility === 'private') continue;
      const newDeclaration = current.declarations.get(name);
      if (!newDeclaration) raise('major', `${moduleId}.${name} removed`);
      else if (newDeclaration.visibility === 'private') raise('major', `${moduleId}.${name} made private`);
      else if (newDeclaration.kind !== oldDeclaration.kind) raise('major', `${moduleId}.${name} kind changed`);
      else if (newDeclaration.target_hash !== oldDeclaration.target_hash) raise('major', `${moduleId}.${name} statement changed`);
    }
    for (const [name, declaration] of current.declarations) {
      if (!old.declarations.has(name) && declaration.visibility !== 'private') raise('minor', `${moduleId}.${name} added`);
    }
  }
  for (const moduleId of next.modules.keys()) {
    if (!previous.modules.has(moduleId)) raise('minor', `module ${moduleId} added`);
  }
  return { level, reasons };
}

// ---- sparse index

export interface IndexEntry {
  name: string; vers: string; deps: Array<{ name: string; req: string }>; cksum: string;
  iface_cksum: string; yanked: boolean; prefixes: string[]; toolchain: string;
}
/** cargo's layout: `1/a`, `2/ab`, `3/a/abc`, `ab/cd/abcdef`. */
export function indexPath(name: string): string {
  validateName(name);
  if (name.length === 1) return `1/${name}`;
  if (name.length === 2) return `2/${name}`;
  if (name.length === 3) return `3/${name[0]}/${name}`;
  return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
}
export function renderIndexLine(entry: IndexEntry): string {
  // Field order matches the client's serialization.
  return JSON.stringify({ name: entry.name, vers: entry.vers, deps: entry.deps, cksum: entry.cksum,
    iface_cksum: entry.iface_cksum, yanked: entry.yanked, prefixes: entry.prefixes, toolchain: entry.toolchain });
}
export function downloadKey(name: string, version: string, suffix: 'slatepkg' | 'interface'): string {
  return `packages/${name}/${version}/${name}-${version}.${suffix}`;
}
