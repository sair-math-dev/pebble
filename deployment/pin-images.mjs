// Resolve official registry manifests and derive digests from their actual bytes.
// No Docker socket is needed. Re-run explicitly when reviewing image upgrades.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const sources = {
  NODE_IMAGE: 'library/node:24-bookworm-slim',
  POSTGRES_IMAGE: 'library/postgres:17-bookworm',
  CADDY_IMAGE: 'library/caddy:2-alpine',
  // Local protocol testing only; see docs/deployment.md for its archived status.
  MINIO_IMAGE: 'minio/minio:RELEASE.2025-09-07T16-13-09Z',
};
const accept = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const images = {};
for (const [name, source] of Object.entries(sources)) {
  const separator = source.lastIndexOf(':');
  const repository = source.slice(0, separator);
  const tag = source.slice(separator + 1);
  const auth = await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`, { signal: AbortSignal.timeout(30_000) });
  if (!auth.ok) throw new Error(`Registry authentication failed for ${repository}: ${auth.status}`);
  const { token } = await auth.json();
  const response = await fetch(`https://registry-1.docker.io/v2/${repository}/manifests/${tag}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Manifest fetch failed for ${source}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (response.headers.get('docker-content-digest') !== digest) throw new Error(`Manifest digest mismatch for ${source}`);
  images[name] = { source: `docker.io/${source}`, digest, reference: `docker.io/${repository}@${digest}` };
}
const lock = { schema: 'Pebble.DeploymentImages.v1', resolved_at: new Date().toISOString(), images };
await writeFile(new URL('./images.lock.json', import.meta.url), `${JSON.stringify(lock, null, 2)}\n`);
await writeFile(new URL('./images.env', import.meta.url), Object.entries(images).map(([name, image]) => `${name}=${image.reference}`).join('\n') + '\n');
console.log('Generated deployment/images.lock.json and deployment/images.env. Review the lock diff before building.');
