/**
 * 向量索引：SQLite 存 int8 量化向量 + 进程内块状矩阵，语义检索走暴力点积。
 *
 * 为什么不用 sqlite-vec / 外部 ANN：插件跑在宿主的 `node:sqlite` 上，**扩展不能加载**
 * （没有 loadExtension），而引入 usearch/hnswlib 就破了「零依赖」这条发行约束。
 * 本机规模下也不需要 ANN：默认只嵌入 user/assistant/title（≈1.2 万条消息、约 5.6M 字符），
 * 切成块后 1.3 万级向量，1024 维 int8 暴力点积是毫秒级；即使把工具输出也纳入（11.7 万块），
 * 单次扫描也只有几十毫秒——而语义召回不在快路径上。
 *
 * 为什么存 int8：真实服务（bge-large）的分数精度远高于量化误差（余弦 1e-3 量级），
 * 而体积从 4KB/块降到 1KB/块——120MB vs 500MB，这是能不能常驻内存的分界线。
 *
 * 关键表：
 *   vec_meta   模型名 / 维度 / 切块版本 / 块长。任一变化 → 整库向量作废（向量不可迁移）。
 *   vec_content (hash PK) 存一份向量、vec_refs (path, hash) 存引用：
 *   同一段文本在多个会话里出现只占一份向量，整文件重解后只有**新内容**需要重新嵌入。
 *   内存按 4096 块一组放进独立的 Int8Array，扩容时只扩元数据数组，不拷贝向量本体。
 */

import { cjkUnspace } from './tokenize.js';
import { chunkText, CHUNKER_VERSION } from './chunk.js';
import { Embedder, quantize } from './embed.js';

/** 内存矩阵的分块大小（2 的幂，便于位运算）。 */
const BLOCK_SHIFT = 12;
const BLOCK_SIZE = 1 << BLOCK_SHIFT;
const BLOCK_MASK = BLOCK_SIZE - 1;

/** 默认配置；`index.js` 会把 patch 里的 `vectors` 覆盖上来。 */
export const DEFAULT_VECTORS = {
  enabled: false,
  url: '',
  apiKey: '',
  model: 'bge-large',
  dim: 1024,
  /** 嵌入哪些事件类型。默认只嵌对话正文和标题——工具输出占字符量的 86%，语义价值最低。 */
  kinds: ['user/message', 'assistant/message', 'session/title'],
  chunkChars: 480,
  chunkOverlap: 64,
  batch: 8,
  /**
   * 并发请求数。实测这台 bge 服务：1 路 ≈2.0k 字符/秒，2 路 ≈3.9k，4 路无增益，8 路 502。
   * 默认 1（老配置行为不变），服务扛得住时设 2。
   */
  concurrency: 1,
  /** 后台建库的字符预算（字符/分钟），0 = 不限速。 */
  maxCharsPerMinute: 0,
  /** FTS 命中少于这个数才自动补一轮语义召回。 */
  autoThreshold: 5,
  topK: 60,
  /**
   * 相关性门槛：**最佳分**低于它就整体不召回，单条再按 0.75×minScore 砍尾巴。
   * 0.45 来自实测分布（bge-large / 中文会话语料）：相关查询 top 0.57–0.71，
   * 无关查询 top 0.25–0.26，中间这段是安全区。设 0 可关掉门控（全量返回 topK 条）。
   */
  minScore: 0.45,
  sweepMs: 30 * 60 * 1000,
  timeoutMs: 120_000,
  queryCacheSize: 32,
  bootDelayMs: 8000,
};

/** 定长 top-k 小顶堆：只保留分数最高的 k 条，避免对十万级分数做全排序。 */
export class TopK {
  /** @param {number} k */
  constructor(k) {
    this.k = Math.max(0, Math.trunc(k));
    this.n = 0;
    this.scores = new Float64Array(this.k);
    this.items = new Int32Array(this.k);
  }

  /** @param {number} score @param {number} item */
  push(score, item) {
    if (this.k === 0) return;
    const { scores, items } = this;
    if (this.n < this.k) {
      let i = this.n++;
      scores[i] = score;
      items[i] = item;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (scores[parent] <= scores[i]) break;
        const s = scores[parent];
        const it = items[parent];
        scores[parent] = scores[i];
        items[parent] = items[i];
        scores[i] = s;
        items[i] = it;
        i = parent;
      }
      return;
    }
    if (score <= scores[0]) return;
    scores[0] = score;
    items[0] = item;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      if (left >= this.k) break;
      const right = left + 1;
      const child = right < this.k && scores[right] < scores[left] ? right : left;
      if (scores[child] >= scores[i]) break;
      const s = scores[child];
      const it = items[child];
      scores[child] = scores[i];
      items[child] = items[i];
      scores[i] = s;
      items[i] = it;
      i = child;
    }
  }

  /** @returns {Array<{ score: number, index: number }>} 分数降序 */
  list() {
    const out = [];
    for (let i = 0; i < this.n; i++) out.push({ score: this.scores[i], index: this.items[i] });
    out.sort((a, b) => b.score - a.score);
    return out;
  }
}

