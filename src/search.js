/**
 * 混合检索：FTS 快路径 + 可选的语义召回，用 RRF（倒数排名融合）合并。
 *
 * 为什么是 RRF 而不是分数加权：bm25 的分数是负值、量纲随查询长度漂移，余弦是 [-1,1]，
 * 两者没有可比性；加权需要调一个任意的缩放常数，换个查询就得重调。RRF 只看名次，
 * 天然对齐，而且对"某一路没命中"很稳健。
 *
 * 语义召回**永远不进快路径**：FTS 结果照原样返回，语义只做补充。这样开关关闭、
 * 服务挂掉、索引还没建好时，行为和以前逐字节一致。
 */

import { buildSnippet } from './snippet.js';

/** RRF 的平滑常数：60 是检索界的常用取值（Cormack 等），不敏感。 */
const RRF_K = 60;

/**
 * 决定这一轮要不要跑语义召回。
 * @param {'off'|'auto'|'on'} mode
 * @param {number} total FTS 命中数
 * @param {number} autoThreshold
 */
export function shouldRecall(mode, total, autoThreshold) {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  return total < Math.max(1, autoThreshold);
}

/**
 * @param {{ store: import('./store.js').Store,
 *           engine: import('./vectors.js').VectorEngine | null,
 *           q: string, options?: Record<string, any>, mode?: 'off'|'auto'|'on' }} options
 */
export async function searchWithSemantic({ store, engine, q, options = {}, mode = 'auto' }) {
  const started = performance.now();
  /* 工作区筛选只在这里解析一次，FTS 与语义召回共用同一份 sessionId 集合 */
  const filter = options.filter ?? store.createFilter(options);
  const fts = store.search(q, { ...options, filter });
  if (fts.error !== undefined) return { ...fts, semantic: { used: false, reason: 'fts-error' } };
  if (!engine || engine.enabled !== true || mode === 'off') {
    return { ...fts, semantic: { used: false, reason: engine?.enabled === true ? 'off' : 'disabled' } };
  }

  const threshold = Number(engine.config?.autoThreshold) || 5;
  if (!shouldRecall(mode, fts.total ?? 0, threshold)) {
    return { ...fts, semantic: { used: false, reason: 'enough-fts', total: fts.total ?? 0 } };
  }

  /* 布尔语法里的 AND/OR/括号不该进嵌入模型：用整理后的检索词，而不是原始输入。
   * `fts.terms` 已经去掉了运算符与引号；纯语义查询（全文 0 条）也走同一份词表。 */
  const semanticQuery = Array.isArray(fts.terms) && fts.terms.length > 0 ? fts.terms.join(' ') : q;

  /* 语义打分阶段就套用筛选：否则 topK 会被别的项目/时间段的块占满，过滤后一条不剩 */
  const allowedRids = store.ridFilter(filter);
  const accept = allowedRids === null ? null : (rid) => allowedRids.has(rid);

  let recall;
  try {
    recall = await engine.semanticSearch(semanticQuery, { topK: options.topK, accept });
  } catch (err) {
    return {
      ...fts,
      semantic: { used: false, reason: 'error', error: String(err?.message ?? err) },
    };
  }
  if (!Array.isArray(recall.hits) || recall.hits.length === 0) {
    return {
      ...fts,
      semantic: { used: false, reason: recall.reason ?? 'empty', topScore: recall.topScore ?? null, ms: recall.ms ?? 0 },
    };
  }

  const fused = fuse(fts.groups ?? [], recall.hits, {
    store,
    words: Array.isArray(fts.words) ? fts.words : [],
    perSession: options.perSession ?? 6,
    groupLimit: options.groupLimit ?? 20,
  });

  return {
    ...fts,
    took: Math.round((performance.now() - started) * 100) / 100,
    groups: fused.groups,
    semantic: {
      used: true,
      model: recall.model ?? null,
      hits: recall.hits.length,
      shown: fused.shown,
      topScore: recall.topScore === undefined ? null : round(recall.topScore),
      ms: recall.ms ?? 0,
      mode,
    },
  };
}

