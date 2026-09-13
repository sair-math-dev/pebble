"""Local source-transfer experiment; this is not Slate's manifest or lock format.

The deliberately small format accepts portable ASCII paths and regular source
files. It never installs compiler objects or trusted caches. All identities are
derived from bytes; physical source/download paths are not part of an identity.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import stat


SCHEMA = "Pebble.SourceTransferExperiment.v1"
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
MAX_FILES = 4096


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    # This experimental format only admits ASCII keys/paths and integer sizes.
    # It does not claim to implement the proposed general JCS package format.
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("ascii")


def valid_path(value):
    if not isinstance(value, str) or not value or not value.isascii():
        raise ValueError("source path must be nonempty portable ASCII")
    parts = value.split("/")
    if any(part in ("", ".", "..") or not re.fullmatch(r"[A-Za-z0-9_.-]+", part)
           for part in parts):
        raise ValueError(f"noncanonical source path: {value!r}")
    if any(part.lower().endswith((".slateobj", ".slatecache")) for part in parts):
        raise ValueError(f"compiler objects and caches are not source inputs: {value}")
    return value


def validate_files(files):
    if not isinstance(files, list) or not files or len(files) > MAX_FILES:
        raise ValueError("invalid source file count")
    paths = []
    names = {}
    total = 0
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "byte_length", "sha256"}:
            raise ValueError("invalid source file entry")
        path = valid_path(entry["path"])
        length = entry["byte_length"]
        digest = entry["sha256"]
        if type(length) is not int or not 0 <= length <= MAX_FILE_BYTES:
            raise ValueError("invalid source file length")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("invalid source file digest")
        total += length
        if total > MAX_TOTAL_BYTES:
            raise ValueError("source snapshot exceeds byte budget")
        parts = path.split("/")
        for index in range(1, len(parts) + 1):
            name = "/".join(parts[:index])
            kind = "file" if index == len(parts) else "directory"
            previous = names.setdefault(name.casefold(), (name, kind))
            if previous != (name, kind):
                raise ValueError(f"colliding source paths: {name}")
        paths.append(path)
    if paths != sorted(set(paths)):
        raise ValueError("source files must have unique sorted paths")


def snapshot_digest(files):
    validate_files(files)
    return sha256(SCHEMA.encode("ascii") + b"\0" + canonical({"files": files}))


def read_regular(path, limit):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ValueError(f"expected regular file without hard links: {path}")
        if metadata.st_size > limit:
            raise ValueError(f"file exceeds byte budget: {path}")
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError(f"file exceeds byte budget: {path}")
        return data


def source_files(root):
    root = Path(root)
    if not stat.S_ISDIR(root.lstat().st_mode):
        raise ValueError("source root must be a real directory")
    found = []
    pending = [root]
    while pending:
        directory = pending.pop()
        for path in sorted(directory.iterdir()):
            mode = path.lstat().st_mode
            valid_path(path.relative_to(root).as_posix())
            if stat.S_ISDIR(mode):
                pending.append(path)
            elif stat.S_ISREG(mode):
                found.append(path)
                if len(found) > MAX_FILES:
                    raise ValueError("source snapshot exceeds file budget")
            else:
                raise ValueError(f"unsupported source entry: {path}")
    return sorted(found)


def capture(root, store):
    root, store = Path(root), Path(store)
    if store.resolve().is_relative_to(root.resolve()):
        raise ValueError("blob store must be outside source root")
    store.mkdir(parents=True, exist_ok=True)
    files = []
    total = 0
    for path in source_files(root):
        data = read_regular(path, MAX_FILE_BYTES)
        total += len(data)
        if total > MAX_TOTAL_BYTES:
            raise ValueError("source snapshot exceeds byte budget")
        digest = sha256(data)
        blob = store / digest
        try:
            with blob.open("xb") as stream:
                stream.write(data)
        except FileExistsError:
            if read_regular(blob, MAX_FILE_BYTES) != data:
                raise ValueError(f"corrupt existing blob: {digest}")
        files.append({"path": path.relative_to(root).as_posix(),
                      "byte_length": len(data), "sha256": digest})
    return {"schema": SCHEMA, "files": files, "digest": snapshot_digest(files)}


def validate_snapshot(snapshot):
    if not isinstance(snapshot, dict) or set(snapshot) != {"schema", "files", "digest"} or snapshot["schema"] != SCHEMA:
        raise ValueError("unknown source-transfer snapshot format")
    if snapshot_digest(snapshot["files"]) != snapshot["digest"]:
        raise ValueError("snapshot descriptor does not match its pinned digest")


def materialize(snapshot, store, destination):
    validate_snapshot(snapshot)
    destination = Path(destination)
    # Verify all content before creating a client directory. This is local
    # experiment storage; no public upload/untrusted concurrent store is served.
    contents = []
    for entry in snapshot["files"]:
        data = read_regular(Path(store) / entry["sha256"], MAX_FILE_BYTES)
        if len(data) != entry["byte_length"] or sha256(data) != entry["sha256"]:
            raise ValueError(f"downloaded content mismatch: {entry['path']}")
        contents.append((entry["path"], data))
    destination.mkdir(parents=True, exist_ok=False)
    for relative, data in contents:
        path = destination / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(data)


def verify_materialized(snapshot, root):
    validate_snapshot(snapshot)
    root = Path(root)
    actual = []
    for path in source_files(root):
        data = read_regular(path, MAX_FILE_BYTES)
        actual.append({"path": path.relative_to(root).as_posix(),
                       "byte_length": len(data), "sha256": sha256(data)})
    if actual != snapshot["files"] or snapshot_digest(actual) != snapshot["digest"]:
        raise ValueError("materialized sources changed after pinning")
