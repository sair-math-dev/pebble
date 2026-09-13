// Use the generated loopback-only Compose credentials without putting secrets
// in command-line arguments or printing them. This is not a production launcher.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const command = process.argv[2];
if (!['serve', 'worker', 'migrate', 'provision'].includes(command)) throw new Error('Usage: node deployment/local-cli.mjs serve|worker|migrate|provision [arguments]');
const directory = fileURLToPath(new URL('.', import.meta.url));
const config = Object.fromEntries((await readFile(new URL('./local.env', import.meta.url), 'utf8')).split('\n')
  .filter(line => line && !line.startsWith('#')).map(line => {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('Invalid generated local.env');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
for (const name of ['POSTGRES_PASSWORD', 'MINIO_PASSWORD', 'REGISTRY_ID', 'SLATE_TOOLCHAIN_DIR']) {
  if (!config[name]) throw new Error(`Missing ${name} in local.env`);
}
const env = { ...process.env,
  NODE_ENV: 'development', HOST: '127.0.0.1', PORT: config.PEBBLE_PORT || '3000',
  REGISTRY_ID: config.REGISTRY_ID, SLATE_ROOTFS: resolve(directory, config.SLATE_TOOLCHAIN_DIR),
  DATABASE_URL: `postgres://pebble:${encodeURIComponent(config.POSTGRES_PASSWORD)}@127.0.0.1:5432/pebble`,
  DB_POOL_SIZE: command === 'worker' ? '4' : '12',
  S3_ENDPOINT: 'http://127.0.0.1:9000', S3_REGION: 'us-east-1', S3_BUCKET: 'pebble',
  S3_FORCE_PATH_STYLE: 'true', AWS_ACCESS_KEY_ID: 'pebble-local', AWS_SECRET_ACCESS_KEY: config.MINIO_PASSWORD,
};
delete env.AWS_SESSION_TOKEN;
const child = spawn(process.execPath, ['dist/main.js', ...process.argv.slice(2)], {
  cwd: resolve(directory, '..'), env, stdio: 'inherit',
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : 1); });
