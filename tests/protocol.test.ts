import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareInterfaces, indexPath, levelOfVersions, parseInterface, parseManifest, parseToml, parseVersion, prefixConflict,
  renderIndexLine, validatePublishRequest, validateRequirement, digestBytes,
} from '../src/protocol.js';
import { modulesOutsidePrefixes } from '../src/worker.js';

const MANIFEST = `[package]
name = "set-quotient"
version = "1.2.0"
namespace_prefixes = ["Set.Quotient", "Set.Equivalence"]
toolchain = "local"
license = "Apache-2.0"

[registry]
index = "https://index.verifiable.ai/"

[research]                       # every field required
title = "Quotients"
summary = "What this package establishes"
authors = ["A", "B"]
formalizers = [
  "F",
]
maintainers = ["M"]
kind = "formalization"
claims = "Precise claims \\"quoted\\""
assumptions = "Declared theory and assumptions"
citations = []
usage = 'literal string'

[dependencies]
set-core = "^1.2"
helpers = { version = "^0.3" }
`;

test('the manifest subset parses as the client writes it and rejects what cannot be published', () => {
  const manifest = parseManifest(MANIFEST);
  assert.equal(manifest.name, 'set-quotient');
  assert.deepEqual(manifest.namespace_prefixes, ['Set.Equivalence', 'Set.Quotient']);
  assert.deepEqual(manifest.dependencies, [{ name: 'helpers', req: '^0.3' }, { name: 'set-core', req: '^1.2' }]);
  assert.equal(manifest.research.claims, 'Precise claims "quoted"');
  assert.deepEqual(manifest.research.formalizers, ['F']);
  assert.throws(() => parseManifest(MANIFEST.replace('set-core = "^1.2"', 'scratch = { path = "../scratch" }')), /PathDependencyCannotBePublished/);
  assert.throws(() => parseManifest(MANIFEST.replace('title = "Quotients"\n', '')), /ManifestSectionFields: research/);
  assert.throws(() => parseManifest(MANIFEST.replace('set-core = "^1.2"', 'set-core = "*"')), /WildcardRequirementForbidden/);
  assert.throws(() => parseManifest(MANIFEST.replace('[registry]', '[workspace]\nmembers = ["a"]\n[registry]')), /ManifestTableForbidden: workspace/);
  assert.throws(() => parseManifest(MANIFEST.replace('1.2.0', '1.2.0-rc.1')), /PrereleasePublicationUnsupported/);
  assert.deepEqual(parseToml('[a]\nx = [1, true, "s"]\n').a, { x: [1, true, 's'] });
  validateRequirement('>=1.2, <2.0');
  assert.throws(() => validateRequirement('one'), /InvalidRequirement/);
});

test('versions, levels and index paths follow cargo', () => {
  assert.equal(levelOfVersions(parseVersion('1.2.3'), parseVersion('1.3.0')), 'minor');
  assert.equal(levelOfVersions(parseVersion('1.2.3'), parseVersion('2.0.0')), 'major');
  assert.throws(() => levelOfVersions(parseVersion('1.2.3'), parseVersion('1.2.3')), /VersionMustIncrease/);
  assert.equal(indexPath('a'), '1/a');
  assert.equal(indexPath('ab'), '2/ab');
  assert.equal(indexPath('abc'), '3/a/abc');
  assert.equal(indexPath('set-quotient'), 'se/t-/set-quotient');
  const line = renderIndexLine({ name: 'x', vers: '1.0.0', deps: [{ name: 'y', req: '^1' }], cksum: 'a'.repeat(64), iface_cksum: 'b'.repeat(64), yanked: false, prefixes: ['X'], toolchain: 'local' });
  assert.equal(line, `{"name":"x","vers":"1.0.0","deps":[{"name":"y","req":"^1"}],"cksum":"${'a'.repeat(64)}","iface_cksum":"${'b'.repeat(64)}","yanked":false,"prefixes":["X"],"toolchain":"local"}`);
});

