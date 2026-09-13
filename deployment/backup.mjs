// Operator-only logical backup and restore. Never invoked by the public API.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { S3Client, HeadBucketCommand, CreateBucketCommand, GetObjectCommand,
  PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const HASH = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
function required(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
  return process.env[name];
}
function connection(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.pathname.slice(1)) throw new Error('A PostgreSQL database URL is required');
  return url;
}
function libpqEnvironment(value) {
  const url = connection(value);
  const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGAPPNAME: 'pebble-backup', PGCONNECT_TIMEOUT: '10',
  };
  // The archive process gets the exact same TLS selection as node-postgres.
  const mappings = { sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', options: 'PGOPTIONS' };
  for (const [key, setting] of url.searchParams) {
    if (!mappings[key]) throw new Error(`Unsupported database URL parameter: ${key}`);
    env[mappings[key]] = setting;
  }
  return env;
}
function s3() {
  return new S3Client({ region: process.env.S3_REGION || 'us-east-1', endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', maxAttempts: 3,
  });
}
async function tool(binary, args, databaseUrl) {
  return new Promise((resolveTool, reject) => {
    const child = spawn(binary, args, { env: libpqEnvironment(databaseUrl), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60 * 1000);
    child.stdout.on('data', chunk => { if (output.length < 16384) output += chunk; });
    child.stderr.on('data', chunk => { if (errors.length < 16384) errors += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`PostgreSQL tool failed (${code}): ${errors}`));
      else resolveTool(output.trim());
    });
  });
}
async function fileHash(path) {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error('Backup entry must be a regular file');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) { size += chunk.length; hash.update(chunk); }
  if (size !== status.size) throw new Error('Backup file changed while reading');
  return { byte_length: size, sha256: hash.digest('hex') };
}
function measureObject(expected) {
  const hash = createHash('sha256');
  let size = 0;
  const stream = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > expected.byte_length) return callback(new Error('Object exceeds declared length'));
    hash.update(chunk); callback(null, chunk);
  } });
  return { stream, finish() {
    if (size !== expected.byte_length || hash.digest('hex') !== expected.digest) throw new Error('Object digest/length mismatch');
  } };
}
async function objectToFile(client, bucket, expected, path) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: `objects/${expected.digest}` }));
  if (!result.Body || result.ContentLength !== expected.byte_length) throw new Error('Object length differs from database');
  const measure = measureObject(expected);
  await pipeline(result.Body, measure.stream, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
  measure.finish();
}
async function checkRemoteObject(client, bucket, expected) {
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: `objects/${expected.digest}` }));
  if (!result.Body || result.ContentLength !== expected.byte_length) throw new Error('Restored object length mismatch');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of result.Body) {
    size += chunk.length;
    if (size > expected.byte_length) throw new Error('Restored object too large');
    hash.update(chunk);
  }
  if (size !== expected.byte_length || hash.digest('hex') !== expected.digest) throw new Error('Restored object checksum mismatch');
}
async function inventory(database, schema) {
  const tables = (await database.query('SELECT schemaname,tablename FROM pg_tables WHERE schemaname=$1 ORDER BY schemaname,tablename', [schema])).rows;
  if (!tables.some(table => table.tablename === 'blobs')) throw new Error('Not a Pebble database schema');
  const counts = [];
  for (const table of tables) {
    const count = (await database.query(`SELECT count(*)::text AS count FROM ${identifier(table.schemaname)}.${identifier(table.tablename)}`)).rows[0].count;
    counts.push({ schema: table.schemaname, table: table.tablename, count });
  }
  const objects = (await database.query(`SELECT digest,byte_length::text AS byte_length FROM ${identifier(schema)}.blobs ORDER BY digest`)).rows.map(row => ({ digest: row.digest, byte_length: Number(row.byte_length) }));
  for (const object of objects) {
    if (!HASH.test(object.digest) || !Number.isSafeInteger(object.byte_length) || object.byte_length < 0) throw new Error('Invalid database object reference');
  }
  const settings = (await database.query(`SELECT registry_id,toolchain_digest,policy_digest FROM ${identifier(schema)}.registry_settings WHERE singleton`)).rows[0];
  if (!settings) throw new Error('Registry settings missing');
  const snapshots = (await database.query(`SELECT digest AS snapshot_digest,
    encode(sha256(convert_to(descriptor::text,'UTF8')),'hex') AS stored_json_sha256
    FROM ${identifier(schema)}.snapshots ORDER BY digest`)).rows;
  const reports = (await database.query(`SELECT id AS attempt_id,report_digest,
    encode(sha256(convert_to(report::text,'UTF8')),'hex') AS stored_json_sha256
    FROM ${identifier(schema)}.verification_attempts ORDER BY id`)).rows;
  // These are backup integrity hashes over stored PostgreSQL JSON text, not new
  // theorem/statement identities or a replacement for Slate verification.
  return { tables: counts, objects, registry: settings, content_checks: { snapshots, reports } };
}
async function createBackup(directory, pgBin, schema) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid --schema name');
  const databaseUrl = required('DATABASE_URL');
  const bucket = required('S3_BUCKET');
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, 'objects'), { mode: 0o700 });
  const database = new pg.Client({ connectionString: databaseUrl });
  const client = s3();
  const started = Date.now();
  let data;
  let serverVersion;
  let dumpVersion;
  let snapshotTime;
  try {
    await database.connect();
    await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshotRow = (await database.query('SELECT pg_export_snapshot() AS snapshot, transaction_timestamp() AS snapshot_time')).rows[0];
    const snapshot = snapshotRow.snapshot;
    snapshotTime = snapshotRow.snapshot_time.toISOString();
    serverVersion = (await database.query('SHOW server_version_num')).rows[0].server_version_num;
    data = await inventory(database, schema);
    const binary = pgBin ? join(pgBin, 'pg_dump') : 'pg_dump';
    dumpVersion = await tool(binary, ['--version'], databaseUrl);
    await tool(binary, ['--format=custom', '--no-owner', '--no-acl', '--lock-wait-timeout=5s',
      `--snapshot=${snapshot}`, `--schema=${schema}`, `--file=${join(directory, 'database.dump')}`], databaseUrl);
    // The SQL rows and pg_dump share exactly one exported snapshot. Immutable
    // content-addressed objects can then be fetched without keeping MVCC open.
    await database.query('COMMIT');
    for (const object of data.objects) await objectToFile(client, bucket, object, join(directory, 'objects', object.digest));
    const manifest = { schema: 'Pebble.Backup.v1', database_snapshot_at: snapshotTime, completed_at: new Date().toISOString(),
      database_server_version_num: serverVersion, database_schema: schema, pg_dump_version: dumpVersion,
      dump: await fileHash(join(directory, 'database.dump')), ...data,
    };
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('Backup inventory exceeds the supported manifest size');
    // Only this final file marks completion. Failed backups remain incomplete.
    await writeFile(join(directory, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
    return { status: 'backup_complete', archive: directory, manifest_sha256: sha(bytes),
      objects: data.objects.length, object_bytes: data.objects.reduce((sum, object) => sum + object.byte_length, 0),
      elapsed_ms: Date.now() - started };
  } finally { await database.end(); client.destroy(); }
}
async function readArchive(directory, expectedDigest) {
  if (!HASH.test(expectedDigest || '')) throw new Error('--manifest-sha256 must be the independently retained backup digest');
  for (const path of [directory, join(directory, 'objects')]) {
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Backup directories cannot be symlinks');
  }
  const file = join(directory, 'manifest.json');
  const status = await lstat(file);
  if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_MANIFEST_BYTES) throw new Error('Invalid backup manifest file');
  const bytes = await readFile(file);
  if (sha(bytes) !== expectedDigest) throw new Error('Backup manifest checksum mismatch');
  const manifest = JSON.parse(bytes);
  if (manifest.schema !== 'Pebble.Backup.v1' || !Array.isArray(manifest.objects) || !Array.isArray(manifest.tables)
      || !manifest.registry || !manifest.dump || !HASH.test(manifest.dump.sha256)
      || !manifest.content_checks || !Array.isArray(manifest.content_checks.snapshots) || !Array.isArray(manifest.content_checks.reports)
      || !/^[a-z][a-z0-9_]{0,62}$/.test(manifest.database_schema)) throw new Error('Invalid backup manifest');
  let previous = '';
  for (const object of manifest.objects) {
    if (!HASH.test(object.digest) || object.digest <= previous || !Number.isSafeInteger(object.byte_length) || object.byte_length < 0) throw new Error('Invalid backup object entry');
    previous = object.digest;
    const actual = await fileHash(join(directory, 'objects', object.digest));
    if (actual.sha256 !== object.digest || actual.byte_length !== object.byte_length) throw new Error('Backup object checksum mismatch');
  }
  const dump = await fileHash(join(directory, 'database.dump'));
  if (dump.sha256 !== manifest.dump.sha256 || dump.byte_length !== manifest.dump.byte_length) throw new Error('Backup database checksum mismatch');
  return manifest;
}
async function verifyTargets(databaseUrl, bucket, manifest, client) {
  const database = new pg.Client({ connectionString: databaseUrl });
  try {
    await database.connect();
    await database.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actual = await inventory(database, manifest.database_schema);
    if (JSON.stringify(actual.tables) !== JSON.stringify(manifest.tables)
        || JSON.stringify(actual.objects) !== JSON.stringify(manifest.objects)
        || JSON.stringify(actual.registry) !== JSON.stringify(manifest.registry)
        || JSON.stringify(actual.content_checks) !== JSON.stringify(manifest.content_checks)) throw new Error('Restored database inventory differs from backup');
    await database.query('COMMIT');
    for (const object of manifest.objects) await checkRemoteObject(client, bucket, object);
    const keys = [];
    let token;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
      keys.push(...(page.Contents || []).map(object => object.Key));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !token) throw new Error('Incomplete restored bucket inventory');
    } while (token);
    if (JSON.stringify(keys.sort()) !== JSON.stringify(manifest.objects.map(object => `objects/${object.digest}`))) throw new Error('Unexpected objects in restored bucket');
  } finally { await database.end(); }
}
async function restoreBackup(directory, expectedDigest, name, bucketPrefix, createTargets, pgBin) {
  if (!createTargets) throw new Error('Restore requires explicit --create-new-targets');
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(name || '') || ['postgres', 'template0', 'template1'].includes(name)) throw new Error('Choose a new, non-system --database name');
  if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(bucketPrefix || '')) throw new Error('--bucket-prefix must contain 3..30 lowercase letters, digits or hyphens');
  // AWS us-east-1 may return success for an existing owned bucket. A caller
  // therefore selects a prefix, never an existing exact destination name.
  const bucket = `${bucketPrefix}-${randomUUID().replaceAll('-', '')}`;
  const manifest = await readArchive(directory, expectedDigest);
  const adminUrl = required('RESTORE_ADMIN_DATABASE_URL');
  const target = connection(adminUrl);
  target.pathname = '/' + name;
  const admin = new pg.Client({ connectionString: adminUrl });
  const client = s3();
  const started = Date.now();
  try {
    await admin.connect();
    if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount) throw new Error('Restore refuses an existing database');
    const version = (await admin.query('SHOW server_version_num')).rows[0].server_version_num;
    if (Math.floor(Number(version) / 10000) !== Math.floor(Number(manifest.database_server_version_num) / 10000)) throw new Error('Restore requires the same PostgreSQL major version');
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      throw new Error('Restore refuses an existing bucket, even if it is empty');
    } catch (error) {
      if (error.$metadata?.httpStatusCode !== 404) throw error;
    }
    await admin.query(`CREATE DATABASE ${identifier(name)} TEMPLATE template0`);
    // New databases normally allow PUBLIC to connect. Keep historical ACLs and
    // tokens inaccessible to runtime roles until revocations are reconciled.
    await admin.query(`REVOKE CONNECT ON DATABASE ${identifier(name)} FROM PUBLIC`);
    const region = process.env.S3_REGION || 'us-east-1';
    await client.send(new CreateBucketCommand({ Bucket: bucket,
      ...(region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: region } }),
    }));
    for (const object of manifest.objects) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: `objects/${object.digest}`,
        Body: createReadStream(join(directory, 'objects', object.digest)), ContentLength: object.byte_length,
        ChecksumSHA256: Buffer.from(object.digest, 'hex').toString('base64'), IfNoneMatch: '*',
      }));
    }
    const binary = pgBin ? join(pgBin, 'pg_restore') : 'pg_restore';
    await tool(binary, ['--single-transaction', '--exit-on-error', '--no-owner', '--no-acl',
      '--dbname=' + name, join(directory, 'database.dump')], target.href);
    await verifyTargets(target.href, bucket, manifest, client);
    return { status: 'restored_verified', database: name, bucket, manifest_sha256: expectedDigest,
      database_schema: manifest.database_schema, objects: manifest.objects.length, tables: manifest.tables.length, elapsed_ms: Date.now() - started,
      checked_snapshot_records: manifest.content_checks.snapshots.length, checked_report_records: manifest.content_checks.reports.length,
      access: 'quarantined_public_connect_revoked', serving: false,
      next_step: 'Use a distinct runtime role; reconcile current permissions/revocations before explicitly granting CONNECT' };
  } finally { await admin.end(); client.destroy(); }
}

