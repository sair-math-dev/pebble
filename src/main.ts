import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_POLICY, HASH, TOOLCHAIN_TAG, digestBytes, toolchainDigest, policyDigest, type Toolchain } from './protocol.js';
import { prepareToolchain } from './toolchain.js';
import { objectStoreFromEnvironment } from './object-store.js';
import { Registry, publicKey } from './registry.js';
import { createServer } from './server.js';
import { VerificationWorker } from './worker.js';

const COMMANDS = ['toolchain', 'toolchain-publish', 'migrate', 'reindex', 'invite', 'revoke-invite', 'provision', 'maintainer', 'transfer', 'serve', 'worker'];

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
    slatec: { type: 'string' }, slate: { type: 'string' }, output: { type: 'string' }, name: { type: 'string' },
    id: { type: 'string' }, 'expires-in-hours': { type: 'string' }, once: { type: 'boolean', default: false },
    tag: { type: 'string' }, host: { type: 'string' }, lock: { type: 'string' }, package: { type: 'string' },
    owner: { type: 'string' }, grant: { type: 'boolean', default: false }, revoke: { type: 'boolean', default: false },
  } });
  if (positionals.length !== 1 || !COMMANDS.includes(positionals[0]!)) throw new Error('Usage: pebble ' + COMMANDS.join('|') + ' [options]');
  const command = positionals[0]!;
  if (command === 'toolchain') {
    if (!values.slatec || !values.slate || !values.output) throw new Error('toolchain requires --slatec FILE --slate FILE --output NEW_DIRECTORY');
    const toolchain = await prepareToolchain(values.slatec, values.slate, values.output);
    console.log(JSON.stringify({ toolchain_digest: toolchainDigest(toolchain), output: resolve(values.output) }));
    return;
  }
  await secretsFromFiles();
  const directory = resolve(required('SLATE_ROOTFS'));
  const registryId = required('REGISTRY_ID');
  if (!/^[0-9a-f-]{36}$/.test(registryId)) throw new Error('REGISTRY_ID must be a fixed UUID');
  const toolchainTag = required('PEBBLE_TOOLCHAIN_TAG');
  if (!TOOLCHAIN_TAG.test(toolchainTag)) throw new Error('PEBBLE_TOOLCHAIN_TAG must be a short tag such as 1.95.0');
  const toolchain = JSON.parse(await readFile(join(directory, 'toolchain.json'), 'utf8')) as Toolchain;
  const pinnedDigest = (await readFile(join(directory, 'digest.txt'), 'utf8')).trim();
  if (toolchain.schema !== 'Pebble.Toolchain' || !HASH.test(toolchain.slatec_sha256)
      || toolchainDigest(toolchain) !== pinnedDigest) throw new Error('PinnedToolchainDescriptorMismatch');
  const store = objectStoreFromEnvironment();
  const registry = new Registry({
    databaseUrl: required('DATABASE_URL'), registryId, toolchain, policy: DEFAULT_POLICY, toolchainTag,
    toolchainDigest: pinnedDigest, policyDigest: policyDigest(DEFAULT_POLICY), objectStore: store,
    leaseSeconds: 300,
  });
  if (command === 'migrate') {
    try {
      await registry.initialize({ migrate: true });
      console.log(JSON.stringify({ status: 'migrated', registry_id: registryId }));
    } finally { await registry.close(); }
    return;
  }
  await registry.initialize();
  try {
    switch (command) {
      case 'reindex': {
        const names = values.package ? [values.package] : await registry.reindexAll();
        if (values.package) { await registry.writeIndexConfig(); await registry.reindex(values.package); }
        console.log(JSON.stringify({ status: 'reindexed', packages: names }));
        return;
      }
      case 'toolchain-publish': {
        if (!values.tag || !values.host || !values.slatec || !values.lock) throw new Error('toolchain-publish requires --tag TAG --host ARCH-OS --slatec FILE --lock TOOLCHAIN.lock');
        if (!TOOLCHAIN_TAG.test(values.tag) || !/^[a-z0-9_]+-[a-z0-9_]+$/.test(values.host)) throw new Error('Invalid toolchain tag or host');
        const binary = await readFile(values.slatec);
        const lock = await readFile(values.lock);
        const base = `toolchains/${values.tag}/${values.host}`;
        await store.put(publicKey(`${base}/slatec`), binary, { immutable: true });
        await store.put(publicKey(`${base}/slatec.sha256`), Buffer.from(digestBytes(binary) + '\n'), { immutable: true, contentType: 'text/plain' });
        await store.put(publicKey(`${base}/TOOLCHAIN.lock`), lock, { immutable: true, contentType: 'text/plain' });
        console.log(JSON.stringify({ status: 'published', tag: values.tag, host: values.host, slatec_sha256: digestBytes(binary) }));
        return;
      }
      case 'invite': {
        if (!values.name) throw new Error('invite requires --name NAME');
        const hours = values['expires-in-hours'];
        if (hours !== undefined && !/^[1-9][0-9]{0,2}$/.test(hours)) throw new Error('expires-in-hours must be 1..720');
        // Explicit operator output: deliver this secret through a private
        // channel. Normal API and startup logs never contain invite codes.
        console.log(JSON.stringify(await registry.issueInvitation({name:values.name,expiresInHours:hours === undefined ? undefined : Number(hours)})));
        return;
      }
      case 'revoke-invite': {
        if (!values.id) throw new Error('revoke-invite requires --id UUID');
        console.log(JSON.stringify(await registry.revokeInvitation(values.id)));
        return;
      }
      case 'provision': {
        if (!values.name) throw new Error('provision requires --name NAME');
        const token = randomBytes(32).toString('hex');
        const principal = await registry.provisionPrincipal({ name: values.name, token, maintainer: values.grant });
        // This explicit operator command is the only place credentials are
        // returned. HTTP logs and normal startup never print these tokens.
        console.log(JSON.stringify({ ...principal, token }));
        return;
      }
      case 'maintainer': {
        if (!values.name || values.grant === values.revoke) throw new Error('maintainer requires --name NAME and exactly one of --grant or --revoke');
        console.log(JSON.stringify(await registry.setMaintainer(values.name, values.grant)));
        return;
      }
      case 'transfer': {
        if (!values.package || !values.owner) throw new Error('transfer requires --package NAME --owner PRINCIPAL_NAME');
        console.log(JSON.stringify(await registry.transferPackage(values.package, values.owner)));
        return;
      }
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
    do {
      const worked = await worker.runOne(registry);
      if (values.once) break;
      if (!worked) await delay(1000);
    } while (!stopping);
  } finally { if (command !== 'serve') await registry.close(); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Pebble startup failed');
  process.exitCode = 1;
});
