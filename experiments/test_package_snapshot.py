"""Local transfer/infrastructure regressions; these tests grant no proof status."""

from copy import deepcopy
import os
from pathlib import Path
import shutil
import signal
import subprocess
from tempfile import TemporaryDirectory
import unittest

from package_reuse import REPORT_SCHEMA, validate_report, wait_process
from package_snapshot import (
    capture, materialize, sha256, snapshot_digest, verify_materialized,
)


class SourceTransferTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory(prefix="pebble-source-transfer-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        self.store = self.root / "blobs"
        (self.source / "src").mkdir(parents=True)
        # Content identity tests treat these as bytes, without invoking Slate.
        self.content = b"module original\n"
        (self.source / "src" / "main.slate").write_bytes(self.content)

    def test_relocation_preserves_identity_and_mutations_invalidate_snapshot(self):
        snapshot = capture(self.source, self.store)
        relocated = self.root / "relocated-source"
        shutil.copytree(self.source, relocated)
        self.assertEqual(capture(relocated, self.store), snapshot)

        client = self.root / "client"
        materialize(snapshot, self.store, client)
        verify_materialized(snapshot, client)
        self.assertEqual((client / "src" / "main.slate").read_bytes(), self.content)

        for mutation in ("modify", "add-hidden-file", "delete"):
            with self.subTest(mutation=mutation):
                changed_client = self.root / mutation
                materialize(snapshot, self.store, changed_client)
                if mutation == "modify":
                    replacement = b"module modified\n"
                    self.assertEqual(len(replacement), len(self.content))
                    (changed_client / "src" / "main.slate").write_bytes(replacement)
                elif mutation == "add-hidden-file":
                    (changed_client / ".hidden").mkdir()
                    (changed_client / ".hidden" / "extra.slate").write_bytes(b"extra source\n")
                else:
                    (changed_client / "src" / "main.slate").unlink()
                with self.assertRaises(ValueError):
                    verify_materialized(snapshot, changed_client)

    def test_unsafe_paths_collisions_cache_inputs_and_links_are_rejected(self):
        for paths in (("../outside",), ("A/x", "a/y"), ("x", "x/y"),
                      (".slatecache/author.receipt",), ("object.slateobj/source.slate",)):
            with self.subTest(paths=paths):
                files = [{"path": path, "byte_length": len(self.content),
                          "sha256": sha256(self.content)} for path in sorted(paths)]
                with self.assertRaises(ValueError):
                    snapshot_digest(files)

        cache_root = self.root / "source-with-cache"
        (cache_root / ".slatecache").mkdir(parents=True)
        (cache_root / ".slatecache" / "author.receipt").write_bytes(b"untrusted cache metadata")
        with self.assertRaises(ValueError):
            capture(cache_root, self.store)

        target = self.root / "external-source.slate"
        target.write_bytes(self.content)
        for link_kind in ("symbolic", "hard"):
            with self.subTest(link_kind=link_kind):
                link_root = self.root / link_kind
                link_root.mkdir()
                link = link_root / "linked.slate"
                if link_kind == "symbolic":
                    link.symlink_to(target)
                else:
                    os.link(target, link)
                with self.assertRaises(ValueError):
                    capture(link_root, self.store)

    def test_corrupt_blob_cannot_be_reused_or_create_a_client(self):
        snapshot = capture(self.source, self.store)
        blob = self.store / snapshot["files"][0]["sha256"]
        blob.write_bytes(b"module modified\n")
        with self.assertRaises(ValueError):
            capture(self.source, self.store)

        destination = self.root / "client"
        with self.assertRaises(ValueError):
            materialize(snapshot, self.store, destination)
        self.assertFalse(destination.exists())

    def test_descriptor_and_source_store_destination_boundaries(self):
        snapshot = capture(self.source, self.store)
        for mutation in ("schema", "files"):
            with self.subTest(mutation=mutation):
                changed = deepcopy(snapshot)
                if mutation == "schema":
                    changed["schema"] = "unsupported-source-transfer-schema"
                else:
                    changed["files"][0]["path"] = "src/renamed.slate"
                destination = self.root / mutation
                with self.assertRaises(ValueError):
                    materialize(changed, self.store, destination)
                self.assertFalse(destination.exists())
                with self.assertRaises(ValueError):
                    verify_materialized(changed, self.source)

        nested_store = self.source / "blobs"
        with self.assertRaises(ValueError):
            capture(self.source, nested_store)
        self.assertFalse(nested_store.exists())

        destination = self.root / "existing-client"
        destination.mkdir()
        sentinel = destination / "keep.txt"
        sentinel.write_bytes(b"existing client content")
        with self.assertRaises(FileExistsError):
            materialize(snapshot, self.store, destination)
        self.assertEqual(list(destination.iterdir()), [sentinel])
        self.assertEqual(sentinel.read_bytes(), b"existing client content")


class CheckerBoundaryTests(unittest.TestCase):
    def test_timeout_kills_real_process_and_remains_a_timeout(self):
        process = subprocess.Popen(
            ["/usr/bin/sleep", "30"], start_new_session=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            returncode, timed_out = wait_process(process, timeout=0.02)
            self.assertIs(timed_out, True)
            self.assertEqual(returncode, -signal.SIGKILL)
            self.assertEqual(process.poll(), -signal.SIGKILL)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=2)

    def test_missing_fields_and_old_report_schema_are_not_accepted(self):
        # Deliberately non-accepting metadata; no theorem or success is mocked.
        incomplete = {
            "schema": REPORT_SCHEMA, "source_inventory_complete": False,
            "complete": False, "release_eligible": False,
            "report_scope": "source_only", "publication_status": "not_published",
            "checker_frontend_hash": "non-accepting-test-metadata",
            "toolchain_release": "non-accepting-test-metadata",
            "toolchain_commit": "non-accepting-test-metadata", "files": [],
        }
        for field in incomplete:
            with self.subTest(missing_field=field):
                report = {key: value for key, value in incomplete.items() if key != field}
                with self.assertRaises(ValueError):
                    validate_report(report, [])
        old = {**incomplete, "schema": "Slate.PackageCheckReport.v0"}
        with self.assertRaises(ValueError):
            validate_report(old, [])
        with self.assertRaisesRegex(ValueError, "cannot grant release eligibility"):
            validate_report({**incomplete, "release_eligible": True}, [])


if __name__ == "__main__":
    unittest.main()
