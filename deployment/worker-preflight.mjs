import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VerificationWorker } from '../dist/worker.js';
import { DEFAULT_POLICY } from '../dist/protocol.js';

export async function preflight() {
  if (process.platform !== 'linux' || process.getuid?.() === 0) {
    throw new Error('Worker must run as an unprivileged Linux user');
  }
  if (!process.env.SLATE_ROOTFS) throw new Error('SLATE_ROOTFS is required');
  const directory = resolve(process.env.SLATE_ROOTFS);
  // Reuse the exact production worker probe, policy, argv and parser. This
  // deployment launcher has no second definition of a successful check.
  await new VerificationWorker(directory, DEFAULT_POLICY).initialize();
  console.log('Worker namespace/rootfs probe passed; the frozen slate client answered with its usage error.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await preflight();
