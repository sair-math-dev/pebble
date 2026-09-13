#!/usr/bin/env bash
# Install (or refresh) the host verification worker for the tunnel deployment:
# system user, versioned application directory, frozen toolchain root, env file,
# systemd unit. Idempotent; rerun after rebuilding the app or the toolchain.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
set -a; . "$here/tunnel.env"; set +a
: "${REGISTRY_ID:?}" "${PEBBLE_TOOLCHAIN_TAG:?}" "${POSTGRES_PASSWORD:?}" "${MINIO_PASSWORD:?}" "${SLATE_TOOLCHAIN_DIR:?}"
toolchain="$here/$SLATE_TOOLCHAIN_DIR"
digest="$(cat "$toolchain/digest.txt")"
id pebble-worker >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/pebble-worker --shell /usr/sbin/nologin pebble-worker
release="/opt/pebble/releases/$(cd "$repo" && git rev-parse --short HEAD)"
sudo install -d -m 0755 /opt/pebble /opt/pebble/releases /opt/pebble/toolchains
sudo rm -rf "$release"; sudo install -d -m 0755 "$release/deployment"
sudo cp -a "$repo/dist" "$repo/node_modules" "$repo/migrations" "$repo/package.json" "$release/"
sudo cp "$here/worker-preflight.mjs" "$release/deployment/"
sudo chown -R root:root "$release"; sudo ln -sfn "$release" /opt/pebble/current
if [ ! -d "/opt/pebble/toolchains/$digest" ]; then sudo cp -a "$toolchain" "/opt/pebble/toolchains/$digest"; sudo chown -R root:root "/opt/pebble/toolchains/$digest"; fi
# The toolchain may have been generated under a restrictive umask; the worker user only needs to read it.
sudo chmod -R u=rwX,go=rX "/opt/pebble/toolchains/$digest" "$release"
sudo ln -sfn "/opt/pebble/toolchains/$digest" /opt/pebble/toolchains/current
sudo install -d -m 0700 /etc/pebble
umask 077
cat <<ENV | sudo tee /etc/pebble/worker.env >/dev/null
REGISTRY_ID=$REGISTRY_ID
PEBBLE_TOOLCHAIN_TAG=$PEBBLE_TOOLCHAIN_TAG
PEBBLE_INDEX_ROOT=https://$PEBBLE_INDEX_DOMAIN/
PEBBLE_DL_TEMPLATE=https://$PEBBLE_STATIC_DOMAIN/packages/{package}/{version}/{package}-{version}
PEBBLE_API_ROOT=https://$PEBBLE_API_DOMAIN/api/v1
DATABASE_URL=postgresql://pebble:$POSTGRES_PASSWORD@127.0.0.1:5432/pebble
DB_POOL_SIZE=4
S3_ENDPOINT=http://127.0.0.1:9000
S3_REGION=us-east-1
S3_BUCKET=pebble
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=pebble-local
AWS_SECRET_ACCESS_KEY=$MINIO_PASSWORD
ENV
sudo chmod 0600 /etc/pebble/worker.env
# Prefer a Node 24 runtime installed at /opt/pebble/node (the AWS SDK warns below Node 22).
node_bin=/usr/bin/node
[ -x /opt/pebble/node/bin/node ] && node_bin=/opt/pebble/node/bin/node
sed "s#/usr/bin/node#$node_bin#g" "$here/pebble-worker.service" | sudo tee /etc/systemd/system/pebble-worker.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now pebble-worker
sleep 3
sudo systemctl --no-pager --lines=8 status pebble-worker || true
