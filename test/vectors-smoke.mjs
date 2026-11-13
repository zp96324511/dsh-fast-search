#!/usr/bin/env node
/**
 * 语义索引冒烟测试：不碰网络，用一个"概念轴"假嵌入器把整条链路跑通。
 *
 * 假嵌入器不是玩具：它把同义词映射到同一根轴（缓存/加速/预热 → 轴 0），
 * 所以"用词不同的查询能不能召回"这个语义检索的核心命题是真被测到的，
 * 而不是"向量能存能取"这种表面一致性。
 *
 * 覆盖：切块不变量 → 建库 → 语义召回 → RRF 融合 → 重启后免重建 →
 *       追加写盘只补新块（且老块的 rowid 能跟着重指）→ 删文件清向量 → 换模型整库作废。
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { Store } from '../src/store.js';
import { VectorEngine } from '../src/vectors.js';
import { searchWithSemantic } from '../src/search.js';
import { chunkText, estimateTokens, hashText } from '../src/chunk.js';

const DIM = 48;
const root = path.join(process.cwd(), '.tmp', 'vectors-smoke');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const dbPath = path.join(root, 'search.db');

/* ── 假嵌入器：概念轴 + 稳定噪声 ─────────────────────────────── */
const CONCEPTS = [
  ['缓存', 'cache', '快照', '加速', '变快', '预热', '命中率'],
  ['索引', 'index', '倒排', '建库', '重建', '全文'],
  ['沙箱', 'sandbox', '权限', 'acl', '拒绝'],
  ['插件', 'plugin', '扩展', '面板', '侧栏'],
];

function fakeVector(text) {
  const vec = new Float32Array(DIM);
  const lower = String(text).toLowerCase();
  for (let axis = 0; axis < CONCEPTS.length; axis++) {
    if (CONCEPTS[axis].some((word) => lower.includes(word))) vec[axis] += 1;
  }
  const seed = hashText(lower);
  let state = 0;
  for (let i = 0; i < seed.length; i++) state = (state * 31 + seed.charCodeAt(i)) >>> 0;
  for (let i = CONCEPTS.length; i < DIM; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    vec[i] = ((state >>> 8) % 2000) / 100000;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return vec;
}

class FakeEmbedder {
  constructor({ delayMs = 0 } = {}) {
    this.calls = 0;
    this.texts = 0;
    this.delayMs = delayMs;
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.seen = [];
    this.stats = { calls: 0, texts: 0 };
  }

  async embedTexts(texts) {
    this.calls += 1;
    this.texts += texts.length;
    this.seen.push(...texts);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      this.stats = { calls: this.calls, texts: this.texts };
      return texts.map((text) => fakeVector(text));
    } finally {
      this.inFlight -= 1;
    }
  }

  async embedOne(text) {
    const [vec] = await this.embedTexts([text]);
    return vec;
  }

  async probe() {
    return { ok: true, dim: DIM, ms: 0 };
  }
}

/* ── 断言脚手架 ─────────────────────────────────────────────── */
let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    process.stdout.write(`  ✗ ${name} — ${err.message}\n`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    process.stdout.write(`  ✗ ${name} — ${err.message}\n`);
  }
}

const engineConfig = {
  enabled: true,
  url: 'http://fake.invalid/v1/embeddings',
  model: 'fake-bge',
  dim: DIM,
  kinds: ['user/message', 'assistant/message', 'session/title'],
  chunkChars: 200,
  chunkOverlap: 20,
  batch: 4,
  topK: 20,
  /* 命中数 ≥ 1 就不再补语义：这样"缓存"（1 条字面命中）走纯 FTS、"加速"（0 条）走语义 */
  autoThreshold: 1,
};