/**
 * RRF 融合并按会话重新分组。
 * @param {any[]} ftsGroups
 * @param {any[]} hits
 * @param {{ store: any, words: string[], perSession: number, groupLimit: number }} options
 */
export function fuse(ftsGroups, hits, { store, words, perSession, groupLimit }) {
  /** @type {Map<number, { rid: number, score: number, source: string, sessionId: string,
   *                          fts?: any, vec?: any }>} */
  const entries = new Map();

  let rank = 0;
  for (const group of ftsGroups) {
    for (const doc of Array.isArray(group?.docs) ? group.docs : []) {
      const rid = doc?.rid;
      if (!Number.isFinite(rid)) continue;
      const entry = entries.get(rid) ?? {
        rid,
        score: 0,
        source: 'fts',
        sessionId: group.sessionId,
        fts: doc,
      };
      entry.score += 1 / (RRF_K + rank + 1);
      rank += 1;
      entries.set(rid, entry);
    }
  }

  const seenVec = new Set();
  let vecRank = 0;
  for (const hit of hits) {
    const rid = hit?.rid;
    if (!Number.isFinite(rid) || seenVec.has(rid)) continue;
    seenVec.add(rid);
    const entry = entries.get(rid) ?? {
      rid,
      score: 0,
      source: 'vec',
      sessionId: hit.sessionId ?? '',
    };
    entry.vec = hit;
    entry.score += 1 / (RRF_K + vecRank + 1);
    entry.source = entry.fts === undefined ? 'vec' : 'both';
    vecRank += 1;
    entries.set(rid, entry);
  }

  const ordered = [...entries.values()].sort((a, b) => b.score - a.score);

  /* 会话元数据：FTS 分组里已有的直接用，语义新增的会话回表查 */
  const metas = new Map();
  for (const group of ftsGroups) {
    metas.set(group.sessionId, {
      sessionId: group.sessionId,
      title: group.title ?? null,
      cwd: group.cwd ?? null,
      createdAt: group.createdAt ?? null,
    });
  }
  const missing = [...new Set(ordered.map((entry) => entry.sessionId))].filter(
    (id) => typeof id === 'string' && id !== '' && !metas.has(id),
  );
  for (const row of store.sessionsById(JSON.stringify(missing))) {
    metas.set(row.session_id, {
      sessionId: row.session_id,
      title: row.title ?? null,
      cwd: row.cwd ?? null,
      createdAt: row.created_at ?? null,
    });
  }

  /** @type {Map<string, { sessionId: string, title: string|null, cwd: string|null,
   *                         createdAt: number|null, lastTime: number, docs: any[], best: number }>} */
  const groups = new Map();
  let shown = 0;
  for (const entry of ordered) {
    const sessionId = entry.sessionId;
    const docTime = Number(entry.fts?.time ?? entry.vec?.time ?? 0) || 0;
    let group = groups.get(sessionId);
    if (group === undefined) {
      if (groups.size >= groupLimit) continue;
      const meta = metas.get(sessionId) ?? { title: null, cwd: null, createdAt: null };
      group = {
        sessionId,
        title: meta.title,
        cwd: meta.cwd,
        createdAt: meta.createdAt,
        lastTime: docTime,
        docs: [],
        best: entry.score,
      };
      groups.set(sessionId, group);
    } else if (docTime > group.lastTime) {
      group.lastTime = docTime;
    }
    if (group.docs.length >= perSession) continue;

    if (entry.fts !== undefined) {
      group.docs.push({ ...entry.fts, source: entry.source, score: round(entry.score) });
    } else {
      const hit = entry.vec;
      const snippet = buildSnippet(hit.chunk ?? '', words);
      group.docs.push({
        rid: entry.rid,
        seq: hit.seq,
        kind: hit.kind,
        role: hit.role,
        time: hit.time,
        snippet: snippet.segments,
        matched: snippet.matched,
        source: 'vec',
        score: round(entry.score),
        similarity: round(hit.score),
      });
    }
    shown += 1;
  }

  return { groups: [...groups.values()], shown };
}

/** 分数保留 4 位小数：结果体要小，面板也不显示更多精度。 */
function round(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}
