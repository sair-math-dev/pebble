import { randomBytes, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

async function main() {
  const { values } = parseArgs({ options: {
    registry:{type:'string'}, 'invite-file':{type:'string'}, output:{type:'string'},
  } });
  if (!values.registry || !values['invite-file'] || !values.output) {
    throw new Error('Usage: accept-invite --registry URL --invite-file PRIVATE_JSON --output PRIVATE_CREDENTIALS');
  }
  const url = new URL(values.registry);
  const loopback = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Registry must be an HTTPS origin (HTTP is allowed only for local testing)');
  }
  const invite = JSON.parse(await readFile(values['invite-file'],'utf8'));
  if (typeof invite.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(invite.code)) throw new Error('Invalid invitation file');
  const codeHash = createHash('sha256').update(invite.code).digest('hex');
  let credentials;
  let file;
  try {
    try {
    file = await open(values.output,'wx',0o600);
    credentials = {registry_url:url.origin,invitation_hash:codeHash,token:randomBytes(32).toString('hex')};
    await file.writeFile(JSON.stringify(credentials)+'\n');
    } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Retry uses the same secret saved before the first request. Never follow
    // a symlink or overwrite a credential file for another server/invitation.
    file = await open(values.output,constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 4096) throw new Error('Credential file must be private and regular');
    credentials = JSON.parse(await file.readFile('utf8'));
    if (credentials.registry_url !== url.origin || credentials.invitation_hash !== codeHash
      || typeof credentials.token !== 'string' || !/^[a-f0-9]{64}$/.test(credentials.token)) {
      throw new Error('Credential file belongs to another invitation or registry');
    }
    }
    // Retry also syncs: an earlier failed fsync may have left readable bytes
    // without having made the credential or its directory entry durable.
    await file.sync();
    const directory=await open(dirname(values.output),constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await file?.close(); }
  const response = await fetch(new URL('/api/v1/invitations/redeem',url), {
    method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({invitation_code:invite.code,token:credentials.token}),
  });
  const chunks=[];
  let size=0;
  for await (const chunk of response.body ?? []) {
    size+=chunk.length;
    if (size>4096) throw new Error('Invitation response exceeded its limit');
    chunks.push(chunk);
  }
  if (!response.ok) throw new Error(`Invitation was not accepted (HTTP ${response.status}); credentials retained for a safe retry`);
  const principal=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof principal.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(principal.id)) throw new Error('Invalid invitation response');
  console.log(JSON.stringify({status:'accepted',id:principal.id,credentials_file:values.output}));
}

main().catch(() => {
  // Do not print a remote response or an exception which might contain secrets.
  console.error('Invitation acceptance failed. Check the invitation, server, and private credential file; retry with the same files.');
  process.exitCode=1;
});
