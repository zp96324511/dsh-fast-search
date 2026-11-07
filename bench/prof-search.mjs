/** 拆解一次查询的耗时分布，找出两阶段实现里真正贵的部分。 */
import { Store } from '../src/store.js';
import { cjkSpace, cjkUnspace, toMatch, queryWords } from '../src/tokenize.js';
import { buildSnippet } from '../src/snippet.js';

const store = new Store('.tmp/test.db');
const { db, st } = store;

const t = (label, fn, runs = 7) => {
  const times = [];
  let out;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    out = fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(`  ${label.padEnd(30)} P50 ${times[Math.floor(runs / 2)].toFixed(2)}ms`);
  return out;
};

for (const q of ['索引', '插件', 'PowerShell', 'mmap']) {
  console.log(`\n${q}  (${toMatch(q)})`);
  const match = toMatch(q);
  const rows = t('hits (LIMIT 300)', () => st.hits.all(match, 300));
  t('count(*)', () => st.hitCount.get(match).n);
  const rids = rows.slice(0, 120).map((r) => r.rid);
  const json = JSON.stringify(rids);
  const texts = t('texts (120 ids)', () => st.texts.all(json));
  const raw = texts.map((r) => cjkUnspace(r.text));
  t('cjkUnspace (120 docs)', () => texts.map((r) => cjkUnspace(r.text)));
  const words = queryWords(q);
  t('snippet (120 docs)', () => raw.map((text) => buildSnippet(text, words)));
  t('sessionsById', () => st.sessionsById.all(JSON.stringify([...new Set(rows.map((r) => r.session_id))])));
  t('store.search (full)', () => store.search(q, { groupLimit: 20 }));
}

store.close();
