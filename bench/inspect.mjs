import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const path = process.argv[2];
const t0 = performance.now();
const raw = zstdDecompressSync(readFileSync(path));
const t1 = performance.now();
const text = raw.toString('utf8');
const lines = text.split('\n').filter((l) => l.length > 0);
console.log(`decompress: ${(t1 - t0).toFixed(2)}ms  raw=${(raw.length / 1024).toFixed(0)}KB lines=${lines.length}`);
console.log('--- header ---');
console.log(lines[0].slice(0, 800));
const types = new Map();
for (let i = 1; i < lines.length; i++) {
  try {
    const e = JSON.parse(lines[i]);
    const k = `${e.type}/${e.subtype ?? ''}`;
    types.set(k, (types.get(k) ?? 0) + 1);
  } catch {
    types.set('<parse-error>', (types.get('<parse-error>') ?? 0) + 1);
  }
}
console.log('--- event types ---');
console.log([...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40));
console.log('--- samples (first 3 of each of interest) ---');
const want = new Map();
for (let i = 1; i < lines.length; i++) {
  let e;
  try { e = JSON.parse(lines[i]); } catch { continue; }
  const k = e.type;
  if (!['user/message', 'assistant/message', 'tool/call', 'tool/result', 'session/title', 'command/run'].includes(k)) continue;
  const n = want.get(k) ?? 0;
  if (n >= 2) continue;
  want.set(k, n + 1);
  console.log(`### ${k}`);
  console.log(lines[i].slice(0, 1200));
  console.log('');
}