test('namespace prefixes are owned exclusively, sub-prefixes only by yield', () => {
  const owned = [{ prefix: 'Set', package_id: 'p1' }, { prefix: 'Set.Quotient', package_id: 'p2' }];
  assert.equal(prefixConflict('Set', 'p1', owned), null);
  assert.equal(prefixConflict('Set.Quotient', 'p2', owned), null);
  assert.match(prefixConflict('Set.Other', 'p3', owned)!, /PrefixOverlap: Set.Other with Set/);
  assert.match(prefixConflict('Set', 'p3', owned)!, /PrefixOwnedByAnotherPackage/);
  assert.match(prefixConflict('S', 'p3', [{ prefix: 'S.Deep.Er', package_id: 'p9' }])!, /PrefixOverlap/);
  assert.equal(prefixConflict('Sets', 'p3', owned), null);
});

function iface(theorem: string, hash: string, extra = ''): string {
  return `schema=Slate.PackageInterface\npackage=base\norigin=path:.@1.0.0\nmodule_count=1\nmodule.0.module_id=Base.Core\nmodule.0.module_object_hash=${'0'.repeat(64)}\nmodule.0.theory_id=T\nmodule.0.theory_hash=${'0'.repeat(64)}\nmodule.0.definition_environment_hash=${'1'.repeat(64)}\nmodule.0.declaration_count=1\nmodule.0.declaration.0.kind=theorem\nmodule.0.declaration.0.name=${theorem}\nmodule.0.declaration.0.visibility=public\nmodule.0.declaration.0.canonical_target=forall(Object,eq(bound(0),bound(0)))\nmodule.0.declaration.0.target_hash=${hash}\n${extra}`;
}

test('interface comparison computes the client\'s change level', () => {
  const previous = parseInterface(iface('Base.Core.Core', 'a'.repeat(64)));
  assert.equal(compareInterfaces(previous, parseInterface(iface('Base.Core.Core', 'a'.repeat(64)))).level, 'patch');
  const restated = compareInterfaces(previous, parseInterface(iface('Base.Core.Core', 'b'.repeat(64))));
  assert.equal(restated.level, 'major');
  assert.deepEqual(restated.reasons, ['major: Base.Core.Base.Core.Core statement changed']);
  assert.equal(compareInterfaces(previous, parseInterface(iface('Base.Core.Renamed', 'a'.repeat(64)))).level, 'major');
  const extended = parseInterface(iface('Base.Core.Core', 'a'.repeat(64)).replace('declaration_count=1', 'declaration_count=2')
    + `module.0.declaration.1.kind=theorem\nmodule.0.declaration.1.name=Base.Core.Extra\nmodule.0.declaration.1.visibility=public\nmodule.0.declaration.1.target_hash=${'c'.repeat(64)}\n`);
  assert.equal(compareInterfaces(previous, extended).level, 'minor');
  assert.throws(() => parseInterface('schema=Other\n'), /InterfaceSchemaMismatch/);
});

test('publish requests bind both archives to their digests and modules to declared prefixes', () => {
  const snapshot = Buffer.from('not really a tar');
  const body = { name: 'x', version: '1.0.0', level: 'patch', prefixes: ['X'], toolchain: 'local', deps: [], cksum: digestBytes(snapshot), iface_cksum: 'b'.repeat(64),
    snapshot_base64: snapshot.toString('base64'), interface_base64: snapshot.toString('base64') };
  assert.throws(() => validatePublishRequest(body), /ArchiveDigestMismatch/);
  body.iface_cksum = digestBytes(snapshot);
  assert.equal(validatePublishRequest(body).name, 'x');
  assert.throws(() => validatePublishRequest({ ...body, level: 'huge' }), /InvalidLevel/);
  const report = { packages: [{ name: 'x', files: [{ kind: 'module', module_id: 'X.Core' }, { kind: 'theory', module_id: 'Y.T' }, { kind: 'attachment' }] }] };
  assert.deepEqual(modulesOutsidePrefixes(report, 'x', ['X']), ['Y.T']);
  assert.deepEqual(modulesOutsidePrefixes(report, 'x', ['X', 'Y']), []);
});
