import { spawn } from 'node:child_process';
import { preflight } from './worker-preflight.mjs';

await preflight();
const child = spawn(process.execPath, ['dist/main.js', 'worker'], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : 1);
});