async function main() {
  process.umask(0o077);
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    archive: { type: 'string' }, 'manifest-sha256': { type: 'string' }, 'pg-bin': { type: 'string' }, schema: { type: 'string', default: 'public' },
    database: { type: 'string' }, 'bucket-prefix': { type: 'string' }, 'create-new-targets': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('backup.mjs backup --archive NEW_DIRECTORY [--schema public] [--pg-bin DIRECTORY]\nbackup.mjs restore --archive DIRECTORY --manifest-sha256 HASH --database NEW_NAME --bucket-prefix PREFIX --create-new-targets [--pg-bin DIRECTORY]\nBackup: DATABASE_URL + S3 config. Restore: RESTORE_ADMIN_DATABASE_URL + destination S3 config. The script creates a randomly suffixed bucket. Credentials are read from environment.');
    return;
  }
  if (positionals.length !== 1 || !['backup', 'restore'].includes(positionals[0]) || !values.archive) throw new Error('Use --help for the operator backup/restore commands');
  const directory = resolve(values.archive);
  const result = positionals[0] === 'backup' ? await createBackup(directory, values['pg-bin'], values.schema)
    : await restoreBackup(directory, values['manifest-sha256'], values.database, values['bucket-prefix'], values['create-new-targets'], values['pg-bin']);
  console.log(JSON.stringify(result));
}
main().catch(error => {
  let message = error instanceof Error ? error.message : 'Backup operation failed';
  for (const key of ['DATABASE_URL', 'RESTORE_ADMIN_DATABASE_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
    if (process.env[key]) message = message.replaceAll(process.env[key], '[redacted]');
  }
  console.error(message);
  process.exitCode = 1;
});
