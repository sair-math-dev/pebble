"""Run real Slate checks after source snapshots are transferred to fresh clients.

This bounded local experiment does not implement a registry, resolver, production
worker sandbox, or release gate. JSON comes directly from the Slate checker.
"""

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys

from package_snapshot import (
    canonical, capture, materialize, sha256, verify_materialized,
)


REPORT_SCHEMA = "Slate.PackageCheckReport.v1"
FIXTURES = Path(__file__).parent / "fixtures" / "package-reuse"
MAX_REPORT_BYTES = 32 * 1024 * 1024


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def unique_json_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate report key: {key}")
        result[key] = value
    return result


def expected_files(snapshots):
    return sorted(({
        **entry, "path": f"{name}/{entry['path']}",
    } for name, snapshot in snapshots.items() for entry in snapshot["files"]),
        key=lambda entry: entry["path"])


def validate_report(report, expected):
    if not isinstance(report, dict) or report.get("schema") != REPORT_SCHEMA:
        raise ValueError("Slate package report schema is missing or unsupported")
    for name in ("source_inventory_complete", "complete", "release_eligible"):
        if type(report.get(name)) is not bool:
            raise ValueError(f"Slate report lacks an explicit {name} boolean")
    if report["release_eligible"] is not False:
        raise ValueError("source-only report cannot grant release eligibility")
    if report.get("report_scope") != "source_only" or report.get("publication_status") != "not_published":
        raise ValueError("Slate report does not declare the source-only experiment scope")
    for name in ("checker_frontend_hash", "toolchain_release", "toolchain_commit"):
        if not isinstance(report.get(name), str) or not report[name]:
            raise ValueError(f"Slate report lacks {name}")
    files = report.get("files")
    if not isinstance(files, list):
        raise ValueError("Slate report lacks file inventory")
    observed = [{key: entry[key] for key in ("path", "sha256", "byte_length")}
                for entry in files]
    if sorted(observed, key=lambda entry: entry["path"]) != expected:
        raise ValueError("Slate report does not cover the exact fixed source files")
    if report["complete"]:
        if not report["source_inventory_complete"]:
            raise ValueError("complete report has incomplete source inventory")
        for entry in files:
            file_checked = entry.get("status") == "passed"
            attachment = entry.get("kind") == "attachment" and entry.get("status") == "not_applicable"
            if not (file_checked or attachment) or not isinstance(entry.get("declarations"), list):
                raise ValueError("complete report contains unchecked files")
            for declaration in entry["declarations"]:
                if declaration.get("kind") == "theorem":
                    checked = declaration.get("checked")
                    if declaration.get("status") != "passed" or not isinstance(checked, dict):
                        raise ValueError("complete report contains an unchecked theorem")
                    for key in ("fact_id", "theory_id", "theory_hash", "canonical_target",
                                "target_hash", "certificate_hash", "dependency_closure_hash",
                                "assumption_closure_hash", "source_hash", "publication_profile",
                                "source_proof_kind"):
                        if not isinstance(checked.get(key), str) or not checked[key]:
                            raise ValueError(f"checked theorem lacks {key}")


def wait_process(process, timeout):
    try:
        return process.wait(timeout=timeout), False
    except subprocess.TimeoutExpired:
        # Kill the entire invocation, including any descendants. A timeout is
        # unresolved; it is never converted into a rejected mathematical claim.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        return process.returncode, True


