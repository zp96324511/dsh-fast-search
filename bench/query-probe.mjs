// P0 查询探针：两阶段查询（无 snippet）+ 召回真值对照
// 用法: node bench/query-probe.mjs <dbPath> [label]
import { DatabaseSync } from 'node:sqlite';

const DB = process.argv[2] ?? 'bench/out/s2.db';
const LABEL = process.argv[3] ?? 'probe';
const db = new DatabaseSync(DB, { readOnly: true });

const now = () => performance.now();
const CJK_CHAR = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const CJK_ALL = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;

const isCJK = (ch) => CJK_CHAR.test(ch);

/** 建索引时插入的空格：每个 CJK 字符前后各加一个空格 */
function cjkSpace(s) {
  return s.replace(CJK_ALL, (c) => ` ${c} `);
}

/** cjkSpace 的精确逆变换：去掉为每个 CJK 字符插入的那一个前导/后继空格 */
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

/** 用户输入 -> MATCH 表达式（每词一个引号短语，CJK 逐字拆开，空格即 AND） */
function toMatch(q) {
  return q.split(/\s+/).filter(Boolean).map((w) => {
    if (!CJK_CHAR.test(w)) return `"${w.replace(/"/g, '""')}"`;
    return `"${[...w].join(' ')}"`;
  }).join(' ');
}

/* 命中查询：取 top-N（不含 snippet） */
const stmtHits = db.prepare(
  `SELECT rowid AS rid, session_id, seq, type, role, time, bm25(docs) AS score
   FROM docs WHERE docs MATCH ? ORDER BY score LIMIT ?`,
);
const stmtTexts = db.prepare('SELECT rowid AS rid, text FROM docs WHERE rowid IN (SELECT value FROM json_each(?))');
const stmtText = db.prepare('SELECT text FROM docs WHERE rowid = ?');

/** 高亮：把命中词包成 [ ] 并取窗口，纯 JS，替代 FTS snippet() */
function snippetOf(raw, words, width = 160) {
  const lower = raw.toLowerCase();
  let best = -1;
  let bestWord = '';
  for (const w of words) {
    const i = lower.indexOf(w.toLowerCase());
    if (i >= 0 && (best < 0 || i < best)) { best = i; bestWord = w; }
  }
  if (best < 0) return { text: raw.slice(0, width), hit: false };
  const start = Math.max(0, best - Math.floor(width / 3));
  const end = Math.min(raw.length, start + width);
  const body = raw.slice(start, end);
  const marked = body.replace(
    new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi'),
    (m) => `[${m}]`,
  );
  return { text: (start > 0 ? '…' : '') + marked + (end < raw.length ? '…' : ''), hit: true };
}

function timeIt(fn, iters = 20) {
  const t = [];
  let out;
  for (let i = 0; i < iters; i++) {
    const a = now();
    out = fn();
    t.push(now() - a);
  }
  t.sort((a, b) => a - b);
  return { p50: +t[Math.floor(t.length / 2)].toFixed(2), p95: +t[Math.min(t.length - 1, Math.floor(t.length * 0.95))].toFixed(2), max: +t[t.length - 1].toFixed(2), out };
}

/** 真值：全表字面包含扫描 */
function groundTruth(word) {
  const scan = db.prepare('SELECT text FROM docs');
  let n = 0;
  for (const row of scan.iterate()) if (cjkUnspace(row.text).toLowerCase().includes(word.toLowerCase())) n++;
  return n;
}

const QUERIES = ['插件', '搜索', '会话', '索引', '基准', '工作区', 'PowerShell', 'session', 'nvm', '的', 'the'];
const rows = [];
for (const q of QUERIES) {
  const match = toMatch(q);
  const words = q.split(/\s+/).filter(Boolean);
  const hits = timeIt(() => stmtHits.all(match, 300));
  const top = hits.out.slice(0, 20);

  /* 两阶段：命中 + 取 20 条文本 + 重建 + 高亮 */
  const two = timeIt(() => {
    const r = stmtHits.all(match, 300);
    let out = '';
    for (const h of r.slice(0, 20)) {
      const row = stmtText.get(h.rid);
      if (!row) continue;
      const s = snippetOf(cjkUnspace(row.text), words);
      out += s.text;
    }
    return { n: r.length, out };
  });

  /* 批量取文本（json_each 一次查询） */
  const batch = timeIt(() => {
    const r = stmtHits.all(match, 300);
    const ids = JSON.stringify(r.slice(0, 20).map((h) => h.rid));
    return stmtTexts.all(ids).length;
  });

  rows.push({
    q, match,
    hits: hits.out.length,
    countOnlyP50: timeIt(() => db.prepare('SELECT count(*) c FROM docs WHERE docs MATCH ?').get(match), 5).p50,
    hitsP50: hits.p50, hitsP95: hits.p95,
    twoPhaseP50: two.p50, twoPhaseP95: two.p95,
    batch20P50: batch.p50,
    top1: snippetOf(cjkUnspace(top[0] ? stmtText.get(top[0].rid)?.text ?? '' : ''), words).text.slice(0, 120),
  });
}

console.log(`db=${DB} label=${LABEL}  docs=${db.prepare('SELECT count(*) c FROM docs').get().c}`);
console.table(rows.map((r) => ({ q: r.q, match: r.match, hits: r.hits, countP50: r.countOnlyP50, hitsP50: r.hitsP50, hitsP95: r.hitsP95, twoPhaseP50: r.twoPhaseP50, twoPhaseP95: r.twoPhaseP95 })));

/* ---- 召回真值对照 ---- */
console.log('\n--- FTS 召回 vs 全量字面扫描 ---');
const truth = [];
for (const q of ['索引', '基准', '插件', '工作区', 'dsh 插件']) {
  const a = now();
  const gt = groundTruth(q);
  const gtMs = now() - a;
  const fts = db.prepare('SELECT count(*) c FROM docs WHERE docs MATCH ?').get(toMatch(q)).c;
  truth.push({ q, fts, truth: gt, diff: fts - gt, gtScanMs: +gtMs.toFixed(0) });
}
console.table(truth);

console.log('\n--- 样例（前 120 字） ---');
for (const r of rows) console.log(`${r.q.padEnd(12)} ${r.top1.replace(/\n/g, ' ')}`);
