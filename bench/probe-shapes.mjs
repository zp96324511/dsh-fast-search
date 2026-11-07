import fs from 'node:fs';
import zlib from 'node:zlib';

const root = 'C:/Users/win10/.dsh/sessions';
const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
const wanted = new Set(['assistant/message', 'system/message']);
const shown = new Set();
for (const d of dirs) {
  const base = root + '/' + d.name;
  for (const s of fs.readdirSync(base, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    const p = base + '/' + s.name + '/session.v4.jsonl.zstd';
    if (!fs.existsSync(p)) continue;
    let txt;
    try {
      txt = zlib.zstdDecompressSync(fs.readFileSync(p)).toString('utf8');
    } catch {
      continue;
    }
    for (const line of txt.split('\n')) {
      const i = line.indexOf('"type":"');
      if (i < 0) continue;
      const t = line.slice(i + 8, line.indexOf('"', i + 8));
      if (wanted.has(t) && !shown.has(t)) {
        shown.add(t);
        console.log('=== ' + t + ' ===');
        console.log(line.slice(0, 900));
        console.log('');
      }
    }
    if (shown.size === wanted.size) process.exit(0);
  }
}
