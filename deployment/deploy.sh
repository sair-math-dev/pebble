#!/usr/bin/env bash
# Single-host production deployment over SSH: ship the reviewed API image and the
# Compose/edge configuration, migrate on request, then start api and edge.
#
# Required environment:
#   PEBBLE_DEPLOY_HOST   ssh destination, e.g. deploy@registry-host.example
#   PEBBLE_DEPLOY_KEY    private key file for that destination (never committed)
# Optional:
#   PEBBLE_DEPLOY_DIR    remote directory holding the Compose files (default /opt/pebble/deploy)
#   PEBBLE_DEPLOY_IMAGE  local image reference to save and load remotely; when unset the
#                        remote host pulls PEBBLE_IMAGE from production.compose.env instead
#   PEBBLE_DEPLOY_MIGRATE=1  run the operator migration once before starting the API
#   PEBBLE_DEPLOY_DRY_RUN=1  print the plan and stop before touching the host
#
# Inputs that must already exist locally (mode 0600, never committed):
#   deployment/images.env, deployment/production.compose.env, deployment/production.api.env
# The script never invents hosts, credentials or image digests; it refuses to run
# without them. It is not part of any test and is not executed by the test suite.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${PEBBLE_DEPLOY_HOST:?Set PEBBLE_DEPLOY_HOST to the ssh destination of the deployment host}"
: "${PEBBLE_DEPLOY_KEY:?Set PEBBLE_DEPLOY_KEY to the private key file for that host}"
remote_dir="${PEBBLE_DEPLOY_DIR:-/opt/pebble/deploy}"
[ -r "$PEBBLE_DEPLOY_KEY" ] || { echo "PEBBLE_DEPLOY_KEY is not readable" >&2; exit 1; }

for file in images.env production.compose.env production.api.env compose.production.yaml Caddyfile; do
  [ -f "$here/$file" ] || { echo "Missing deployment/$file; fill it from its .example before deploying" >&2; exit 1; }
done
for secret in production.compose.env production.api.env; do
  mode="$(stat -c '%a' "$here/$secret")"
  [ "$mode" = "600" ] || { echo "deployment/$secret must have mode 0600 (has $mode)" >&2; exit 1; }
done
grep -q '^PEBBLE_IMAGE=.*@sha256:' "$here/production.compose.env" || { echo "production.compose.env must pin PEBBLE_IMAGE to a sha256 digest" >&2; exit 1; }
grep -q '^PEBBLE_TOOLCHAIN_TAG=[A-Za-z0-9._-]\+$' "$here/production.compose.env" || { echo "production.compose.env must set PEBBLE_TOOLCHAIN_TAG" >&2; exit 1; }
for var in PEBBLE_INDEX_DOMAIN PEBBLE_STATIC_DOMAIN PEBBLE_API_DOMAIN ACME_EMAIL SLATE_TOOLCHAIN_DIR; do
  grep -q "^$var=[^R][^E]" "$here/production.compose.env" || { echo "production.compose.env must set $var to a real value" >&2; exit 1; }
done

ssh_opts=(-i "$PEBBLE_DEPLOY_KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
compose=(docker compose --env-file "$remote_dir/images.env" --env-file "$remote_dir/production.compose.env" -f "$remote_dir/compose.production.yaml")

echo "Deploying to $PEBBLE_DEPLOY_HOST:$remote_dir"
echo "  image: $(grep '^PEBBLE_IMAGE=' "$here/production.compose.env" | cut -d= -f2-)"
echo "  hosts: $(grep -E '^PEBBLE_(INDEX|STATIC|API)_DOMAIN=' "$here/production.compose.env" | cut -d= -f2- | paste -sd' ')"
echo "  migrate: ${PEBBLE_DEPLOY_MIGRATE:-0}"
if [ "${PEBBLE_DEPLOY_DRY_RUN:-0}" = "1" ]; then echo "Dry run; nothing was sent."; exit 0; fi

ssh "${ssh_opts[@]}" "$PEBBLE_DEPLOY_HOST" "umask 077 && mkdir -p '$remote_dir'"
rsync -e "ssh ${ssh_opts[*]}" --archive --chmod=F600,D700 --checksum \
  "$here/compose.production.yaml" "$here/Caddyfile" "$here/images.env" "$here/production.compose.env" "$here/production.api.env" \
  "$PEBBLE_DEPLOY_HOST:$remote_dir/"

if [ -n "${PEBBLE_DEPLOY_IMAGE:-}" ]; then
  # Ship a locally built image without a registry; the remote digest is printed for the release record.
  docker image inspect "$PEBBLE_DEPLOY_IMAGE" >/dev/null
  docker save "$PEBBLE_DEPLOY_IMAGE" | ssh "${ssh_opts[@]}" "$PEBBLE_DEPLOY_HOST" "docker load"
else
  ssh "${ssh_opts[@]}" "$PEBBLE_DEPLOY_HOST" "${compose[*]} pull api edge"
fi

if [ "${PEBBLE_DEPLOY_MIGRATE:-0}" = "1" ]; then
  # The same image runs the idempotent operator migration once; the API refuses to start on an old schema.
  ssh "${ssh_opts[@]}" "$PEBBLE_DEPLOY_HOST" "${compose[*]} run --rm --no-deps api migrate"
fi

ssh "${ssh_opts[@]}" "$PEBBLE_DEPLOY_HOST" "${compose[*]} up -d api edge && ${compose[*]} ps"
api_domain="$(grep '^PEBBLE_API_DOMAIN=' "$here/production.compose.env" | cut -d= -f2-)"
index_domain="$(grep '^PEBBLE_INDEX_DOMAIN=' "$here/production.compose.env" | cut -d= -f2-)"
echo "Started. Verify from outside the host:"
echo "  curl -fsS https://$api_domain/health/ready"
echo "  curl -fsS https://$index_domain/config.json"
echo "Then run a real publish with the slate client against a scratch package before announcing the release."
