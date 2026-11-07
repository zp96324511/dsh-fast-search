// P0 调优矩阵：mmap/cache、LIMIT、bm25 排序 vs 不排序、逐条 vs 批量取文本
// 用法: node bench/query-tune.mjs bench/out/s2.db
import { DatabaseSync } from 'node:sqlite';

const DB = process.argv[2] ?? 'bench/out/s2.db';
const now = () => performance.now();
const CJK_CHAR = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const CJK_ALL = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;
const isCJK = (ch) => CJK_CHAR.test(ch);

function cjkUnspace(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (isCJK(ch) && out.endsWith(' ')) out = out.slice(0, -1);
    out += ch;
    if (isCJK(ch) && s[i + 1] === ' ') i++;
  }
  return out;
}
const toMatch = (q) => q.split(/\s+/).filter(Boolean).map((w) =>
  (!CJK_CHAR.test(w) ? `"${w.replace(/"/g, '""')}"` : `"${[...w].join(' ')}"`)).join(' ');

function pct(t) {
  t.sort((a, b) => a - b);
  return {
    p50: +t[Math.floor(t.length / 2)].toFixed(2),
    p95: +t[Math.min(t.length - 1, Math.floor(t.length * 0.95))].toFixed(2),
  };
}
function timeIt(fn, iters = 30) {
  const t = [];
  let out;
  for (let i = 0; i < iters; i++) {
    const a = now(); out = fn(); t.push(now() - a);
  }
  return { ...pct(t), out };
}

const QUERIES = ['插件', '搜索', '会话', '索引', '工作区', 'PowerShell', 'session', '的', 'the'];

function openDb(pragmas) {
  const db = new DatabaseSync(DB, { readOnly: true });
  for (const p of pragmas) db.exec(`PRAGMA ${p}`);
  return {
    db,
    hits: db.prepare(`SELECT rowid AS rid, session_id, seq, type, role, time, bm25(docs) AS score FROM docs WHERE docs MATCH ? ORDER BY score LIMIT ?`),
    hitsNoSort: db.prepare(`SELECT rowid AS rid, session_id, seq, type, role, time FROM docs WHERE docs MATCH ? LIMIT ?`),
    textOne: db.prepare('SELECT text FROM docs WHERE rowid = ?'),
    textBatch: db.prepare('SELECT rowid AS rid, text FROM docs WHERE rowid IN (SELECT value FROM json_each(?))'),
  };
}

const VARIANTS = [
  { label: 'default', pragmas: [] },
  { label: 'mmap256', pragmas: ['mmap_size=268435456'] },
  { label: 'mmap256+cache128', pragmas: ['mmap_size=268435456', 'cache_size=-131072'] },
];

const rows = [];
for (const v of VARIANTS) {
  const q = openDb(v.pragmas);
  for (const query of QUERIES) {
    const m = toMatch(query);
    const h300 = timeIt(() => q.hits.all(m, 300).length);
    const h100 = timeIt(() => q.hits.all(m, 100).length);
    const hNoSort = timeIt(() => q.hitsNoSort.all(m, 300).length);
    const batch = timeIt(() => {
      const r = q.hits.all(m, 300);
      return q.textBatch.all(JSON.stringify(r.slice(0, 20).map((x) => x.rid))).length;
    });
    const point = timeIt(() => {
      const r = q.hits.all(m, 300);
      let n = 0;
      for (const x of r.slice(0, 20)) if (q.textOne.get(x.rid)) n++;
      return n;
    });
    rows.push({
      variant: v.label, q: query,
      hits300: h300.p50, hits300p95: h300.p95,
      hits100: h100.p50, noSort: hNoSort.p50,
      batch20: batch.p50, point20: point.p50,
    });
  }
  q.db.close();
}

console.table(rows);
const byVariant = {};
for (const r of rows) {
  (byVariant[r.variant] ??= []).push(r.hits300);
}
for (const [k, v] of Object.entries(byVariant)) {
  v.sort((a, b) => a - b);
  console.log(`${k.padEnd(18)} hits300 中位数=${v[Math.floor(v.length / 2)].toFixed(2)}ms  max=${v[v.length - 1].toFixed(2)}ms`);
}
