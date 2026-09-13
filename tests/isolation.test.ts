import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_POLICY } from '../src/protocol.js';
import { loadToolchain, prepareToolchain } from '../src/toolchain.js';
import { runIsolated } from '../src/worker.js';

test('worker isolation denies host state, source writes, networking, credentials and excess runtime', {
  skip: ['/usr/bin/cc', '/usr/bin/bwrap', '/usr/bin/prlimit'].every(existsSync) ? false : 'Linux C compiler and bubblewrap required',
}, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'pebble-isolation-test-'));
  const listener = createServer(socket => socket.end());
  await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
  const address = listener.address(); assert.ok(address && typeof address !== 'string');
  const sentinel = join(scratch, 'host-only-secret.txt');
  const input = join(scratch, 'input');
  const prepared = join(scratch, 'probe-rootfs');
  await mkdir(input);
  await writeFile(sentinel, 'host-only test sentinel');
  await writeFile(join(input, 'source.txt'), 'immutable input');
  const oldSecret = process.env.PEBBLE_ISOLATION_SENTINEL;
  process.env.PEBBLE_ISOLATION_SENTINEL = 'must not reach the child';
  try {
    // A trusted diagnostic executable exercises the same sandbox launcher.
    // It produces no Slate report and is never registered as a toolchain or
    // used to accept mathematical content.
    const source = `#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <arpa/inet.h>
int main(void) {
  if (access("/input/timeout.txt", F_OK) == 0) { sleep(120); return 0; }
  int f = open("/input/source.txt", O_WRONLY | O_TRUNC);
  int source_ro = f < 0; if (f >= 0) close(f);
  f = open(${JSON.stringify(sentinel)}, O_RDONLY);
  int host_hidden = f < 0; if (f >= 0) close(f);
  f = open("/unexpected", O_WRONLY | O_CREAT, 0600);
  int root_ro = f < 0; if (f >= 0) close(f);
  int s = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(${address.port}), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
  int network_denied = s < 0 || connect(s, (struct sockaddr *)&a, sizeof(a)) < 0;
  if (s >= 0) close(s);
  printf("{\\"source_readonly\\":%s,\\"root_readonly\\":%s,\\"host_hidden\\":%s,\\"network_denied\\":%s,\\"environment_cleared\\":%s,\\"host_shell_hidden\\":%s,\\"pid_isolated\\":%s}\\n",
    source_ro?"true":"false", root_ro?"true":"false", host_hidden?"true":"false", network_denied?"true":"false",
    getenv("PEBBLE_ISOLATION_SENTINEL") == NULL && getenv("DATABASE_URL") == NULL && getenv("AWS_SECRET_ACCESS_KEY") == NULL ?"true":"false",
    access("/bin/sh", F_OK) < 0 ?"true":"false", getpid() < 10 ?"true":"false");
  return 0;
}`;
    const cfile = join(scratch, 'probe.c'), executable = join(scratch, 'probe');
    await writeFile(cfile, source);
    execFileSync('/usr/bin/cc', ['-O2', '-o', executable, cfile], { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
    await prepareToolchain(executable, prepared);
    await loadToolchain(prepared);
    const run = await runIsolated(join(prepared, 'rootfs'), input, DEFAULT_POLICY);
    assert.equal(run.code, 0, run.stderr);
    const findings = JSON.parse(run.stdout.toString('utf8')) as Record<string, boolean>;
    assert.equal(Object.keys(findings).length, 7);
    for (const [key, passed] of Object.entries(findings)) assert.equal(passed, true, key);
    assert.equal(await readFile(join(input, 'source.txt'), 'utf8'), 'immutable input');
    await writeFile(join(input, 'timeout.txt'), 'exercise wall time bound');
    const started = Date.now();
    const timed = await runIsolated(join(prepared, 'rootfs'), input, { ...DEFAULT_POLICY, timeout_ms: 100 });
    assert.equal(timed.outcome, 'timeout');
    assert.ok(Date.now() - started < 5000);
    await writeFile(join(prepared, 'rootfs', 'undeclared.txt'), 'unexpected toolchain material');
    await assert.rejects(loadToolchain(prepared), /UnexpectedToolchainEntry/);
  } finally {
    if (oldSecret === undefined) delete process.env.PEBBLE_ISOLATION_SENTINEL;
    else process.env.PEBBLE_ISOLATION_SENTINEL = oldSecret;
    await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done()));
    await rm(scratch, { recursive: true, force: true });
  }
});