def run_check(slatec, binary_digest, workspace, snapshots, output, timeout):
    output.mkdir(parents=True, exist_ok=False)
    files = expected_files(snapshots)
    inputs = {"schema": "Pebble.CheckInvocationExperiment.v1",
              "slatec_sha256": binary_digest, "mode": "source_rebuild",
              "files": files, "report_schema": REPORT_SCHEMA}
    record = {"input_digest": sha256(canonical(inputs)), "inputs": inputs,
              "command": [str(slatec), "check-package", str(workspace)],
              "published": False, "outcome": "error"}
    write_json(output / "input.json", record)
    try:
        if sha256(slatec.read_bytes()) != binary_digest:
            raise ValueError("Slate executable changed during the experiment")
        for name, snapshot in snapshots.items():
            verify_materialized(snapshot, workspace / name)
        scratch = output / "scratch"
        scratch.mkdir()
        with (output / "report.json").open("wb") as stdout, (output / "stderr.txt").open("wb") as stderr:
            process = subprocess.Popen(
                record["command"], cwd=output,
                env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "TMPDIR": str(scratch)},
                stdout=stdout, stderr=stderr, start_new_session=True,
            )
            record["exit_code"], timed_out = wait_process(process, timeout)
        if timed_out:
            record["outcome"] = "timeout"
        else:
            if record["exit_code"] not in (0, 1):
                raise ValueError("Slate process failed without a normal check outcome")
            if sha256(slatec.read_bytes()) != binary_digest:
                raise ValueError("Slate executable changed during checking")
            for name, snapshot in snapshots.items():
                verify_materialized(snapshot, workspace / name)
            report_path = output / "report.json"
            if report_path.stat().st_size > MAX_REPORT_BYTES:
                raise ValueError("Slate report exceeds experiment byte budget")
            raw = report_path.read_bytes()
            report = json.loads(raw, object_pairs_hook=unique_json_pairs)
            validate_report(report, files)
            if (record["exit_code"] == 0) != report["complete"]:
                raise ValueError("Slate exit status disagrees with coverage report")
            record.update(outcome="checked" if report["complete"] else "incomplete",
                          report_sha256=sha256(raw), report=report)
    except (OSError, ValueError, KeyError, TypeError) as error:
        record["diagnostic"] = str(error)
    write_json(output / "invocation.json", record)
    return record


