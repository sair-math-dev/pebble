// Bounded read-only HTTP load probe. Exercise real metadata/download endpoints;
// a health endpoint result is not evidence of registry or checker capacity.
import { performance } from 'node:perf_hooks';

if (process.argv.includes('--help')) {
  console.log('node deployment/load.mjs --url URL [--rps 10] [--seconds 30] [--concurrency 50]\nOptional PEBBLE_LOAD_TOKEN supplies a bearer token; it is never printed.');
  process.exit(0);
}
const values = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!['--url', '--rps', '--seconds', '--concurrency'].includes(key) || !value || values.has(key)) throw new Error('Invalid arguments; use --help');
  values.set(key, value);
}
const url = new URL(values.get('--url'));
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('An HTTP URL without credentials is required');
const rps = Number(values.get('--rps') || 10);
const seconds = Number(values.get('--seconds') || 30);
const maximumInflight = Number(values.get('--concurrency') || 50);
if (!Number.isFinite(rps) || rps < 1 || rps > 2000 || !Number.isInteger(seconds) || seconds < 1 || seconds > 300
    || !Number.isInteger(maximumInflight) || maximumInflight < 1 || maximumInflight > 500) throw new Error('Bounds: 1..2000 RPS, 1..300 seconds, 1..500 concurrent requests');
const headers = process.env.PEBBLE_LOAD_TOKEN ? { Authorization: `Bearer ${process.env.PEBBLE_LOAD_TOKEN}` } : {};
const startedAt = new Date().toISOString();
const started = performance.now();
const latencies = [];
const statusCounts = {};
const active = new Set();
let scheduled = 0;
let dropped = 0;
let bytes = 0;
let errors = 0;
let peakInflight = 0;
const totalSlots = Math.floor(rps * seconds);

async function request() {
  const before = performance.now();
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000), redirect: 'error' });
    statusCounts[response.status] = (statusCounts[response.status] || 0) + 1;
    if (!response.ok) errors++;
    if (response.body) for await (const chunk of response.body) bytes += chunk.byteLength;
  } catch { errors++; statusCounts.transport_error = (statusCounts.transport_error || 0) + 1; }
  latencies.push(performance.now() - before);
}

while (scheduled < totalSlots || performance.now() - started < seconds * 1000) {
  const due = Math.min(totalSlots, Math.floor((performance.now() - started) * rps / 1000) + 1);
  while (scheduled < due) {
    scheduled++;
    if (active.size >= maximumInflight) { dropped++; continue; }
    const promise = request();
    active.add(promise);
    peakInflight = Math.max(peakInflight, active.size);
    promise.finally(() => active.delete(promise));
  }
  if (performance.now() - started < seconds * 1000) await new Promise(resolve => setTimeout(resolve, 10));
}
await Promise.all(active);
const elapsed = (performance.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const percentile = fraction => latencies.length ? latencies[Math.ceil(latencies.length * fraction) - 1] : null;
console.log(JSON.stringify({
  schema: 'Pebble.HttpLoad.v1', started_at: startedAt, endpoint: `${url.origin}${url.pathname}`,
  target_rps: rps, requested_seconds: seconds, elapsed_seconds: elapsed,
  completed: latencies.length, achieved_rps: latencies.length / elapsed,
  dropped_by_load_generator: dropped, peak_inflight: peakInflight, errors, status_counts: statusCounts,
  transferred_bytes: bytes, latency_ms: { p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99) },
}, null, 2));
if (errors || dropped) process.exitCode = 1;
