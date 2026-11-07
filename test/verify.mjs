/**
 * 端到端校验：索引召回 vs 全表字面扫描（真值），以及摘录还原是否正确。
 *
 *   node test/verify.mjs [--db .tmp/test.db]
 */

import path from 'node:path';
import { Store } from '../src/store.js';
import { cjkSpace, cjkUnspace, toMatch } from '../src/tokenize.js';

const dbArg = process.argv.indexOf('--db');
const dbPath = dbArg > 0 ? process.argv[dbArg + 1] : path.join('.tmp', 'test.db');

/* ---------- 1. 还原函数的往返一致性 ---------- */
const roundTrip = ['中文搜索', 'hello 世界', 'PowerShell 脚本', 'a中b', '  空格开头', '插件与索引'];
let roundTripOk = 0;
for (const sample of roundTrip) {
  const back = cjkUnspace(cjkSpace(sample));
  const ok = back === sample;
  if (ok) roundTripOk += 1;
  else console.log(`✗ 往返失败: ${JSON.stringify(sample)} → ${JSON.stringify(back)}`);
}
console.log(`还原往返：${roundTripOk}/${roundTrip.length}`);

/* ---------- 2. MATCH 表达式 ---------- */
for (const q of ['插件', 'dsh 插件', 'PowerShell', '索引 重建', 'C:\\data\\projects']) {
  console.log(`  ${JSON.stringify(q)} → ${toMatch(q)}`);
}

/* ---------- 3. 召回真值对照 ---------- */
const store = new Store(dbPath);
const words = ['插件', '搜索', '索引', '基准', '工作区', '会话', '面板', 'mmap'];

/*
 * 两套真值：
 * - literal：正文里字面出现（中文查询的理想值）；
 * - token：按 unicode61 的切分习惯（空白、`_`、`-` 都算边界）有一个 token 以它开头，
 *   对上了 ASCII 前缀查询（`"mmap"*`）的理想值。
 * `mmap` 这类词会命中 `mMap` 这种只共享字母前缀的标识符——那是前缀匹配的副作用，
 * 不是漏召回，所以 ASCII 词只跟 token 真值比。
 */
const ASCII = /^[\x20-\x7e]+$/;
const truthLiteral = new Map(words.map((w) => [w, 0]));
const truthToken = new Map(words.map((w) => [w, 0]));
/* 与 unicode61 一致：字母数字以外的都算边界（含全角标点、下划线、连字符） */
const SPLIT = /[^\p{L}\p{N}]+/u;

/* 索引一直在长（当前会话也在往里写），真值扫描和 FTS 计数要在同一个快照里比 */
store.db.exec('BEGIN');
for (const row of store.db.prepare('SELECT text FROM docs').iterate()) {
  const text = cjkUnspace(row.text).toLowerCase();
  const tokens = text.split(SPLIT).filter(Boolean);
  /* 中文有时会被写成「插 件」（日志里引用过短语本身），字面比较前先去掉空白 */
  const squashed = text.replace(/[\s\u3000]+/gu, '');
  for (const w of words) {
    const lower = w.toLowerCase();
    if (squashed.includes(lower)) truthLiteral.set(w, truthLiteral.get(w) + 1);
    if (tokens.some((t) => t.startsWith(lower))) truthToken.set(w, truthToken.get(w) + 1);
  }
}

console.log('\n召回对照：');
let allEqual = true;
for (const w of words) {
  const match = toMatch(w);
  const indexed = store.db.prepare('SELECT count(*) n FROM docs WHERE docs MATCH ?').get(match).n;
  const prefixed = ASCII.test(w) && w.length >= 3;
  const expected = (prefixed ? truthToken : truthLiteral).get(w);
  const mark = indexed === expected ? '✓' : '✗';
  if (indexed !== expected) allEqual = false;
  const note = prefixed ? `（前缀；字面 ${truthLiteral.get(w)}）` : '';
  console.log(
    `  ${mark} ${w.padEnd(6)} FTS ${String(indexed).padStart(6)}  真值 ${String(expected).padStart(6)} ${note}`,
  );
}
console.log(allEqual ? '召回全部相等' : '⚠ 召回有差异');
/* ---------- 4. 查询耗时与摘录 ---------- */
console.log('\n查询：');
for (const q of ['插件', '搜索', '索引', '工作区', 'PowerShell', 'mmap']) {
  const runs = [];
  let result;
  for (let i = 0; i < 5; i++) {
    result = store.search(q, { groupLimit: 20 });
    runs.push(result.took);
  }
  runs.sort((a, b) => a - b);
  const top = result.groups[0];
  const sample = top?.docs[0]?.snippet.map((s) => (s.mark ? `«${s.text}»` : s.text)).join('') ?? '';
  console.log(
    `  ${q.padEnd(10)} 命中 ${String(result.total).padStart(6)}  会话 ${String(result.groups.length).padStart(3)}  ` +
      `P50 ${runs[2].toFixed(2)}ms  ${sample.slice(0, 90)}`,
  );
}

/* ---------- 5. 边界：空查询 / 纯标点 / 不存在 ---------- */
store.db.exec('COMMIT');
console.log('\n边界：');
/* 随机串而不是固定词：日志本身也被索引了，固定词会被上一次校验的输出命中 */
const absent = `zz${Math.random().toString(36).slice(2, 10)}q`;
for (const q of ['', '   ', '!!!', absent]) {
  const r = store.search(q);
  console.log(`  ${JSON.stringify(q).padEnd(16)} → total ${r.total ?? 0}, empty=${r.empty ?? false}, error=${r.error ?? 'none'}`);
}

store.close();
