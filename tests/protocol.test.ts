import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_POLICY, digestBytes, validateBundle, type Bundle } from '../src/protocol.js';
import { reportMatchesInput } from '../src/worker.js';

test('a shared content digest cannot have contradictory declared lengths', () => {
  const bytes = Buffer.from('formal source bytes');
  const sha256 = digestBytes(bytes);
  const bundle: Bundle = {
    snapshot: { schema: 'Pebble.PackageSnapshot.v1', package_id: randomUUID(), version: '0.1.0',
      toolchain_digest: 'a'.repeat(64), dependencies: [],
      files: [{ path: 'a.slate', sha256, byte_length: bytes.length - 1 }, { path: 'b.slate', sha256, byte_length: bytes.length }],
      research: { title: 'Protocol fixture', summary: 'No mathematical acceptance is claimed.', license: 'CC0-1.0',
        authors: ['Fixture'], formalizers: ['Fixture'], maintainers: ['Fixture'], kind: 'formalization',
        claims: 'Protocol validation only', assumptions: 'None evaluated', citations: [], usage: 'Input rejection test' } },
    blobs: [{ sha256, content_base64: bytes.toString('base64') }],
  };
  assert.throws(() => validateBundle(bundle), /InconsistentBlobLength/);
  bundle.snapshot.files[0]!.byte_length = bytes.length;
  assert.deepEqual(validateBundle(bundle), bundle);
  bundle.snapshot.files[0]!.path = 'A/a.slate';
  bundle.snapshot.files[1]!.path = 'a/b.slate';
  assert.throws(() => validateBundle(bundle), /PathCollision/);
});

test('declared success cannot disguise source files as attachments or omit object identity', () => {
  // Adversarial synthetic input is tested only for rejection, never registered
  // as a successful mathematical result.
  const entry = { path: 'source.slate', sha256: 'b'.repeat(64), byte_length: 8 };
  const report = { schema: 'Slate.PackageCheckReport.v1', report_scope: 'source_only', publication_status: 'not_published',
    release_eligible: false, source_inventory_complete: true, source_check_policy: 'Slate.SourcePackagePolicy.v1',
    formal_checks_eligible: true, complete: true, diagnostics: [],
    files: [{ ...entry, kind: 'attachment', status: 'not_applicable', declarations: [], module_id: 'Example' }] };
  assert.equal(reportMatchesInput(report, [entry], DEFAULT_POLICY), false);
  report.files[0]!.kind = 'unknown'; report.files[0]!.status = 'passed';
  assert.equal(reportMatchesInput(report, [entry], DEFAULT_POLICY), false);
  report.files[0]!.kind = 'module';
  assert.equal(reportMatchesInput(report, [entry], DEFAULT_POLICY), false);
});
