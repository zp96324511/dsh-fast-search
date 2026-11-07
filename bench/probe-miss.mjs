import { DatabaseSync } from 'node:sqlite';
import { cjkUnspace } from '../src/tokenize.js';

const db = new DatabaseSync('.tmp/test.db');
const matched = new Set(
  db
    .prepare("SELECT rowid AS rid FROM docs WHERE docs MATCH '\"mmap\"'")
    .all()
    .map((r) => r.rid),
);
let missing = 0;
let shown = 0;
for (const row of db.prepare('SELECT rowid AS rid, text, kind FROM docs').iterate()) {
  const text = cjkUnspace(row.text);
  if (!text.toLowerCase().includes('mmap')) continue;
  if (matched.has(row.rid)) continue;
  missing += 1;
  if (shown++ < 6) {
    const at = text.toLowerCase().indexOf('mmap');
    console.log(`[${row.kind}] …${JSON.stringify(text.slice(Math.max(0, at - 40), at + 40))}`);
  }
}
console.log('missed:', missing);
