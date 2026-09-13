// Key-addressed S3 storage. `staging/` holds candidate archives until they are
// published; `public/` is the read tree (`public/index/...`, `public/packages/...`,
// `public/toolchains/...`) that the static hosts serve and the API mirrors for
// local use. Archive keys are immutable; index files are regenerated.
import {
  S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, HeadBucketCommand, CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { MAX_PACKAGE_BYTES, digestBytes } from './protocol.js';
import type { Readable } from 'node:stream';

export const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const KEY = /^(staging|public)\/[A-Za-z0-9_./@+-]{1,900}$/;

export interface ObjectStore {
  /** Store bytes; `immutable` refuses to replace an existing object with different content. */
  put(key: string, bytes: Uint8Array, options?: { immutable?: boolean; contentType?: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  has(key: string): Promise<boolean>;
  copy(from: string, to: string): Promise<void>;
  healthy?(): Promise<void>;
}

export function validateKey(key: string): string {
  if (!KEY.test(key) || key.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('InvalidObjectKey');
  return key;
}

export class S3ObjectStore implements ObjectStore {
  constructor(readonly client: S3Client, readonly bucket: string) {}
  async put(key: string, bytes: Uint8Array, options: { immutable?: boolean; contentType?: string } = {}): Promise<void> {
    validateKey(key);
    if (bytes.length > MAX_OBJECT_BYTES) throw new Error('ObjectTooLarge');
    const digest = digestBytes(bytes);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: key, Body: bytes, ContentLength: bytes.length,
        ContentType: options.contentType ?? 'application/octet-stream',
        ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
        ...(options.immutable ? { IfNoneMatch: '*' } : {}),
      }), { abortSignal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (!options.immutable || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw error;
      const existing = await this.get(key);
      if (!existing.equals(Buffer.from(bytes))) throw new Error('ImmutableObjectConflict');
    }
  }
  async get(key: string): Promise<Buffer> {
    validateKey(key);
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(30_000) });
    if (!object.Body || object.ContentLength === undefined || object.ContentLength > MAX_OBJECT_BYTES) {
      (object.Body as Readable | undefined)?.destroy();
      throw new Error('InvalidStoredObject');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = object.Body as Readable;
    const timer = setTimeout(() => stream.destroy(new Error('ObjectReadTimeout')), 30_000);
    try {
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > MAX_OBJECT_BYTES) throw new Error('ObjectLimitExceeded');
        chunks.push(Buffer.from(chunk));
      }
    } finally { clearTimeout(timer); stream.destroy(); }
    const bytes = Buffer.concat(chunks);
    if (size !== object.ContentLength) throw new Error('CorruptStoredObject');
    return bytes;
  }
  async has(key: string): Promise<boolean> {
    validateKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: AbortSignal.timeout(15_000) });
      return true;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  }
  async copy(from: string, to: string): Promise<void> {
    validateKey(from); validateKey(to);
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, CopySource: `${this.bucket}/${from}`, Key: to }), { abortSignal: AbortSignal.timeout(30_000) });
  }
  async healthy(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: AbortSignal.timeout(3000) });
  }
}

/** An in-memory store for tests that need no S3. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, bytes: Uint8Array, options: { immutable?: boolean } = {}): Promise<void> {
    validateKey(key);
    const existing = this.objects.get(key);
    if (options.immutable && existing && !existing.equals(Buffer.from(bytes))) throw new Error('ImmutableObjectConflict');
    this.objects.set(key, Buffer.from(bytes));
  }
  async get(key: string): Promise<Buffer> {
    const bytes = this.objects.get(validateKey(key));
    if (!bytes) { const error = new Error('NoSuchKey') as Error & { $metadata?: { httpStatusCode: number } }; error.$metadata = { httpStatusCode: 404 }; throw error; }
    return bytes;
  }
  async has(key: string): Promise<boolean> { return this.objects.has(validateKey(key)); }
  async copy(from: string, to: string): Promise<void> { await this.put(to, await this.get(from)); }
}

export function objectStoreFromEnvironment(): S3ObjectStore {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET is required');
  return new S3ObjectStore(new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    maxAttempts: 3,
  }), bucket);
}

export const MAX_PACKAGE_ARCHIVE_BYTES = MAX_PACKAGE_BYTES;
