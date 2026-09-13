#!/usr/bin/env bash
# Create the Cloudflare tunnel for the three Pebble hosts and install cloudflared
# as a system service. Requires a prior `cloudflared tunnel login` by the account
# owner (it opens a browser URL and writes ~/.cloudflared/cert.pem).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
name="${PEBBLE_TUNNEL_NAME:-pebble}"
port="${PEBBLE_EDGE_PORT:-8081}"
[ -f "$HOME/.cloudflared/cert.pem" ] || { echo "Run 'cloudflared tunnel login' first (needs the Cloudflare account that owns the zone)." >&2; exit 1; }
if ! cloudflared tunnel list --output json | grep -q "\"name\":\"$name\""; then
  cloudflared tunnel create "$name"
fi
id="$(cloudflared tunnel list --output json | python3 -c 'import json,sys; n=sys.argv[1]; print(next(t["id"] for t in json.load(sys.stdin) if t["name"]==n))' "$name")"
for host in index.verifiable.ai static.verifiable.ai slate.verifiable.ai; do
  cloudflared tunnel route dns --overwrite-dns "$name" "$host"
done
sudo install -d -m 0755 /etc/cloudflared
sed -e "s/REPLACE_WITH_TUNNEL_ID/$id/g" -e "s/8081/$port/g" "$here/cloudflared.yml" | sudo tee /etc/cloudflared/config.yml >/dev/null
sudo install -m 0600 "$HOME/.cloudflared/$id.json" "/etc/cloudflared/$id.json"
sudo cloudflared service install 2>/dev/null || true
sudo systemctl restart cloudflared
sudo systemctl enable cloudflared
echo "tunnel $name ($id) serves index./static./slate.verifiable.ai -> http://127.0.0.1:$port"