def checked_theorems(record):
    return {declaration["checked"]["fact_id"]: declaration["checked"]
            for entry in record["report"]["files"]
            for declaration in entry["declarations"]
            if declaration.get("kind") == "theorem" and declaration.get("checked")}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def experiment(slatec, output, timeout):
    output.mkdir(parents=True, exist_ok=False)
    binary_digest = sha256(slatec.read_bytes())
    store = output / "blobs"
    snapshots = {name: capture(FIXTURES / name, store) for name in (
        "algebra-provider", "algebra-consumer", "set-membership")}
    write_json(output / "snapshots.json", snapshots)
    runs = {}

    def check(name, selected):
        workspace = output / "clients" / name
        for package, snapshot in selected.items():
            materialize(snapshot, store, workspace / package)
        run = run_check(slatec, binary_digest, workspace, selected,
                        output / "checks" / name, timeout)
        runs[name] = {key: value for key, value in run.items() if key not in ("report", "inputs")}
        return run

    provider = {"algebra-provider": snapshots["algebra-provider"]}
    algebra = {**provider, "algebra-consumer": snapshots["algebra-consumer"]}
    provider_check = check("provider", provider)
    require(provider_check["outcome"] == "checked", "provider source checks did not complete")
    client = check("consumer", algebra)
    require(client["outcome"] == "checked", "consumer source checks did not complete")
    relocated = check("relocated", algebra)
    require(relocated["outcome"] == "checked", "relocated source checks did not complete")
    require(client["input_digest"] == relocated["input_digest"], "relocation changed fixed inputs")
    require(checked_theorems(client) == checked_theorems(relocated), "relocation changed theorem bindings")
    require(all(checked_theorems(client).get(key) == value
                for key, value in checked_theorems(provider_check).items()),
            "consumer changed its provider's checked result bindings")
    require(len(checked_theorems(client)) > len(checked_theorems(provider_check)),
            "consumer did not contribute a checked theorem")
    consumer_results = {key: value for key, value in checked_theorems(client).items()
                        if key not in checked_theorems(provider_check)}
    require(any(value.get("direct_dependencies") for value in consumer_results.values()),
            "consumer's new result has no actual checked import dependency")
    sets = check("set-membership", {"set-membership": snapshots["set-membership"]})
    require(sets["outcome"] == "checked", "independent set-membership checks did not complete")

    # This file is not imported by the consumer. It must still enter coverage.
    bad_root = output / "mutations" / "hidden-bad-file"
    materialize(snapshots["algebra-consumer"], store, bad_root)
    (bad_root / ".hidden").mkdir()
    (bad_root / ".hidden" / "bad.slate").write_text(
        "module Pebble.Fixtures.Unchecked\n"
        "    under Pebble.Fixtures.Algebra.Group\n"
        "    theorem FalseClaim(a : Element): a = one\n"
        "        a = one from missing_proof\n")
    bad = check("hidden-bad-file", {**provider, "algebra-consumer": capture(bad_root, store)})
    require(bad["outcome"] == "incomplete" and not bad["report"]["release_eligible"],
            "unimported bad source did not prevent complete checks")
    require(any(entry["path"] == "algebra-consumer/.hidden/bad.slate"
                and entry["status"] == "failed" for entry in bad["report"]["files"]),
            "hidden bad source was not specifically reported as failed")

    # An environment change requires a different invocation identity, even if
    # its effect is irrelevant to a particular target's formula.
    changed_root = output / "mutations" / "changed-provider"
    materialize(snapshots["algebra-provider"], store, changed_root)
    theory = changed_root / "theory" / "group.slate"
    theory.write_text(theory.read_text().replace(
        "    sort Element", "    sort Element\n    constant extra : Element"))
    changed = capture(changed_root, store)
    require(changed["digest"] != snapshots["algebra-provider"]["digest"],
            "dependency mutation did not change snapshot")
    changed_check = check("changed-dependency", {**algebra, "algebra-provider": changed})
    require(changed_check["input_digest"] != client["input_digest"],
            "dependency replacement reused the old invocation identity")
    require(changed_check["outcome"] in ("checked", "incomplete"),
            "dependency replacement did not receive a real checker result")
    if changed_check["outcome"] == "checked":
        require(checked_theorems(changed_check) != checked_theorems(client),
                "changed environment reused old evidence bindings")

    poisoned_root = output / "mutations" / "foreign-cache"
    materialize(snapshots["algebra-provider"], store, poisoned_root)
    (poisoned_root / "author.slatecache").write_bytes(b"untrusted author cache")
    try:
        capture(poisoned_root, store)
    except ValueError:
        cache_rejected = True
    else:
        cache_rejected = False
    require(cache_rejected, "downloaded checker cache was admitted as source")

    summary = {"schema": "Pebble.PackageReuseExperiment.v1", "published": False,
               "slatec_sha256": binary_digest, "runs": runs,
               "checked_theorems": len(checked_theorems(client)) + len(checked_theorems(sets)),
               "relocation_preserves_inputs_and_evidence": True,
               "hidden_bad_file_blocks_complete_checks": True,
               "dependency_change_has_new_input_binding": True,
               "foreign_cache_rejected_before_transfer": cache_rejected,
               "limitations": ["local source-transfer experiment; no registry or resolver",
                               "no production isolation or formal Pebble release",
                               "no complete global theorem DAG or exported certificate bodies"]}
    write_json(output / "summary.json", summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slatec", type=Path, required=True,
                        help="built Slate executable with check-package support")
    parser.add_argument("--output", type=Path, help="new artifact directory; must not exist")
    parser.add_argument("--timeout", type=float, default=30, help="seconds per checker process")
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be finite and positive")
    output = (args.output or Path(".artifacts") / ("package-reuse-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))).resolve()
    try:
        summary = experiment(args.slatec.resolve(strict=True), output, args.timeout)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"experiment did not complete: {error}\nartifacts: {output}", file=sys.stderr)
        return 1
    print(json.dumps({"checked_theorems": summary["checked_theorems"],
                      "published": False, "summary": str(output / "summary.json")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
