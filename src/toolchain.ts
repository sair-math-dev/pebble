// The worker's fixed root filesystem: the `slate` client, the `slatec`
// compiler and exactly the dynamic libraries they resolve to, copied into a
// directory whose content the descriptor pins byte for byte.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, normalize } from 'node:path';
import { canonical, toolchainDigest, type Toolchain, type FileEntry, HASH } from './protocol.js';

export const ROOTFS_DIRECTORIES = ['tmp', 'proc', 'dev', 'work'];

export async function fileDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

function runtimeLibraries(binary: string): Set<string> {
  const listing = execFileSync('/usr/bin/ldd', [binary], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  if (listing.includes('not found')) throw new Error('MissingRuntimeLibrary');
  const paths = new Set<string>();
  for (const line of listing.split('\n')) {
    const path = /(?:=>\s+)?(\/\S+)\s+\(0x[0-9a-f]+\)/.exec(line)?.[1];
    if (path) paths.add(normalize(path));
  }
  if (!paths.size) throw new Error('DynamicRuntimeInventoryMissing');
  return paths;
}

export async function prepareToolchain(slatec: string, slate: string, output: string): Promise<Toolchain> {
  const compiler = await realpath(slatec);
  const client = await realpath(slate);
  const libraries = new Set([...runtimeLibraries(compiler), ...runtimeLibraries(client)]);
  output = resolve(output);
  await mkdir(output, { recursive: false });
  const rootfs = join(output, 'rootfs');
  await mkdir(rootfs);
  const files: FileEntry[] = [];
  const sources: [string, string][] = [['/slatec', compiler], ['/slate', client], ...[...libraries].sort().map(path => [path, path] as [string, string])];
  for (const [path, source] of sources) {
    const destination = join(rootfs, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, 0o555);
    files.push({ path, byte_length: (await lstat(destination)).size, sha256: await fileDigest(destination) });
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const path of ROOTFS_DIRECTORIES) await mkdir(join(rootfs, path), { recursive: true });
  const descriptor: Toolchain = { schema: 'Pebble.Toolchain', slatec_sha256: await fileDigest(compiler), slate_sha256: await fileDigest(client), files };
  await writeFile(join(output, 'toolchain.json'), canonical(descriptor) + '\n', { flag: 'wx' });
  await writeFile(join(output, 'digest.txt'), toolchainDigest(descriptor) + '\n', { flag: 'wx' });
  return descriptor;
}

export async function loadToolchain(directory: string): Promise<Toolchain> {
  const descriptor = JSON.parse(await readFile(join(directory, 'toolchain.json'), 'utf8')) as Toolchain;
  if (descriptor.schema !== 'Pebble.Toolchain' || !HASH.test(descriptor.slatec_sha256) || !HASH.test(descriptor.slate_sha256)
      || !Array.isArray(descriptor.files) || !descriptor.files.length) throw new Error('InvalidToolchain');
  const pinned = (await readFile(join(directory, 'digest.txt'), 'utf8')).trim();
  if (toolchainDigest(descriptor) !== pinned) throw new Error('ToolchainDescriptorMismatch');
  const expected = new Set<string>();
  let previous = '';
  for (const file of descriptor.files) {
    if (!file.path.startsWith('/') || normalize(file.path) !== file.path || file.path <= previous
        || !HASH.test(file.sha256) || !Number.isSafeInteger(file.byte_length) || file.byte_length <= 0) throw new Error('InvalidToolchainFile');
    previous = file.path;
    const path = join(directory, 'rootfs', file.path);
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.size !== file.byte_length
        || await fileDigest(path) !== file.sha256) throw new Error('ToolchainFileMismatch');
    expected.add(file.path);
  }
  const rootfs = join(directory, 'rootfs');
  const pending = [''];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const entry of await readdir(join(rootfs, parent), { withFileTypes: true })) {
      const path = parent + '/' + entry.name;
      if (entry.isDirectory()) pending.push(path);
      else if (!entry.isFile() || !expected.has(path)) throw new Error('UnexpectedToolchainEntry');
    }
  }
  if (descriptor.files.find(file => file.path === '/slatec')?.sha256 !== descriptor.slatec_sha256
      || descriptor.files.find(file => file.path === '/slate')?.sha256 !== descriptor.slate_sha256) throw new Error('ToolchainBinaryMismatch');
  return descriptor;
}