/** 向量矩阵：SQLite 是事实来源，内存是查询用的镜像。
 *
 * 0.6.0 起内存按「唯一内容」分配槽位：同一段文本只占一份向量，
 * 多个 `(path, hash)` 引用共享它。查询命中一次内容，再从引用里挑一条可展示的块。 */
export class VectorStore {
  /** @param {{ db: any, dim: number, log?: (msg: string) => void }} options */
  constructor({ db, dim, log = () => {} }) {
    this.db = db;
    this.dim = Math.max(1, Math.trunc(dim) || 1024);
    this.log = log;

    this.loaded = false;
    this.count = 0; // 已分配的内容槽位数（含孤儿墓碑）
    this.live = 0; // 引用总数（对外仍叫 chunks）
    this.liveContent = 0; // 有效内容数
    /** @type {Int8Array[]} */
    this.blocks = [];
    this.capacity = 0;
    /** @type {string[]} slot → hash；空串表示墓碑 */
    this.hashes = [];
    this.scales = new Float32Array(0);
    /** @type {Map<string, number>} hash → slot */
    this.hashSlots = new Map();
    /** @type {Map<string, Array<{ path: string, hash: string, chunkIx: number, rid: number,
     *                               start: number, len: number }>>} hash → 引用列表 */
    this.refsByHash = new Map();
    /** @type {Map<string, Map<string, any>>} path → (hash → 引用对象) */
    this.entriesByPath = new Map();

    this.st = {
      countContent: db.prepare('SELECT count(*) AS n FROM vec_content'),
      iterateContent: db.prepare('SELECT hash, scale, vec FROM vec_content ORDER BY rowid'),
      iterateRefs: db.prepare(
        'SELECT path, chunk_ix, rid, start, len, hash FROM vec_refs ORDER BY path, chunk_ix',
      ),
      insertContent: db.prepare(
        'INSERT OR IGNORE INTO vec_content(hash, scale, vec) VALUES (?, ?, ?)',
      ),
      insertRef: db.prepare(
        'INSERT OR IGNORE INTO vec_refs(path, chunk_ix, rid, start, len, hash) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
      ),
      delContent: db.prepare('DELETE FROM vec_content WHERE hash = ?'),
      delPath: db.prepare('DELETE FROM vec_refs WHERE path = ?'),
      delHashes: db.prepare(
        'DELETE FROM vec_refs WHERE path = ? AND hash IN (SELECT value FROM json_each(?))',
      ),
      updateSpan: db.prepare(
        'UPDATE vec_refs SET rid = ?, start = ?, len = ?, chunk_ix = ? WHERE path = ? AND hash = ?',
      ),
      pruneOrphans: db.prepare(
        'DELETE FROM vec_content WHERE hash NOT IN (SELECT hash FROM vec_refs)',
      ),
      delRefs: db.prepare('DELETE FROM vec_refs'),
      delContents: db.prepare('DELETE FROM vec_content'),
    };
  }

