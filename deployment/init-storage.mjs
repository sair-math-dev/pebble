// Local Compose bootstrap only. Production bucket administration is separate.
import { S3Client, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';

const endpoint = new URL(process.env.S3_ENDPOINT || 'http://invalid');
if (!['localhost', '127.0.0.1', 'minio'].includes(endpoint.hostname) || endpoint.protocol !== 'http:') {
  throw new Error('Storage bootstrap is restricted to the local development endpoint');
}
const Bucket = process.env.S3_BUCKET;
if (!Bucket) throw new Error('S3_BUCKET is required');
const region = process.env.S3_REGION || 'us-east-1';
const client = new S3Client({ endpoint: endpoint.href, region, forcePathStyle: true, maxAttempts: 3 });
try {
  await client.send(new HeadBucketCommand({ Bucket }));
} catch (error) {
  if (error.$metadata?.httpStatusCode !== 404) throw error;
  try {
    await client.send(new CreateBucketCommand({ Bucket,
      ...(region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: region } }),
    }));
  } catch (creationError) {
    if (creationError.name !== 'BucketAlreadyOwnedByYou') throw creationError;
  }
}
console.log('Local S3 bucket is ready.');
client.destroy();