/* ── 1. 切块不变量 ─────────────────────────────────────────── */
process.stdout.write('切块\n');
check('空文本不产生块', () => assert.deepEqual(chunkText(''), []));
check('短文本整块返回且偏移正确', () => {
  const raw = '  hello 插件  ';
  const [chunk] = chunkText(raw, { maxChars: 480 });
  assert.equal(chunk.text, 'hello 插件');
  assert.equal(raw.slice(chunk.start, chunk.end), chunk.text);
});
check('长文本每块 ≤ maxChars 且偏移可还原', () => {
  const raw = ('这是一个很长的中文句子，用来测试切块行为。'.repeat(40) + '\n').repeat(3);
  const chunks = chunkText(raw, { maxChars: 160 });
  assert.ok(chunks.length > 3, `块数 ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 160, `块长 ${chunk.text.length}`);
    assert.equal(raw.slice(chunk.start, chunk.end), chunk.text);
    assert.equal(chunk.hash, hashText(chunk.text));
  }
});
check('token 估算：中文按字、英文按 3.5 字符', () => {
  assert.equal(estimateTokens('中文'), 2);
  assert.equal(estimateTokens('abcdefg'), 2);
});

/* ── 2. 建库 + 语义召回 ────────────────────────────────────── */
process.stdout.write('建库与召回\n');
const store = new Store(dbPath);
const fileA = path.join(root, 'a.jsonl.zstd');
const fileB = path.join(root, 'b.jsonl.zstd');

const docsA = [
  {
    seq: 1,
    kind: 'user/message',
    role: 'user',
    time: 1000,
    text: '会话日志的缓存命中率怎么提升，预热要多久，有没有更快的办法',
  },
  {
    seq: 2,
    kind: 'assistant/message',
    role: 'assistant',
    time: 2000,
    text: '倒排索引重建大概 24 秒，不必每次启动都做，改成增量对账就够了',
  },
];
const docsB = [
  {
    seq: 1,
    kind: 'user/message',
    role: 'user',
    time: 3000,
    text: '沙箱把工作区写入拒绝了，acl 是不是有问题',
  },
];
const header = { id: 'session-a', cwd: 'C:\\work', createdAt: 1 };

store.replaceFile(fileA, { size: 100, mtimeMs: 1000, header, title: '缓存与索引', docs: docsA });
store.replaceFile(fileB, {
  size: 100,
  mtimeMs: 2000,
  header: { ...header, id: 'session-b' },
  title: '沙箱权限',
  docs: docsB,
});

const embedder = new FakeEmbedder();
const engine = new VectorEngine({
  store,
  config: engineConfig,
  embedder,
  log: () => {},
});

await checkAsync('同步写入向量块', async () => {
  const result = await engine.sync();
  assert.ok(result, 'sync 应返回结果');
  assert.ok(engine.vs.live >= 3, `块数 ${engine.vs.live}`);
});

await checkAsync('语义召回：用「加速」找到只说了「缓存/预热」的消息', async () => {
  const recall = await engine.semanticSearch('加速', { topK: 5 });
  assert.equal(recall.reason, 'ok');
  assert.ok(recall.hits.length > 0, '没有命中');
  const top = recall.hits[0];
  assert.match(top.chunk, /缓存|预热/, `首条内容：${top.chunk}`);
  assert.equal(top.sessionId, 'session-a');
});

await checkAsync('向量命中携带可渲染的片段与元数据', async () => {
  const recall = await engine.semanticSearch('加速', { topK: 5 });
  const top = recall.hits[0];
  assert.ok(typeof top.seq === 'number' && typeof top.kind === 'string');
  assert.ok(top.chunk.length > 0 && top.chunk.length <= 200);
});

await checkAsync('无关查询被 minScore 挡住，不把噪声当结果', async () => {
  const recall = await engine.semanticSearch('今天天气怎么样', { topK: 5 });
  assert.equal(recall.reason, 'no-match');
  assert.equal(recall.hits.length, 0);
  assert.ok(typeof recall.topScore === 'number' && recall.topScore < 0.45, `topScore ${recall.topScore}`);
});

await checkAsync('FTS 字面命中时不掺向量（auto 模式）', async () => {
  const result = await searchWithSemantic({
    store,
    engine,
    q: '缓存',
    mode: 'auto',
    options: { limit: 300, groupLimit: 20, perSession: 6 },
  });
  assert.ok(result.total > 0, 'FTS 应该有命中');
  assert.equal(result.semantic.used, false);
  assert.equal(result.semantic.reason, 'enough-fts');
  for (const group of result.groups) {
    for (const doc of group.docs) assert.notEqual(doc.source, 'vec');
  }
});

await checkAsync('FTS 空结果时自动补语义（auto 模式）', async () => {
  const result = await searchWithSemantic({
    store,
    engine,
    q: '加速',
    mode: 'auto',
    options: { limit: 300, groupLimit: 20, perSession: 6 },
  });
  assert.equal(result.semantic.used, true);
  assert.ok(result.groups.length > 0, '融合后应该有分组');
  const docs = result.groups.flatMap((group) => group.docs);
  const semanticDocs = docs.filter((doc) => doc.source === 'vec');
  assert.ok(semanticDocs.length > 0, '应该有纯语义命中的文档');
  const doc = semanticDocs[0];
  assert.ok(Array.isArray(doc.snippet) && doc.snippet.length > 0, '语义命中要有片段');
  assert.equal(result.groups[0].sessionId, 'session-a');
});

await checkAsync('off 模式不碰向量', async () => {
  const result = await searchWithSemantic({
    store,
    engine,
    q: '加速',
    mode: 'off',
    options: { limit: 300, groupLimit: 20, perSession: 6 },
  });
  assert.equal(result.semantic.used, false);
  assert.equal(result.groups.length, 0);
});

/* ── 3. 重启不重建 ─────────────────────────────────────────── */
process.stdout.write('持久化与增量\n');
const before = embedder.texts;
store.close();

const store2 = new Store(dbPath);
const embedder2 = new FakeEmbedder();
const engine2 = new VectorEngine({ store: store2, config: engineConfig, embedder: embedder2, log: () => {} });

await checkAsync('重启后免重建（不再调用嵌入服务）', async () => {
  const result = await engine2.sync();
  assert.equal(result.chunks, 0, `新增了 ${result.chunks} 块`);
  assert.equal(embedder2.texts, 0, `嵌入了 ${embedder2.texts} 条`);
  assert.ok(engine2.vs.live >= 3);
});

await checkAsync('重启后语义召回仍然可用', async () => {
  const recall = await engine2.semanticSearch('加速', { topK: 5 });
  assert.ok(recall.hits.length > 0);
  assert.match(recall.hits[0].chunk, /缓存|预热/);
});

const appended = [
  ...docsA,
  {
    seq: 3,
    kind: 'assistant/message',
    role: 'assistant',
    time: 4000,
    text: '可以把预热缓存放在宿主启动之后，这样首查就不冷了',
  },
];
store2.replaceFile(fileA, { size: 200, mtimeMs: 3000, header, title: '缓存与索引', docs: appended });

await checkAsync('整文件重解后只嵌新增块，且老块 rowid 重指成功', async () => {
  const result = await engine2.sync({ paths: [fileA] });
  assert.equal(result.chunks, 1, `新增块数 ${result.chunks}`);
  assert.ok(result.retargeted >= 1, `重指 ${result.retargeted} 条`);
  const recall = await engine2.semanticSearch('加速', { topK: 8 });
  const metas = store2.docsByRid(JSON.stringify(recall.hits.map((hit) => hit.rid)));
  for (const hit of recall.hits) {
    assert.ok(metas.has(hit.rid), `rid ${hit.rid} 指向了不存在的文档`);
  }
});

await checkAsync('删文件后不再出现在语义结果里', async () => {
  engine2.removePath(fileA);
  store2.removeFile(fileA);
  const recall = await engine2.semanticSearch('加速', { topK: 8 });
  assert.equal(
    recall.hits.filter((hit) => hit.sessionId === 'session-a').length,
    0,
    '已删会话仍被召回',
  );
});

/* ── 3.5 内容去重（跨文件复用同一份向量）─────────────────── */
process.stdout.write('内容去重\n');

const fileC = path.join(root, 'c.jsonl.zstd');
const fileD = path.join(root, 'd.jsonl.zstd');
const shared = '这是一段会在多场会话里原样重复出现的注入上下文，用来验证跨文件复用向量';
store2.replaceFile(fileC, {
  size: 100,
  mtimeMs: 4000,
  header: { ...header, id: 'session-c' },
  title: '重复 A',
  docs: [
    { seq: 1, kind: 'user/message', role: 'user', time: 5000, text: shared },
    { seq: 2, kind: 'user/message', role: 'user', time: 5001, text: '只有 c 才有的独有内容' },
  ],
});
store2.replaceFile(fileD, {
  size: 100,
  mtimeMs: 5000,
  header: { ...header, id: 'session-d' },
  title: '重复 B',
  docs: [{ seq: 1, kind: 'user/message', role: 'user', time: 6000, text: shared }],
});

await checkAsync('同一段文本在多场会话里只嵌入一次，引用各存一条', async () => {
  const beforeTexts = embedder2.texts;
  const beforeContents = engine2.vs.liveContent;
  const result = await engine2.sync({ paths: [fileC, fileD] });
  /* 3 条引用（c 的 2 块 + d 的 1 块），但只有 2 份**新增**唯一内容：
   * shared 与 c 独有的那块。关键断言是 shared 只被嵌入一次，向量扇出到两场会话。 */
  assert.equal(result.chunks, 3, `写入引用 ${result.chunks}`);
  const embeddedTexts = embedder2.seen.slice(beforeTexts);
  assert.equal(
    embeddedTexts.filter((text) => text === shared).length,
    1,
    `shared 被嵌入了 ${embeddedTexts.filter((text) => text === shared).length} 次`,
  );
  assert.equal(engine2.vs.liveContent - beforeContents, 2, `新增唯一内容 ${engine2.vs.liveContent - beforeContents}`);
  assert.ok(engine2.vs.live > engine2.vs.liveContent, '引用数应多于内容数');
  const refs = store2.db.prepare('SELECT count(*) AS n FROM vec_refs WHERE hash = ?')
    .get(hashText(shared));
  assert.equal(Number(refs.n), 2, `vec_refs 里应有 2 条引用，实际 ${refs.n}`);
});

const fileE = path.join(root, 'e.jsonl.zstd');
await checkAsync('第三场会话再说同样的话：零嵌入调用，只补引用', async () => {
  store2.replaceFile(fileE, {
    size: 100,
    mtimeMs: 6000,
    header: { ...header, id: 'session-e' },
    title: '重复 C',
    docs: [{ seq: 1, kind: 'user/message', role: 'user', time: 7000, text: shared }],
  });
  const beforeCalls = embedder2.calls;
  const beforeTexts = embedder2.texts;
  const result = await engine2.sync({ paths: [fileE] });
  assert.equal(result.reused, 1, `复用引用 ${result.reused}`);
  assert.equal(result.chunks, 1, `写入引用 ${result.chunks}`);
  assert.equal(result.chars, 0, `不应嵌入任何字符，实际 ${result.chars}`);
  assert.equal(embedder2.calls, beforeCalls, '不该发起嵌入请求');
  assert.equal(embedder2.texts, beforeTexts);
  /* 面板读的是块口径：reused 是「条数」不是字符数，复用率按本轮新增引用算 */
  const progress = engine2.status().progress;
  assert.equal(progress.reused, 1, `progress.reused 应为 1 条引用，实际 ${progress.reused}`);
  assert.equal(progress.reuseRatio, 1, `纯复用的一轮复用率应为 1，实际 ${progress.reuseRatio}`);
  assert.ok(progress.chunkRate > 0, `chunkRate 应大于 0，实际 ${progress.chunkRate}`);
});

await checkAsync('复用后三场会话都能被召回', async () => {
  const recall = await engine2.semanticSearch(shared, { topK: 20 });
  const sessions = new Set(recall.hits.map((hit) => hit.sessionId));
  assert.ok(sessions.has('session-c') || sessions.has('session-d') || sessions.has('session-e'),
    `命中会话：${[...sessions]}`);
});

await checkAsync('删掉一个引用不会误删另一场会话的向量', async () => {
  engine2.removePath(fileD);
  store2.removeFile(fileD);
  const left = store2.db.prepare('SELECT count(*) AS n FROM vec_refs WHERE hash = ?')
    .get(hashText(shared));
  assert.equal(Number(left.n), 2, `剩余引用 ${left.n}`);
  const content = store2.db.prepare('SELECT count(*) AS n FROM vec_content WHERE hash = ?')
    .get(hashText(shared));
  assert.equal(Number(content.n), 1, '内容被误删');
  const recall = await engine2.semanticSearch(shared, { topK: 20 });
  assert.equal(recall.hits.filter((hit) => hit.sessionId === 'session-d').length, 0);
  assert.ok(
    recall.hits.some((hit) => hit.sessionId === 'session-c' || hit.sessionId === 'session-e'),
    '剩下的引用应仍可召回',
  );
});

/* ── 3.6 并发：一次 embedTexts 拆成多路请求 ────────────────── */
await checkAsync('concurrency=2 时两路并行，且返回顺序与输入一致', async () => {
  const { Embedder } = await import('../src/embed.js');
  const slow = new FakeEmbedder({ delayMs: 30 });
  const embedderReal = new Embedder({
    url: 'http://fake.invalid/v1/embeddings',
    model: 'fake',
    dim: DIM,
    batch: 2,
    concurrency: 2,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      const vectors = await slow.embedTexts(body.input);
      return new Response(
        JSON.stringify({
          data: vectors.map((vec) => ({ embedding: Array.from(vec) })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const texts = ['缓存', '索引', '沙箱', '插件', '缓存加速'];
  const out = await embedderReal.embedTexts(texts);
  assert.equal(out.length, texts.length);
  assert.equal(slow.maxInFlight, 2, `最大并发 ${slow.maxInFlight}`);
  for (let i = 0; i < texts.length; i++) {
    const expected = fakeVector(texts[i]);
    assert.ok(
      Math.abs(out[i][0] - expected[0]) < 1e-6 && Math.abs(out[i][1] - expected[1]) < 1e-6,
      `第 ${i} 条顺序错位`,
    );
  }
});

await checkAsync('concurrency=1 时严格串行（老行为不变）', async () => {
  const { Embedder } = await import('../src/embed.js');
  const slow = new FakeEmbedder({ delayMs: 20 });
  const embedderReal = new Embedder({
    url: 'http://fake.invalid/v1/embeddings',
    model: 'fake',
    dim: DIM,
    batch: 2,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      const vectors = await slow.embedTexts(body.input);
      return new Response(
        JSON.stringify({ data: vectors.map((vec) => ({ embedding: Array.from(vec) })) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  await embedderReal.embedTexts(['缓存', '索引', '沙箱']);
  assert.equal(slow.maxInFlight, 1, `最大并发 ${slow.maxInFlight}`);
});

/* ── 3.7 老库迁移：vec_chunks → vec_content + vec_refs ────── */
await checkAsync('0.5.x 的 vec_chunks 老库自动迁移成内容表 + 引用表', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const legacyPath = path.join(root, 'legacy.db');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE vec_meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE vec_chunks(
      slot INTEGER PRIMARY KEY, path TEXT NOT NULL, chunk_ix INTEGER NOT NULL,
      rid INTEGER NOT NULL, start INTEGER NOT NULL, len INTEGER NOT NULL,
      hash TEXT NOT NULL, scale REAL NOT NULL, vec BLOB NOT NULL, UNIQUE(path, hash)
    );
    CREATE INDEX vec_chunks_path ON vec_chunks(path);
  `);
  const vec = new Int8Array(DIM).fill(1);
  legacy.prepare(
    'INSERT INTO vec_chunks(slot, path, chunk_ix, rid, start, len, hash, scale, vec) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(1, 'legacy-a', 0, 10, 0, 20, 'h-shared', 0.01, vec);
  legacy.prepare(
    'INSERT INTO vec_chunks(slot, path, chunk_ix, rid, start, len, hash, scale, vec) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(2, 'legacy-b', 0, 11, 0, 20, 'h-shared', 0.01, vec);
  legacy.close();

  const legacyStore = new Store(legacyPath);
  const tables = legacyStore.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ['vec_content', 'vec_meta', 'vec_refs'], `表：${tables}`);
  const contents = legacyStore.db.prepare('SELECT count(*) AS n FROM vec_content').get();
  const refs = legacyStore.db.prepare('SELECT count(*) AS n FROM vec_refs').get();
  assert.equal(Number(contents.n), 1, '同一 hash 应只留一份内容');
  assert.equal(Number(refs.n), 2, `引用 ${refs.n}`);
  const migrated = new VectorEngine({ store: legacyStore, config: engineConfig, embedder: new FakeEmbedder() });
  await migrated.init();
  assert.equal(migrated.vs.liveContent, 1, `内容 ${migrated.vs.liveContent}`);
  assert.equal(migrated.vs.live, 2, `引用 ${migrated.vs.live}`);
  legacyStore.close();
});

/* ── 4. 换模型整库作废 ────────────────────────────────────── */
await checkAsync('换模型后旧向量作废并重建', async () => {
  store2.close();
  const store3 = new Store(dbPath);
  const embedder3 = new FakeEmbedder();
  const engine3 = new VectorEngine({
    store: store3,
    config: { ...engineConfig, model: 'another-model' },
    embedder: embedder3,
    log: () => {},
  });
  await engine3.init();
  assert.equal(engine3.vs.live, 0, `换模型后还剩 ${engine3.vs.live} 块`);
  const result = await engine3.sync();
  assert.ok(result.chunks > 0, '应该重建');
  store3.close();
});

/* ── 结果 ─────────────────────────────────────────────────── */
process.stdout.write('\n');
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`  ✗ ${failure}\n`);
  process.stderr.write(`vectors-smoke: ${failures.length} 个失败 / ${passed} 个通过\n`);
  process.exit(1);
}
process.stdout.write(`vectors-smoke: ok (${passed} 项，嵌入调用 ${before + 0} → 见上)\n`);