  /** 清空内存镜像（不动数据库）。 */
  #reset() {
    this.count = 0;
    this.live = 0;
    this.liveContent = 0;
    this.blocks = [];
    this.capacity = 0;
    this.hashes = [];
    this.scales = new Float32Array(0);
    this.hashSlots = new Map();
    this.refsByHash = new Map();
    this.entriesByPath = new Map();
  }

  get size() {
    return this.live;
  }

  /** 扩容时只扩元数据数组；向量本体按块惰性分配，永不整体拷贝。 */
  #ensure(n) {
    if (n <= this.capacity) return;
    let capacity = Math.max(1024, this.capacity);
    while (capacity < n) capacity *= 2;
    const grow = (old, Type) => {
      const next = new Type(capacity);
      next.set(old);
      return next;
    };
    this.scales = grow(this.scales, Float32Array);
    this.capacity = capacity;
  }

  /** @param {number} i */
  #blockFor(i) {
    const at = i >> BLOCK_SHIFT;
    let block = this.blocks[at];
    if (block === undefined) {
      block = new Int8Array(BLOCK_SIZE * this.dim);
      this.blocks[at] = block;
    }
    return block;
  }

  /** 追加一份唯一内容：分配矩阵槽位，并登记 hash → slot。 */
  #appendContent(hash, scale, data) {
    const slot = this.count++;
    this.#ensure(slot + 1);
    this.hashes[slot] = hash;
    this.scales[slot] = scale;
    this.#blockFor(slot).set(data, (slot & BLOCK_MASK) * this.dim);
    this.hashSlots.set(hash, slot);
    this.liveContent += 1;
    return slot;
  }

  /** 追加一条引用：同一内容可以被多个 (path, hash) 指向。 */
  #appendRef(path, chunkIx, rid, start, len, hash) {
    if (!this.hashSlots.has(hash)) return false;
    const ref = { path, hash, chunkIx, rid, start, len };
    let map = this.entriesByPath.get(path);
    if (map === undefined) {
      map = new Map();
      this.entriesByPath.set(path, map);
    }
    map.set(hash, ref);
    let refs = this.refsByHash.get(hash);
    if (refs === undefined) {
      refs = [];
      this.refsByHash.set(hash, refs);
    }
    refs.push(ref);
    this.live += 1;
    return true;
  }

  /** 内容不再被任何引用需要时：删库、标墓碑。 */
  #removeContent(hash) {
    const slot = this.hashSlots.get(hash);
    if (slot === undefined) return;
    this.hashSlots.delete(hash);
    this.hashes[slot] = '';
    this.liveContent -= 1;
    this.st.delContent.run(hash);
  }

  /** 摘掉一条引用；最后一个引用消失时顺手回收内容。 */
  #removeRef(ref) {
    const map = this.entriesByPath.get(ref.path);
    if (map !== undefined) {
      map.delete(ref.hash);
      if (map.size === 0) this.entriesByPath.delete(ref.path);
    }
    const refs = this.refsByHash.get(ref.hash);
    if (refs !== undefined) {
      const at = refs.indexOf(ref);
      if (at !== -1) refs.splice(at, 1);
      if (refs.length === 0) {
        this.refsByHash.delete(ref.hash);
        this.#removeContent(ref.hash);
      }
    }
    this.live -= 1;
  }

  /** 从引用列表里挑一条：优先允许的（筛选后）里 rid 最大的，近似「最新出现的会话」。 */
  #refFor(refs, accept) {
    let best = null;
    for (const ref of refs) {
      if (accept !== null && !accept(ref.rid)) continue;
      if (best === null || ref.rid > best.rid) best = ref;
    }
    return best;
  }

  /** 从 SQLite 全量载入内存（首次查询 / 压缩墓碑时调用）。 */
  load() {
    if (this.loaded) return this;
    /* 没有引用的内容是 0.5.x 删除路径留下的孤儿；先清掉，别占矩阵 */
    this.st.pruneOrphans.run();
    const total = this.st.countContent.get().n;
    this.#reset();
    this.#ensure(total);
    for (const row of this.st.iterateContent.iterate()) {
      const slot = this.count++;
      this.hashes[slot] = row.hash;
      this.scales[slot] = row.scale;
      this.#blockFor(slot).set(row.vec, (slot & BLOCK_MASK) * this.dim);
      this.hashSlots.set(row.hash, slot);
      this.liveContent += 1;
    }
    for (const row of this.st.iterateRefs.iterate()) {
      this.#appendRef(row.path, row.chunk_ix, row.rid, row.start, row.len, row.hash);
    }
    this.loaded = true;
    return this;
  }

  /** 这段文本是否已经有向量（跨文件复用）。 */
  hasContent(hash) {
    if (!this.loaded) this.load();
    return this.hashSlots.has(hash);
  }

  /** @param {string} file */
  hashesFor(file) {
    const map = this.entriesByPath.get(file);
    return map === undefined ? null : map;
  }

  /** 删掉某个文件里不再需要的块（文件被改写后块边界会变）。 */
  retainHashes(file, keep) {
    const map = this.entriesByPath.get(file);
    if (map === undefined) return 0;
    const wanted = keep instanceof Set
      ? keep
      : new Set(keep instanceof Map ? keep.keys() : keep);
    const stale = [];
    for (const [hash, ref] of map) {
      if (!wanted.has(hash)) stale.push({ hash, ref });
    }
    if (stale.length === 0) return 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.st.delHashes.run(file, JSON.stringify(stale.map((item) => item.hash)));
      for (const { ref } of stale) this.#removeRef(ref);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      this.loaded = false;
      this.load();
      throw err;
    }
    this.maybeCompact();
    return stale.length;
  }

  /**
   * 整文件重解后，同一条文本的 rowid 会变（先删后插），引用必须跟着改指向，
   * 否则语义命中会指向一条已经不存在的文档。
   * @param {string} file
   * @param {Map<string, { rid: number, start: number, len: number, chunkIx: number }>} spans
   */
  updateSpans(file, spans) {
    const map = this.entriesByPath.get(file);
    if (map === undefined) return 0;
    let changed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [hash, ref] of map) {
        const next = spans.get(hash);
        if (next === undefined) continue;
        if (ref.rid === next.rid && ref.start === next.start && ref.len === next.len) continue;
        this.st.updateSpan.run(next.rid, next.start, next.len, next.chunkIx, file, hash);
        ref.rid = next.rid;
        ref.start = next.start;
        ref.len = next.len;
        ref.chunkIx = next.chunkIx;
        changed += 1;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return changed;
  }

  /**
   * 写入一批块。同一段文本（hash）只存一份向量：库里已有的直接复用，
   * 只有新内容才需要 `data` / `scale`。
   * @param {Array<{ path: string, chunkIx: number, rid: number, start: number, len: number,
   *                  hash: string, data?: Int8Array, scale?: number }>} rows
   * @returns {number} 写入的引用条数
   */
  insertMany(rows) {
    if (rows.length === 0) return 0;
    let written = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const map = this.entriesByPath.get(row.path);
        if (map !== undefined && map.has(row.hash)) continue;
        if (!this.hashSlots.has(row.hash)) {
          if (row.data === undefined || !Number.isFinite(row.scale)) continue;
          this.st.insertContent.run(row.hash, row.scale, row.data);
          this.#appendContent(row.hash, row.scale, row.data);
        }
        this.st.insertRef.run(
          row.path,
          row.chunkIx,
          row.rid,
          row.start,
          row.len,
          row.hash,
        );
        this.#appendRef(row.path, row.chunkIx, row.rid, row.start, row.len, row.hash);
        written += 1;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      /* 内存已经加了一半，直接重载保持与磁盘一致 */
      this.loaded = false;
      this.load();
      throw err;
    }
    return written;
  }

  /** @param {string} file 删除一个文件的全部向量（文件消失时用）。 */
  removePath(file) {
    const map = this.entriesByPath.get(file);
    if (map === undefined) return 0;
    const n = map.size;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.st.delPath.run(file);
      for (const ref of [...map.values()]) this.#removeRef(ref);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      this.loaded = false;
      this.load();
      throw err;
    }
    this.maybeCompact();
    return n;
  }

  /** 墓碑过半就重载一次：SQLite 里没有墓碑，重载即压缩。 */
  maybeCompact() {
    if (!this.loaded) return;
    if (this.count >= 4096 && this.liveContent * 2 < this.count) {
      this.loaded = false;
      this.load();
      this.log(
        `[fast-search] 向量索引压缩：${this.count} 份内容 → ${this.liveContent} 份有效（${this.live} 条引用）`,
      );
    }
  }

  /** 清空整个向量库（模型/维度/切块版本变化时）。 */
  clear() {
    this.st.delRefs.run();
    this.st.delContents.run();
    this.#reset();
    this.loaded = true;
  }

  /**
   * 暴力点积 top-k。
   * 每个唯一内容只算一次；命中后再从它的引用里挑一条（受筛选约束）作为展示位置。
   * @param {Int8Array} query 量化后的查询向量
   * @param {number} queryScale
   * @param {number} k
   * @param {((rid: number) => boolean) | null} [accept] 打分前的 rowid 过滤（工作区/时间范围）
   */
  search(query, queryScale, k, accept = null) {
    if (!this.loaded) this.load();
    const dim = this.dim;
    const top = new TopK(k);
    const count = this.count;
    for (let i = 0; i < count; i++) {
      const hash = this.hashes[i];
      if (hash === '' || hash === undefined) continue;
      const refs = this.refsByHash.get(hash);
      if (refs === undefined || refs.length === 0) continue;
      /* 先挑出可展示的引用再算点积：范围外/已删的块连乘加都不做 */
      const ref = this.#refFor(refs, accept);
      if (ref === null) continue;
      const block = this.blocks[i >> BLOCK_SHIFT];
      const offset = (i & BLOCK_MASK) * dim;
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += block[offset + d] * query[d];
      top.push(dot * this.scales[i] * queryScale, i);
    }
    const out = [];
    for (const { score, index } of top.list()) {
      const ref = this.#refFor(this.refsByHash.get(this.hashes[index]) ?? [], accept);
      if (ref === null) continue;
      out.push({
        score,
        index,
        hash: this.hashes[index],
        rid: ref.rid,
        path: ref.path,
        start: ref.start,
        len: ref.len,
        chunkIx: ref.chunkIx,
      });
    }
    return out;
  }

  stats() {
    return {
      /* 对外仍报引用数（用户关心的是「多少块被索引」），内容数是去重后的真实占用 */
      chunks: this.live,
      contents: this.liveContent,
      slots: this.count,
      dim: this.dim,
      bytes: this.liveContent * (this.dim + 4),
    };
  }
}

