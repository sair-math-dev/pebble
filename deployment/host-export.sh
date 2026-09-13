#!/usr/bin/env bash
# Pack everything a Pebble host holds into one archive so the registry can move:
# the state directory (PostgreSQL data, MinIO data incl. the public index/archive
# tree), tunnel.env, the frozen toolchain root and the cloudflared credentials.
# Services are stopped for the copy so PostgreSQL's data directory is consistent;
# they are started again afterwards unless PEBBLE_EXPORT_KEEP_DOWN=1.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:?Usage: host-export.sh /path/to/pebble-export.tar.zst}"
set -a; . "$here/tunnel.env"; set +a
: "${PEBBLE_STATE_DIR:?tunnel.env must set PEBBLE_STATE_DIR}"
compose=(sudo docker compose --env-file "$here/images.env" --env-file "$here/tunnel.env" -f "$here/compose.tunnel.yaml")
sudo systemctl stop pebble-worker 2>/dev/null || true
"${compose[@]}" stop edge api postgres minio
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/pebble"
sudo cp -a "$PEBBLE_STATE_DIR" "$staging/pebble/state"
install -m 0600 "$here/tunnel.env" "$staging/pebble/tunnel.env"
cp -a "$here/$SLATE_TOOLCHAIN_DIR" "$staging/pebble/toolchain"
if [ -d /etc/cloudflared ]; then sudo cp -a /etc/cloudflared "$staging/pebble/cloudflared"; fi
if [ -f /etc/pebble/worker.env ]; then sudo install -m 0600 /etc/pebble/worker.env "$staging/pebble/worker.env"; fi
sudo tar --zstd -C "$staging" -cf "$out" pebble
sudo chown "$(id -u):$(id -g)" "$out"; chmod 0600 "$out"
if [ "${PEBBLE_EXPORT_KEEP_DOWN:-0}" != "1" ]; then
  "${compose[@]}" start postgres minio api edge
  sudo systemctl start pebble-worker 2>/dev/null || true
fi
echo "exported $(du -h "$out" | cut -f1) to $out"
