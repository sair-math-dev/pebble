import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_POLICY, HASH, UUID, toolchainDigest, policyDigest, type Toolchain } from './protocol.js';
import { prepareToolchain } from './toolchain.js';
import { objectStoreFromEnvironment } from './object-store.js';
import { Registry } from './registry.js';
import { createServer } from './server.js';
import { VerificationWorker } from './worker.js';

async function secretsFromFiles(): Promise<void> {
  for (const key of ['DATABASE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
    const file = process.env[key + '_FILE'];
    if (file && process.env[key]) throw new Error(`Set only one of ${key} or ${key}_FILE`);
    if (file) process.env[key] = (await readFile(file, 'utf8')).trim();
  }
}
function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    slatec: { type: 'string' }, output: { type: 'string' }, name: { type: 'string' },
    id: { type: 'string' }, 'expires-in-hours': { type: 'string' },
    once: { type: 'boolean', default: false },
  } });
  if (positionals.length !== 1) throw new Error('Usage: pebble toolchain|migrate|invite|revoke-invite|provision|serve|worker [options]');
  const command = positionals[0];
  if (command === 'toolchain') {
    if (!values.slatec || !values.output) throw new Error('toolchain requires --slatec FILE --output NEW_DIRECTORY');
    const toolchain = await prepareToolchain(values.slatec, values.output);
    console.log(JSON.stringify({ toolchain_digest: toolchainDigest(toolchain), output: resolve(values.output) }));
    return;
  }
  if (!['migrate', 'invite', 'revoke-invite', 'provision', 'serve', 'worker'].includes(command!)) throw new Error('Unknown command');
  await secretsFromFiles();
  const directory = resolve(required('SLATE_ROOTFS'));
  const registryId = required('REGISTRY_ID');
  if (!UUID.test(registryId)) throw new Error('REGISTRY_ID must be a fixed UUID');
  const toolchain = JSON.parse(await readFile(join(directory, 'toolchain.json'), 'utf8')) as Toolchain;
  const pinnedDigest = (await readFile(join(directory, 'digest.txt'), 'utf8')).trim();
  if (toolchain.schema !== 'Pebble.Toolchain.v1' || !HASH.test(toolchain.slatec_sha256)
      || toolchainDigest(toolchain) !== pinnedDigest) throw new Error('PinnedToolchainDescriptorMismatch');
  const store = objectStoreFromEnvironment();
  const registry = new Registry({
    databaseUrl: required('DATABASE_URL'), registryId, toolchain, policy: DEFAULT_POLICY,
    toolchainDigest: pinnedDigest, policyDigest: policyDigest(DEFAULT_POLICY), objectStore: store,
    leaseSeconds: 60,
  });
  if (command === 'migrate') {
    try {
      await registry.initialize({ migrate: true });
      console.log(JSON.stringify({ status: 'migrated', registry_id: registryId }));
    } finally { await registry.close(); }
    return;
  }
  await registry.initialize();
  if (command === 'invite' || command === 'revoke-invite') {
    try {
      if (command === 'invite') {
        if (!values.name) throw new Error('invite requires --name NAME');
        const hours = values['expires-in-hours'];
        if (hours !== undefined && !/^[1-9][0-9]{0,2}$/.test(hours)) throw new Error('expires-in-hours must be 1..720');
        // Explicit operator output: deliver this secret through a private
        // channel. Normal API and startup logs never contain invite codes.
        console.log(JSON.stringify(await registry.issueInvitation({name:values.name,expiresInHours:hours === undefined ? undefined : Number(hours)})));
      } else {
        if (!values.id) throw new Error('revoke-invite requires --id UUID');
        console.log(JSON.stringify(await registry.revokeInvitation(values.id)));
      }
    } finally { await registry.close(); }
    return;
  }
  if (command === 'provision') {
    try {
      if (!values.name) throw new Error('provision requires --name NAME');
      const token = randomBytes(32).toString('hex');
      const principal = await registry.provisionPrincipal({ name: values.name, token });
      // This explicit operator command is the only place credentials are
      // returned. HTTP logs and normal startup never print these tokens.
      console.log(JSON.stringify({ ...principal, token }));
    } finally { await registry.close(); }
    return;
  }
  await store.healthy();
  if (command === 'serve') {
    const app = createServer(registry);
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => { void app.close().then(() => registry.close()); });
    }
    await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? '3000') });
    return;
  }
  const worker = new VerificationWorker(directory, DEFAULT_POLICY);
  await worker.initialize();
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { stopping = true; });
  try {
    do {
      const worked = await worker.runOne(registry);
      if (values.once) break;
      if (!worked) await delay(1000);
    } while (!stopping);
  } finally { await registry.close(); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Pebble startup failed');
  process.exitCode = 1;
});
