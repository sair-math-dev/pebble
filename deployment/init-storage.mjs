// Local Compose bootstrap only. Production bucket administration is separate.
import { S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketPolicyCommand } from '@aws-sdk/client-s3';

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
  // MinIO reports a missing bucket as NotFound/NoSuchBucket, not always with a 404 status.
  if (error.$metadata?.httpStatusCode !== 404 && !['NotFound', 'NoSuchBucket'].includes(error.name)) throw error;
  try {
    await client.send(new CreateBucketCommand({ Bucket,
      ...(region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: region } }),
    }));
  } catch (creationError) {
    if (creationError.name !== 'BucketAlreadyOwnedByYou') throw creationError;
  }
}
// Only the `public/` prefix (index, archives, toolchains) is readable anonymously; staging
// stays private. Production applies the equivalent policy through its own bucket administration.
await client.send(new PutBucketPolicyCommand({ Bucket, Policy: JSON.stringify({
  Version: '2012-10-17',
  Statement: [{ Sid: 'PebblePublicTree', Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${Bucket}/public/*`] }],
}) }));
console.log('Local S3 bucket is ready; public/ is anonymously readable, staging/ is private.');
client.destroy();
