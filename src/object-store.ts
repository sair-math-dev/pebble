import {
  S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { HASH, MAX_PACKAGE_BYTES, digestBytes } from './protocol.js';
import type { Readable } from 'node:stream';

export interface ObjectStore {
  put(digest: string, bytes: Uint8Array): Promise<void>;
  get(digest: string): Promise<Buffer>;
  has(digest: string): Promise<boolean>;
  healthy?(): Promise<void>;
}

export class S3ObjectStore implements ObjectStore {
  constructor(readonly client: S3Client, readonly bucket: string) {}
  private key(digest: string) {
    if (!HASH.test(digest)) throw new Error('InvalidObjectDigest');
    return `objects/${digest}`;
  }
  async put(digest: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > MAX_PACKAGE_BYTES || digestBytes(bytes) !== digest) throw new Error('ObjectDigestMismatch');
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: this.key(digest), Body: bytes,
        ContentLength: bytes.length, ContentType: 'application/octet-stream',
        ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'), IfNoneMatch: '*',
      }), { abortSignal: AbortSignal.timeout(15_000) });
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw error;
      const existing = await this.get(digest);
      if (!existing.equals(Buffer.from(bytes))) throw new Error('ImmutableObjectConflict');
    }
  }
  async get(digest: string): Promise<Buffer> {
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(digest) }), { abortSignal: AbortSignal.timeout(15_000) });
    if (!object.Body || object.ContentLength === undefined || object.ContentLength > MAX_PACKAGE_BYTES) {
      (object.Body as Readable | undefined)?.destroy();
      throw new Error('InvalidStoredObject');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = object.Body as Readable;
    const timer = setTimeout(() => stream.destroy(new Error('ObjectReadTimeout')), 15_000);
    try {
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > MAX_PACKAGE_BYTES) throw new Error('ObjectLimitExceeded');
        chunks.push(Buffer.from(chunk));
      }
    } finally { clearTimeout(timer); stream.destroy(); }
    const bytes = Buffer.concat(chunks);
    if (size !== object.ContentLength || digestBytes(bytes) !== digest) throw new Error('CorruptStoredObject');
    return bytes;
  }
  async has(digest: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(digest) }), { abortSignal: AbortSignal.timeout(15_000) });
      return true;
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  }
  async healthy(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: AbortSignal.timeout(3000) });
  }
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
