#!/usr/bin/env bash
# Restore a host-export.sh archive on a new host and start the registry there.
# Prerequisites on the new host: docker with compose, cloudflared, bubblewrap,
# node >= 20.19, this repository checked out at the same commit, and the pinned
# images reachable (deployment/images.env). DNS never changes: the tunnel
# credentials in the archive keep the three hostnames pointing at this host.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
archive="${1:?Usage: host-import.sh /path/to/pebble-export.tar.zst}"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
sudo tar --zstd -C "$staging" -xf "$archive"
install -m 0600 "$staging/pebble/tunnel.env" "$here/tunnel.env"
set -a; . "$here/tunnel.env"; set +a
sudo mkdir -p "$(dirname "$PEBBLE_STATE_DIR")"
[ -e "$PEBBLE_STATE_DIR" ] && { echo "$PEBBLE_STATE_DIR already exists; refusing to overwrite" >&2; exit 1; }
sudo cp -a "$staging/pebble/state" "$PEBBLE_STATE_DIR"
mkdir -p "$(dirname "$here/$SLATE_TOOLCHAIN_DIR")"
cp -a "$staging/pebble/toolchain" "$here/$SLATE_TOOLCHAIN_DIR"
if [ -d "$staging/pebble/cloudflared" ]; then sudo cp -a "$staging/pebble/cloudflared" /etc/cloudflared; sudo cloudflared service install 2>/dev/null || true; sudo systemctl enable --now cloudflared; fi
if [ -f "$staging/pebble/worker.env" ]; then sudo install -d -m 0700 /etc/pebble; sudo install -m 0600 "$staging/pebble/worker.env" /etc/pebble/worker.env; fi
compose=(sudo docker compose --env-file "$here/images.env" --env-file "$here/tunnel.env" -f "$here/compose.tunnel.yaml")
"${compose[@]}" build api
"${compose[@]}" up -d postgres minio
sleep 5
"${compose[@]}" run --rm migrate
"${compose[@]}" up -d api edge
echo "imported; run deployment/worker-install.sh to start the verification worker on this host"