/** 读 vec_meta 全表。 */
function readMeta(db) {
  const out = Object.create(null);
  for (const row of db.prepare('SELECT key, value FROM vec_meta').iterate()) out[row.key] = row.value;
  return out;
}

/**
 * 向量引擎：后台「文档 → 块 → 嵌入 → 入库」流水线 + 查询侧一次语义召回。
 * 宿主启动、增量索引、面板轮询都只看它的 {@link status}。
 */
export class VectorEngine {
  /**
   * @param {{ store: import('./store.js').Store, config?: Record<string, any>,
   *           log?: (msg: string) => void,
   *           embedder?: { embedTexts: (t: string[]) => Promise<Float32Array[]>,
   *                         embedOne: (t: string) => Promise<Float32Array>, probe: () => Promise<any>,
   *                         stats?: Record<string, number> } }} options
   */
  constructor({ store, config = {}, log = () => {}, embedder = null }) {
    this.store = store;
    this.log = log;
    this.config = { ...DEFAULT_VECTORS, ...(config && typeof config === 'object' ? config : {}) };
    this.config.kinds = Array.isArray(this.config.kinds) && this.config.kinds.length > 0
      ? this.config.kinds.map(String)
      : [...DEFAULT_VECTORS.kinds];
    this.kindsJson = JSON.stringify(this.config.kinds);

    this.vs = null;
    this.ready = false;
    this.probeResult = null;
    this.lastError = null;
    this.syncing = null;
    this.pendingPaths = new Set();
    this.flushTimer = null;
    this.timer = null;
    this.stopped = false;
    this.paused = false;
    this.docsTotalCache = { value: 0, at: 0 };
    this.state = {
      phase: 'idle',
      scanned: 0,
      docsTotal: 0,
      chunks: 0,
      chunksTotal: 0,
      chars: 0,
      charsTotal: 0,
      embedded: 0,
      reused: 0,
      rate: 0,
      etaMs: 0,
      startedAt: 0,
      finishedAt: 0,
    };
    this.queryCache = new Map();

    this.embedder = embedder ?? (this.enabled
      ? new Embedder({
          url: this.config.url,
          model: this.config.model,
          apiKey: this.config.apiKey,
          dim: this.config.dim,
          batch: this.config.batch,
          concurrency: this.config.concurrency,
          timeoutMs: this.config.timeoutMs,
          log,
        })
      : null);
  }

