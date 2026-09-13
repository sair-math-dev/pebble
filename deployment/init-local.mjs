import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const text = [
  '# Generated local development credentials; never use for public deployment.',
  `POSTGRES_PASSWORD=${randomBytes(24).toString('hex')}`,
  `MINIO_PASSWORD=${randomBytes(24).toString('hex')}`,
  'PEBBLE_IMAGE=pebble:local',
  'PEBBLE_PORT=3000',
  `REGISTRY_ID=${randomUUID()}`,
  'SLATE_TOOLCHAIN_DIR=./local/toolchain',
  'PEBBLE_TOOLCHAIN_TAG=local',
].join('\n') + '\n';
await writeFile(new URL('./local.env', import.meta.url), text, { flag: 'wx', mode: 0o600 });
console.log('Created deployment/local.env without overwriting existing credentials.');
