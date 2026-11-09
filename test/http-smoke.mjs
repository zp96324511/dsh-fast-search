#!/usr/bin/env node
/**
 * HTTP 冒烟测试：把 router 真挂到一个临时端口上，用真 HTTP 请求走一遍
 * `/status`、`/search`（三种语义模式）、`/vectors`、`/vectors/sync`、`/vectors/pause`。
 *
 * 不碰网络、不碰生产库、不碰会话目录：库在 `.tmp/http-smoke/`，
 * 嵌入器是假的（概念轴），所以它验的是**接线**（参数解析、状态机、降级），
 * 而不是 bge 的语义质量——那个由 `vectors-smoke` 的跨词召回用例覆盖。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { Store } from '../src/store.js';
import { VectorEngine } from '../src/vectors.js';
import { createHandler } from '../src/router.js';
import { hashText } from '../src/chunk.js';

const root = path.join(process.cwd(), '.tmp', 'http-smoke');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const dbPath = path.join(root, 'search.db');

/* 和 vectors-smoke 同款的假嵌入器：同义词落在同一根轴上 */
const DIM = 32;
const CONCEPTS = [
  ['缓存', 'cache', '加速', '预热', '命中率'],
  ['索引', '倒排', '重建', '全文'],
];
function fakeVector(text) {
  const vec = new Float32Array(DIM);
  const lower = String(text).toLowerCase();
  for (let axis = 0; axis < CONCEPTS.length; axis++) {
    if (CONCEPTS[axis].some((word) => lower.includes(word))) vec[axis] += 1;
  }
  let state = 7;
  for (let i = 0; i < lower.length; i++) state = (Math.imul(state, 31) + lower.charCodeAt(i)) >>> 0;
  for (let i = CONCEPTS.length; i < DIM; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    vec[i] = ((state >>> 9) % 1000) / 100000;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return vec;
}
const fakeEmbedder = {
  stats: { calls: 0, texts: 0 },
  async embedTexts(texts) {
    this.stats = { calls: this.stats.calls + 1, texts: this.stats.texts + texts.length };
    return texts.map(fakeVector);
  },
  async embedOne(text) {
    return fakeVector(text);
  },
  async probe() {
    return { ok: true, dim: DIM, ms: 0 };
  },
};

const store = new Store(dbPath);
store.replaceFile(path.join(root, 'a.jsonl.zstd'), {
  size: 100,
  mtimeMs: 1000,
  header: { id: 'session-http', cwd: 'C:\\work', createdAt: 1 },
  title: '缓存与预热',
  docs: [
    { seq: 1, kind: 'user/message', role: 'user', time: 1000, text: '会话日志的缓存命中率怎么提升，预热要多久' },
    { seq: 2, kind: 'assistant/message', role: 'assistant', time: 2000, text: '倒排索引重建要 24 秒，改成增量就够了' },
  ],
});
store.replaceFile(path.join(root, 'b.jsonl.zstd'), {
  size: 100,
  mtimeMs: 2000,
  header: { id: 'session-other', cwd: 'C:\\other', createdAt: 3000 },
  title: '别的工作区',
  docs: [
    { seq: 1, kind: 'user/message', role: 'user', time: 3000, text: '另一个工作区里的缓存笔记' },
  ],
});

const vectors = new VectorEngine({
  store,
  embedder: fakeEmbedder,
  log: () => {},
  config: {
    enabled: true,
    url: 'http://fake.invalid/v1/embeddings',
    model: 'fake-bge',
    dim: DIM,
    batch: 4,
    chunkChars: 200,
    kinds: ['user/message', 'assistant/message', 'session/title'],
  },
});

const indexer = {
  state: { phase: 'idle', done: 0, total: 0 },
  async syncAll() {
    return { indexed: 0 };
  },
};

const handler = createHandler({
  store,
  indexer,
  vectors,
  searchMode: 'auto',
  basePath: '/plugin-api/dsh-fast-search',
  sessionsDir: path.join(root, 'sessions'),
  dbPath,
  version: '9.9.9',
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  void handler(req, res, url.pathname).then((claimed) => {
    if (claimed === false && !res.writableEnded) {
      res.statusCode = 404;
      res.end('{"error":"not found"}');
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/plugin-api/dsh-fast-search`;

async function call(pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    process.stdout.write(`  ✗ ${name} — ${err.message}\n`);
    throw err;
  }
}

process.stdout.write('HTTP 接线\n');

await check('/status 带语义索引状态与默认模式', async () => {
  const res = await call('/status');
  assert.equal(res.status, 200);
  assert.equal(res.json.searchMode, 'auto');
  assert.equal(res.json.vectors.enabled, true);
  assert.equal(res.json.vectors.dim, DIM);
  assert.equal(res.json.vectors.chunks, 0);
});

await check('/vectors/sync 入队并真的建出向量', async () => {
  const res = await call('/vectors/sync', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(res.status, 202);
  assert.equal(res.json.started, true);
  const deadline = Date.now() + 5000;
  let chunks = 0;
  while (Date.now() < deadline) {
    const status = await call('/vectors');
    chunks = status.json.chunks ?? 0;
    if (chunks > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(chunks > 0, '建库没有产出向量');
});

await check('/search 默认 auto：全文稀疏时补语义', async () => {
  const res = await call('/search', { method: 'POST', body: JSON.stringify({ q: '加速' }) });
  assert.equal(res.status, 200);
  assert.equal(res.json.semantic.used, true);
  assert.equal(res.json.semantic.mode, 'auto');
  const docs = res.json.groups.flatMap((group) => group.docs);
  assert.ok(docs.some((doc) => doc.source === 'vec'), '没有纯语义命中');
});

await check('/search semantic:"off" 不碰向量', async () => {
  const res = await call('/search', { method: 'POST', body: JSON.stringify({ q: '加速', semantic: 'off' }) });
  assert.equal(res.json.semantic.used, false);
  assert.equal(res.json.semantic.reason, 'off');
  assert.equal(res.json.groups.length, 0);
});

await check('/search semantic:true 走 on 模式，全文命中少也融合', async () => {
  const res = await call('/search', { method: 'POST', body: JSON.stringify({ q: '缓存', semantic: true }) });
  assert.equal(res.json.semantic.used, true);
  assert.equal(res.json.semantic.mode, 'on');
  assert.ok(res.json.semantic.topScore > 0, '应带 topScore');
});

await check('/search 无关查询被 minScore 挡住', async () => {
  const res = await call('/search', { method: 'POST', body: JSON.stringify({ q: '今天天气怎么样', semantic: 'on' }) });
  assert.equal(res.json.semantic.used, false);
  assert.equal(res.json.semantic.reason, 'no-match');
});

await check('/workspaces 返回工作区、会话数与文档数', async () => {
  const res = await call('/workspaces');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.workspaces.map((item) => item.cwd), ['C:\\other', 'C:\\work']);
  const work = res.json.workspaces.find((item) => item.cwd === 'C:\\work');
  assert.equal(work.sessions, 1);
  assert.equal(work.docs, 2);
  assert.equal(work.updatedAt, 2000);
});

await check('/search 按工作区筛选（FTS total 与分组一起收窄）', async () => {
  const work = await call('/search', {
    method: 'POST',
    body: JSON.stringify({ q: '缓存', workspace: 'C:\\work', semantic: 'off' }),
  });
  assert.equal(work.status, 200);
  assert.equal(work.json.total, 1);
  assert.equal(work.json.groups.length, 1);
  assert.equal(work.json.groups[0].cwd, 'C:\\work');
  assert.equal(work.json.filters.workspace, 'C:\\work');

  const other = await call('/search', {
    method: 'POST',
    body: JSON.stringify({ q: '缓存', workspace: 'C:\\other', semantic: 'off' }),
  });
  assert.equal(other.json.total, 1);
  assert.equal(other.json.groups[0].sessionId, 'session-other');
});

await check('/search 时间范围：since / until / range 快捷档', async () => {
  const since = await call('/search', {
    method: 'POST',
    body: JSON.stringify({ q: '缓存', workspace: 'C:\\work', since: 1500, semantic: 'off' }),
  });
  assert.equal(since.json.total, 0, '1000ms 的文档应被 since 排除');
  assert.equal(since.json.filters.since, 1500);

  const until = await call('/search', {
    method: 'POST',
    body: JSON.stringify({ q: '缓存', workspace: 'C:\\work', until: 1500, semantic: 'off' }),
  });
  assert.equal(until.json.total, 1);
  assert.equal(until.json.filters.until, 1500);

  /* 测试数据在 1970 年，近 1 天必然为空——同时证明 range 真的换算成了 since */
  const range = await call('/search', {
    method: 'POST',
    body: JSON.stringify({ q: '缓存', range: '1d', semantic: 'off' }),
  });
  assert.equal(range.json.total, 0);
  assert.equal(range.json.filters.range, '1d');
  assert.ok(range.json.filters.since > 0);
});

await check('/search 语义召回也受工作区约束（打分前过滤）', async () => {
  const res = await call('/search', {
    method: 'POST',
    body: JSON.stringify({ q: '加速', workspace: 'C:\\other', semantic: 'on' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.semantic.used, true, '另一个工作区仍有语义命中');
  assert.equal(res.json.groups.length, 1);
  assert.equal(res.json.groups[0].cwd, 'C:\\other');
  for (const group of res.json.groups) assert.equal(group.cwd, 'C:\\other');
});

await check('/search 布尔组合：OR 与括号', async () => {
  const res = await call('/search', {
    method: 'POST',
    body: JSON.stringify({ q: '缓存 OR 倒排', semantic: 'off' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.total, 3);
  assert.equal(res.json.syntax, 'boolean');
  assert.deepEqual(res.json.terms, ['缓存', '倒排']);

  const both = await call('/search', {
    method: 'POST',
    body: JSON.stringify({ q: '缓存 AND 倒排', semantic: 'off' }),
  });
  assert.equal(both.json.total, 0, 'AND 必须落在同一条消息里');

  const broken = await call('/search', {
    method: 'POST',
    body: JSON.stringify({ q: '(缓存', semantic: 'off' }),
  });
  assert.equal(broken.status, 200, '语法错误也必须是 200');
  assert.equal(broken.json.parseError, 'unbalanced-paren');
  assert.equal(broken.json.total, 2, '降级为 AND 后仍能搜出东西');
});

await check('/vectors/pause 暂停与恢复', async () => {
  const paused = await call('/vectors/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
  assert.equal(paused.json.paused, true);
  const resumed = await call('/vectors/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });
  assert.equal(resumed.json.paused, false);
});

await check('向量未启用时 /vectors/sync 返回 409 而不是假装启动', async () => {
  const offEngine = new VectorEngine({ store, config: { enabled: false }, log: () => {} });
  const offHandler = createHandler({
    store,
    indexer,
    vectors: offEngine,
    searchMode: 'auto',
    basePath: '/plugin-api/dsh-fast-search',
    sessionsDir: root,
    dbPath,
    version: '9.9.9',
  });
  const offServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    void offHandler(req, res, url.pathname);
  });
  await new Promise((resolve) => offServer.listen(0, '127.0.0.1', resolve));
  const offPort = offServer.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${offPort}/plugin-api/dsh-fast-search/vectors/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 409);
  } finally {
    offServer.close();
  }
});

server.close();
store.close();
process.stdout.write(`http-smoke: ok (${passed} 项)\n`);