  get enabled() {
    return this.config.enabled === true && typeof this.config.url === 'string' && this.config.url !== '';
  }

  /** 建表/校验 meta/载入内存。多次调用幂等。 */
  async init() {
    if (!this.enabled) return this;
    if (this.vs === null) {
      this.vs = new VectorStore({ db: this.store.db, dim: this.config.dim, log: this.log });
    }
    const meta = readMeta(this.store.db);
    const want = {
      model: String(this.config.model ?? ''),
      dim: String(this.config.dim ?? ''),
      chunker: String(CHUNKER_VERSION),
      chunkChars: String(this.config.chunkChars ?? ''),
    };
    const mismatch = Object.keys(want).filter(
      (key) => meta[key] !== undefined && meta[key] !== want[key],
    );
    if (mismatch.length > 0) {
      /* 向量不可迁移：换模型/换维度/换切块都要整库重算，否则距离没有意义 */
      this.log(
        `[fast-search] 向量索引作废（${mismatch.map((k) => `${k}: ${meta[k]} → ${want[k]}`).join(', ')}）`,
      );
      this.store.db.exec('DELETE FROM vec_refs');
      this.store.db.exec('DELETE FROM vec_content');
      this.store.db.exec('DELETE FROM vec_meta');
    }
    const setMeta = this.store.db.prepare(
      'INSERT INTO vec_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [key, value] of Object.entries({ ...want, url: String(this.config.url ?? '') })) {
      setMeta.run(key, value);
    }
    this.vs.load();
    this.ready = true;
    return this;
  }

  /** 探活：确认地址/鉴权/维度，顺便校准配置里的维度（服务端说了算）。 */
  async probe() {
    if (this.embedder === null) return { ok: false, error: '未配置嵌入服务' };
    if (this.probeResult !== null) return this.probeResult;
    const result = await this.embedder.probe();
    if (result.ok === true && Number.isFinite(result.dim) && result.dim > 0) {
      if (result.dim !== Number(this.config.dim)) {
        this.log(`[fast-search] 服务端维度 ${result.dim} 与配置 ${this.config.dim} 不符，按服务端为准`);
        this.config.dim = result.dim;
        this.vs = null; // 下一轮 init 用新维度重建，meta 不符会清空旧向量
        this.ready = false;
      }
    } else {
      this.lastError = result.error ?? '探活失败';
    }
    this.probeResult = result;
    return result;
  }

