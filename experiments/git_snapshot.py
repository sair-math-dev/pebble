"""Bounded Git experiment, not a Pebble implementation or a security test.

Run: python3 experiments/git_snapshot.py
Uses only a temporary bare repository; never accesses a remote.
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    with tempfile.TemporaryDirectory(prefix="pebble-git-snapshot-") as directory:
        root = Path(directory)
        environment = {
            **os.environ,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_AUTHOR_NAME": "Pebble experiment",
            "GIT_AUTHOR_EMAIL": "experiment@example.invalid",
            "GIT_COMMITTER_NAME": "Pebble experiment",
            "GIT_COMMITTER_EMAIL": "experiment@example.invalid",
        }
        # Avoid inheriting a caller's repository/index selection.
        for name in (
            "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
            "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_NAMESPACE",
        ):
            environment.pop(name, None)

        def git(*arguments, data=None, check=True):
            return subprocess.run(
                ["git", *arguments], cwd=root, env=environment,
                input=data, text=True, capture_output=True, check=check,
            )

        git("init", "--bare", "--initial-branch=main")

        def commit(text, parent=None):
            blob = git("hash-object", "-w", "--stdin", data=text).stdout.strip()
            tree = git("mktree", data=f"100644 blob {blob}\tpaper.md\n").stdout.strip()
            args = ["commit-tree", tree]
            if parent:
                args.extend(["-p", parent])
            return git(*args, data="Research checkpoint\n").stdout.strip()

        base = commit("Original statement\n")
        alice = commit("Alice's revision\n", base)
        bob = commit("Bob's concurrent revision\n", base)
        git("update-ref", "refs/heads/main", base)
        git("update-ref", "refs/heads/main", alice, base)
        stale = git("update-ref", "refs/heads/main", bob, base, check=False)
        if stale.returncode == 0 or git("rev-parse", "main").stdout.strip() != alice:
            raise RuntimeError("stale update replaced the current revision")

        git("update-ref", "refs/pebble/candidates/example", alice)
        git("update-ref", "refs/heads/main", bob, alice)
        if git("show", "refs/pebble/candidates/example:paper.md").stdout != "Alice's revision\n":
            raise RuntimeError("moving branch changed the pinned candidate")

        before = git("rev-parse", "main").stdout.strip()
        transaction = git(
            "update-ref", "--stdin", check=False,
            data=("start\n"
                  f"update refs/heads/main {alice} {base}\n"
                  f"create refs/pebble/candidates/failed {bob}\n"
                  "prepare\ncommit\n"),
        )
        failed_ref = git("show-ref", "--verify", "refs/pebble/candidates/failed", check=False)
        if transaction.returncode == 0 or failed_ref.returncode == 0:
            raise RuntimeError("failed ref transaction partially committed")
        if git("rev-parse", "main").stdout.strip() != before:
            raise RuntimeError("failed transaction changed main")

        print(json.dumps({
            "git": git("--version").stdout.strip(),
            "stale_checkpoint_rejected": True,
            "candidate_survives_branch_move": True,
            "failed_multi_ref_transaction_is_atomic": True,
            "scope": "local Git refs only; no database, HTTP, ACL, CRDT or verifier tested",
        }, indent=2))


if __name__ == "__main__":
    main()
