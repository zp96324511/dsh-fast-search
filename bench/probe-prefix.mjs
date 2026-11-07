/**
 * 前缀匹配的副作用核查：`"mmap"*` 命中的文档里，有多少是「token 以 mmap 开头」（真值），
 * 多少只是共享字母前缀的标识符（如 `mMap`、`mmapXxx`）。用于解释 verify.mjs 的差异。
 *
 *   node bench/probe-prefix.mjs [db] [word]
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cjkUnspace, toMatch } from '../src/tokenize.js';

const dbPath = process.argv[2] ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'storages', 'fast-search.db');
const word = process.argv[3] ?? 'mmap';

const db = new DatabaseSync(dbPath, { readOnly: true });
const pattern = /[\s\-_./\\:;()[\]{}+=*&|<>"',]+/;

const fts = new Set(db.prepare('SELECT rowid r FROM docs WHERE docs MATCH ?').all(toMatch(word)).map((row) => row.r));
const token = new Set();
for (const row of db.prepare('SELECT rowid r, text FROM docs').iterate()) {
  const text = cjkUnspace(row.text).toLowerCase();
  if (text.split(pattern).filter(Boolean).some((t) => t.startsWith(word.toLowerCase()))) token.add(row.r);
}

const extra = [...fts].filter((r) => !token.has(r));
console.log(`${word}: FTS ${fts.size} / token 真值 ${token.size} / 多出 ${extra.length}`);
for (const rid of extra.slice(0, 10)) {
  const row = db.prepare('SELECT text FROM docs WHERE rowid = ?').get(rid);
  const text = cjkUnspace(row.text);
  const at = text.toLowerCase().indexOf(word.toLowerCase());
  console.log('  ', JSON.stringify(text.slice(Math.max(0, at - 24), at + 28)));
}
db.close();