  /** 起后台构建：启动后延迟一轮，之后按 sweepMs 兜底。 */
  start({ bootDelayMs, sweepMs } = {}) {
    if (!this.enabled || this.timer !== null) return;
    const delay = Number.isFinite(bootDelayMs) ? bootDelayMs : this.config.bootDelayMs;
    const every = Number.isFinite(sweepMs) ? sweepMs : this.config.sweepMs;
    const kick = setTimeout(() => {
      void this.sync().catch((err) => {
        this.lastError = String(err?.message ?? err);
      });
    }, Math.max(1000, delay));
    kick.unref?.();
    if (every > 0) {
      this.timer = setInterval(() => {
        if (this.syncing !== null || this.paused) return;
        void this.sync().catch(() => {});
      }, every);
      this.timer.unref?.();
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /** 暂停/恢复后台建库（不删数据）。 */
  setPaused(value) {
    this.paused = value === true;
    if (this.paused === false) void this.sync().catch(() => {});
    return this.paused;
  }

  /**
   * 索引器通知：某个文件刚被重解完，把它缺的块补上。
   * 防抖 600ms——一次写盘会连着触发好几个文件事件。
   * @param {string} file
   */
  queuePath(file) {
    if (!this.enabled) return;
    this.pendingPaths.add(file);
    this.#scheduleFlush();
  }

  #scheduleFlush() {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    /* 定期维护一轮就好；正在跑建库时别每 600ms 空转一次，拉长到 2s 再看 */
    const delay = this.syncing !== null || this.paused ? 2000 : 600;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const paths = [...this.pendingPaths];
      this.pendingPaths.clear();
      if (paths.length === 0) return;
      if (this.syncing !== null || this.paused) {
        /* 正在跑就攒着，等这一轮结束再来 */
        for (const file of paths) this.pendingPaths.add(file);
        this.#scheduleFlush();
        return;
      }
      void this.sync({ paths }).catch((err) => {
        this.lastError = String(err?.message ?? err);
      });
    }, delay);
    this.flushTimer.unref?.();
  }

  /** 文件被删除：清掉它的向量，别让已删会话继续出现在语义结果里。 */
  removePath(file) {
    if (!this.enabled || this.vs === null || !this.vs.loaded) return 0;
    try {
      return this.vs.removePath(file);
    } catch (err) {
      this.lastError = String(err?.message ?? err);
      return 0;
    }
  }

  /**
   * 后台对账：遍历目标文档 → 切块 → 比 hash → 只嵌入缺失的块。
   * @param {{ paths?: string[] | null, force?: boolean, maxChars?: number }} [options]
   */
  sync(options = {}) {
    if (!this.enabled) return Promise.resolve(null);
    if (this.syncing !== null) return this.syncing;
    this.syncing = this.#run(options).finally(() => {
      this.syncing = null;
      /* 建库期间攒下的文件路径：这一轮结束立刻补上，不必等 30 分钟的兜底轮次 */
      if (this.pendingPaths.size > 0 && !this.stopped && !this.paused) this.#scheduleFlush();
    });
    return this.syncing;
  }

  /** @param {{ paths?: string[] | null, force?: boolean, maxChars?: number }} options */
  async #run({ paths = null, force = false, maxChars = 0 }) {
    const probe = await this.probe();
    if (probe.ok !== true) {
      this.state.phase = 'error';
      throw new Error(String(probe.error ?? '嵌入服务不可用'));
    }
    await this.init();
    const vs = this.vs;
    if (vs === null) return null;
    if (force === true) {
      vs.clear();
      this.queryCache.clear();
    }

    const started = Date.now();
    const state = this.state;
    const scoped = Array.isArray(paths) && paths.length > 0;
    Object.assign(state, {
      phase: 'scanning',
      scanned: 0,
      docsTotal: 0,
      chunks: vs.live,
      chunksTotal: vs.live,
      chars: 0,
      charsTotal: 0,
      embedded: 0,
      rate: 0,
      etaMs: 0,
      startedAt: started,
      finishedAt: 0,
    });
    this.lastError = null;

    /* ① 扫描：切块 + 比对 hash。这一步纯 CPU，不花钱。
     *    注意去重是**两层**的：文件内按 hash 去重（块边界重叠会产出同一段文本），
     *    跨文件/跨会话也按 hash 去重（会话开头的注入上下文、fork 出来的历史几乎全重复）。 */
    /** @type {Array<{ path: string, chunkIx: number, rid: number, start: number, len: number,
     *                 hash: string }>} */
    const missing = [];
    const keepByPath = new Map();
    /** @type {Map<string, { hash: string, text: string, refs: any[] }>} */
    const groups = new Map();
    let docs = 0;

    const rows = scoped
      ? this.store.docsForPaths(JSON.stringify(paths))
      : this.store.iterateDocsForKinds(this.kindsJson);

    for (const doc of rows) {
      docs += 1;
      state.scanned = docs;
      const text = cjkUnspace(doc.text);
      const chunks = chunkText(text, {
        maxChars: this.config.chunkChars,
        overlap: this.config.chunkOverlap,
      });
      let keep = keepByPath.get(doc.path);
      if (keep === undefined) {
        keep = new Map();
        keepByPath.set(doc.path, keep);
      }
      const known = vs.hashesFor(doc.path);
      for (let ix = 0; ix < chunks.length; ix++) {
        const chunk = chunks[ix];
        if (keep.has(chunk.hash)) continue;
        const span = { rid: doc.rid, start: chunk.start, len: chunk.end - chunk.start, chunkIx: ix };
        keep.set(chunk.hash, span);
        if (known !== null && known.has(chunk.hash)) continue;
        const ref = { path: doc.path, ...span, hash: chunk.hash };
        missing.push(ref);
        let group = groups.get(chunk.hash);
        if (group === undefined) groups.set(chunk.hash, (group = { hash: chunk.hash, text: chunk.text, refs: [] }));
        group.refs.push(ref);
      }
    }

    /* ② 清理 + 重指：整文件重解后 rowid 会变（先删后插），
     *    同一条文本的引用必须跟着改指向，否则语义命中指向一条不存在的文档。 */
    let pruned = 0;
    let retargeted = 0;
    for (const [file, keep] of keepByPath) {
      pruned += vs.retainHashes(file, keep);
      retargeted += vs.updateSpans(file, keep);
    }

    /* ②.5 内容复用：这段文本库里已经有向量（别的会话说过一模一样的话），
     *     只补引用、不再请求嵌入服务。 */
    const reuseRows = [];
    const todo = [];
    let reusedChars = 0;
    for (const group of groups.values()) {
      if (vs.hasContent(group.hash)) {
        for (const ref of group.refs) reuseRows.push(ref);
        reusedChars += group.text.length * group.refs.length;
      } else {
        todo.push(group);
      }
    }

    const totalChars = todo.reduce((sum, group) => sum + group.text.length, 0);
    state.docsTotal = docs;
    /* 目标块数按「本轮开始时的块数 + 全部新增引用」算，且必须在补复用引用之前定下来，
     * 否则复用那部分会被算两遍（vs.live 已经把它们加进去了） */
    state.chunksTotal = vs.live + missing.length;
    state.charsTotal = totalChars;
    state.reused = reusedChars;
    if (reuseRows.length > 0) vs.insertMany(reuseRows);
    state.chunks = vs.live;

    if (missing.length === 0) {
      state.phase = 'idle';
      state.finishedAt = Date.now();
      this.log(
        `[fast-search] 向量索引已最新：${vs.live} 块 / ${docs} 条文档 / ${Date.now() - started}ms`,
      );
      return {
        chunks: 0,
        live: vs.live,
        contents: vs.liveContent,
        docs,
        pruned,
        retargeted,
        reused: 0,
        ms: Date.now() - started,
      };
    }

    /* ③ 嵌入：一次喂 batch×concurrency 条，Embedder 内部拆成并发请求。
     *    只嵌「库里还没有的内容」，同一段文本在多场会话里出现也只嵌一次。 */
    state.phase = 'embedding';
    const batch = Math.max(1, Math.trunc(this.config.batch) || 8);
    const lanes = Math.max(1, Math.min(4, Math.trunc(this.config.concurrency) || 1));
    const window = batch * lanes;
    const ratePerMinute = Number(this.config.maxCharsPerMinute) || 0;
    const limit = maxChars > 0 ? maxChars : Infinity;
    let charsDone = 0;
    let embedded = reuseRows.length;

    for (let at = 0; at < todo.length; at += window) {
      if (this.stopped || this.paused) break;
      if (charsDone >= limit) break;
      const slice = todo.slice(at, at + window);
      let vectors;
      try {
        vectors = await this.embedder.embedTexts(slice.map((group) => group.text));
      } catch (err) {
        state.phase = 'error';
        this.lastError = String(err?.message ?? err);
        throw err;
      }
      const rowsOut = [];
      for (let i = 0; i < slice.length; i++) {
        const group = slice[i];
        const { data, scale } = quantize(vectors[i]);
        for (const ref of group.refs) rowsOut.push({ ...ref, data, scale });
        charsDone += group.text.length;
      }
      embedded += vs.insertMany(rowsOut);
      state.embedded = embedded;
      state.chunks = vs.live;
      state.chars = charsDone;
      /* rate 统一用「字符/秒」对外，elapsed 是毫秒 → 乘 1000 换算；eta 再用同一单位倒推，
         两边都乘/除同一个 1000，才不会出现差三个数量级的 ETA（曾经踩过）。 */
      const elapsed = Date.now() - started;
      state.rate = elapsed > 0 ? (charsDone / elapsed) * 1000 : 0;
      state.etaMs = state.rate > 0 ? Math.round(((state.charsTotal - charsDone) / state.rate) * 1000) : 0;

      if (ratePerMinute > 0) {
        const target = (charsDone / ratePerMinute) * 60_000;
        const sleep = target - (Date.now() - started);
        if (sleep > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(sleep, 30_000)));
      } else {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    state.phase = this.paused ? 'paused' : 'idle';
    state.finishedAt = Date.now();
    /* 一轮写了很多块就顺手收一下 WAL：全量建库是 17k 行 × 1KB，-wal 会长到二十几 MB */
    if (embedded >= 500) {
      try {
        this.store.checkpoint();
      } catch {
        /* 收不动就留着，下一轮再试 */
      }
    }
    this.log(
      `[fast-search] 向量索引完成：新增 ${embedded} 块（复用 ${reuseRows.length}，清理 ${pruned}），` +
        `共 ${vs.live} 块 / ${vs.liveContent} 份内容，嵌入 ${charsDone} 字符，` +
        `耗时 ${state.finishedAt - started}ms`,
    );
    return {
      chunks: embedded,
      live: vs.live,
      contents: vs.liveContent,
      chars: charsDone,
      pruned,
      retargeted,
      reused: reuseRows.length,
      ms: state.finishedAt - started,
    };
  }

  /**
   * 查询侧的一次向量召回。`hits` 已按相似度降序，并带好渲染需要的原文片段。
   * @param {string} q
   * @param {{ topK?: number, accept?: ((rid: number) => boolean) | null }} [options]
   */
  async semanticSearch(q, { topK, accept = null } = {}) {
    if (!this.enabled) return { hits: [], reason: 'disabled', ms: 0 };
    await this.init();
    const vs = this.vs;
    if (vs === null || vs.size === 0) return { hits: [], reason: 'empty', ms: 0 };

    const started = Date.now();
    const queryVec = await this.embedQuery(q);
    const { data, scale } = quantize(queryVec);
    const k = Math.max(1, Math.trunc(topK ?? this.config.topK) || 60);
    const found = vs.search(data, scale, k, accept);
    if (found.length === 0) return { hits: [], reason: 'no-match', ms: Date.now() - started };

    /* 门槛分两道，理由都是实测的相似度分布（bge-large，中文会话语料）：
     *   相关查询 top 0.57–0.71，p50 0.33–0.42；
     *   无关查询（「今天天气怎么样」）top 只有 0.25–0.26。
     * 所以「最佳分 < minScore」就整体判为没有相关——别把 60 条不相干的块塞进结果；
     * 单条再用 0.75×minScore 砍尾巴，头部几条和排名不变。 */
    const minScore = Number(this.config.minScore) || 0;
    const topScore = found[0].score;
    if (minScore > 0 && topScore < minScore) {
      return { hits: [], reason: 'no-match', topScore, ms: Date.now() - started };
    }
    const floor = minScore > 0 ? minScore * 0.75 : 0;
    const kept = floor > 0 ? found.filter((item) => item.score >= floor) : found;

    const metas = this.store.docsByRid(JSON.stringify(kept.map((item) => item.rid)));
    const hits = [];
    for (const item of kept) {
      const meta = metas.get(item.rid);
      if (meta === undefined) continue;
      const text = cjkUnspace(meta.text);
      const from = Math.max(0, Math.min(text.length, item.start));
      const to = Math.max(from, Math.min(text.length, item.start + item.len));
      hits.push({
        rid: item.rid,
        sessionId: meta.session_id,
        seq: meta.seq,
        kind: meta.kind,
        role: meta.role,
        time: meta.time,
        score: item.score,
        chunk: text.slice(from, to),
      });
    }
    return { hits, reason: 'ok', topScore, ms: Date.now() - started, model: this.config.model };
  }

  /** @param {string} q */
  async embedQuery(q) {
    const size = Math.max(4, Math.trunc(this.config.queryCacheSize) || 32);
    const cached = this.queryCache.get(q);
    if (cached !== undefined) {
      /* 命中就往后挪一下，近似 LRU */
      this.queryCache.delete(q);
      this.queryCache.set(q, cached);
      return cached;
    }
    const vec = await this.embedder.embedOne(q);
    this.queryCache.set(q, vec);
    while (this.queryCache.size > size) {
      const oldest = this.queryCache.keys().next().value;
      this.queryCache.delete(oldest);
    }
    return vec;
  }

  /** 面板/CLI 看到的全部状态。 */
  status() {
    const vs = this.vs;
    const stats = vs === null
      ? { chunks: 0, contents: 0, slots: 0, dim: this.config.dim, bytes: 0 }
      : vs.stats();
    let docsCovered = 0;
    if (vs !== null && vs.loaded) {
      const seen = new Set();
      for (const refs of vs.refsByHash.values()) {
        for (const ref of refs) seen.add(ref.rid);
      }
      docsCovered = seen.size;
    }
    const now = Date.now();
    if (now - this.docsTotalCache.at > 10_000) {
      let total = 0;
      try {
        total = this.store.countDocsForKinds(this.kindsJson).n;
      } catch {
        total = 0;
      }
      this.docsTotalCache = { value: total, at: now };
    }
    return {
      enabled: this.enabled,
      ready: this.ready,
      paused: this.paused,
      url: this.config.url,
      model: this.config.model,
      dim: Number(this.config.dim) || 0,
      kinds: this.config.kinds,
      chunkChars: this.config.chunkChars,
      batch: Number(this.config.batch) || 8,
      concurrency: Number(this.config.concurrency) || 1,
      chunks: stats.chunks,
      contents: stats.contents,
      bytes: stats.bytes,
      docsCovered,
      docsTotal: this.docsTotalCache.value,
      progress: { ...this.state },
      lastError: this.lastError,
      stats: this.embedder === null ? null : { ...this.embedder.stats },
    };
  }
}
