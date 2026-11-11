/**
 * HTTP 路由（宿主 `webServer` 前缀路由，JSON in / JSON out）。
 *
 * 为什么不用 Typert Remote 命名空间：这里只有三个无状态的 JSON 端点，前缀路由
 * 不需要类型网关、不需要客户端代码生成，样板最小（可对照 dsh-active-sessions 的
 * 更新通道）。客户端半用同源 `fetch` 直接打。
 *
 * **路径不能放在 `/plugins/...` 之下**：那一段被 dsh-client-modules 用来发每个插件
 * 自己的浏览器 bundle（`/plugins/<entryId>/<fileName>`），前缀路由会按"最长前缀优先"
 * 抢走它，把自己面板的 client.js 变成 404。
 */

import { readFile } from 'node:fs/promises';
import { normalizeKinds } from './store.js';
import { searchWithSemantic } from './search.js';

const MAX_BODY = 256 * 1024;
const MODES = new Set(['off', 'auto', 'on']);

/** @param {import('node:http').ServerResponse} res */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** @param {import('node:http').IncomingMessage} req */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/**
 * @param {{ store: import('./store.js').Store,
 *           indexer: import('./indexer.js').Indexer,
 *           vectors?: import('./vectors.js').VectorEngine | null,
 *           searchMode?: 'off'|'auto'|'on',
 *           basePath: string, sessionsDir: string, dbPath: string, version: string,
 *           updateRoutes?: (req: any, res: any, pathname: string) => Promise<boolean> }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHandler({
  store,
  indexer,
  vectors = null,
  searchMode = 'auto',
  basePath,
  sessionsDir,
  dbPath,
  version,
  updateRoutes,
}) {
  const fallbackMode = MODES.has(searchMode) ? searchMode : 'auto';
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let route = url.pathname.slice(basePath.length) || '/';
    if (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1);
    const method = req.method ?? 'GET';

    try {
      /* 升级通道自己认领 /update* 与 /ping，认领不到再往下走搜索路由 */
      if (typeof updateRoutes === 'function' && (await updateRoutes(req, res, url.pathname))) return;

      if (route === '/' || route === '') {
        sendJson(res, 200, {
          name: 'dsh-fast-search',
          version,
          endpoints: [
            'POST /search',
            'GET /workspaces',
            'GET /status',
            'POST /reindex',
            'GET /vectors',
            'POST /vectors/sync',
            'POST /vectors/pause',
            'GET /update',
            'POST /update/upgrade',
          ],
        });
        return;
      }

      if (route === '/status') {
        const stats = store.stats();
        let bytes = 0;
        try {
          bytes = (await readFile(dbPath)).length;
        } catch {
          bytes = 0;
        }
        sendJson(res, 200, {
          version,
          sessionsDir,
          dbPath,
          dbBytes: bytes,
          ...stats,
          index: indexer.state,
          searchMode: fallbackMode,
          vectors: vectors === null ? { enabled: false } : vectors.status(),
        });
        return;
      }

      if (route === '/workspaces') {
        sendJson(res, 200, { workspaces: store.workspaces() });
        return;
      }

      if (route === '/search') {
        const input = method === 'GET' ? Object.fromEntries(url.searchParams) : await readJson(req);
        const q = String(input.q ?? '').slice(0, 512);
        const filter = normalizeFilter(input);
        const filterInfo = {
          workspace: filter.workspace === '' ? null : filter.workspace,
          kinds: filter.kinds,
          since: filter.since === 0 ? null : filter.since,
          until: filter.until === 0 ? null : filter.until,
          range: filter.range === '' ? null : filter.range,
        };
        if (!q.trim()) {
          sendJson(res, 200, { q, took: 0, total: 0, groups: [], empty: true, filters: filterInfo });
          return;
        }
        const mode = normalizeMode(input.semantic) ?? fallbackMode;
        const result = await searchWithSemantic({
          store,
          engine: vectors,
          q,
          mode,
          options: {
            limit: clampInt(input.limit, 1, 2000, 300),
            groupLimit: clampInt(input.groupLimit, 1, 100, 20),
            perSession: clampInt(input.perSession, 1, 50, 6),
            workspace: filter.workspace,
            kinds: filter.kinds,
            since: filter.since,
            until: filter.until,
          },
        });
        /* 筛选状态以请求里的为准回给面板（range 是服务端换算的快捷值，带上便于回显） */
        sendJson(res, result.error ? 400 : 200, { ...result, filters: filterInfo });
        return;
      }

      if (route === '/vectors') {
        sendJson(res, 200, vectors === null ? { enabled: false } : vectors.status());
        return;
      }

      if (route === '/vectors/sync') {
        if (vectors === null || vectors.enabled !== true) {
          sendJson(res, 409, { started: false, error: '语义索引未启用（配置里没有 vectors.url 或 enabled=false）' });
          return;
        }
        const input = method === 'GET' ? {} : await readJson(req).catch(() => ({}));
        const force = input.force === true;
        const maxChars = clampInt(input.maxChars, 0, 100_000_000, 0);
        vectors.setPaused(false);
        void vectors.sync({ force, maxChars }).catch((err) => {
          vectors.lastError = String(err?.message ?? err);
        });
        sendJson(res, 202, { started: true, force, maxChars });
        return;
      }

      if (route === '/vectors/pause') {
        if (vectors === null) {
          sendJson(res, 409, { ok: false, error: '语义索引未启用' });
          return;
        }
        const input = method === 'GET' ? {} : await readJson(req).catch(() => ({}));
        const paused = vectors.setPaused(input.paused !== false);
        sendJson(res, 200, { ok: true, paused });
        return;
      }

      if (route === '/reindex') {
        const input = method === 'GET' ? {} : await readJson(req).catch(() => ({}));
        const force = input.force === true;
        void indexer.syncAll({ force }).catch(() => {});
        sendJson(res, 202, { started: true, force });
        return;
      }

      sendJson(res, 404, { error: '未知路由', route });
    } catch (err) {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    }
  };
}

/** @param {unknown} value @param {number} min @param {number} max @param {number} fallback */
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 快捷时间范围：毫秒数。别名尽量覆盖中英文习惯写法。 */
const RANGE_MS = new Map([
  ['1d', 24 * 60 * 60 * 1000],
  ['24h', 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['1天', 24 * 60 * 60 * 1000],
  ['1w', 7 * 24 * 60 * 60 * 1000],
  ['7d', 7 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['1周', 7 * 24 * 60 * 60 * 1000],
  ['1m', 30 * 24 * 60 * 60 * 1000],
  ['30d', 30 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['1月', 30 * 24 * 60 * 60 * 1000],
]);

/** @param {unknown} value @returns {number} 毫秒时间戳；认不出/非正数 → 0 */
function toTimestamp(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * /search 的筛选参数归一化。`range` 是相对现在的时间窗；显式 `since` 与 `range`
 * 同时给时取更严格的那个（`since = max(since, now-range)`）。
 * `kinds` 是消息类型（会话事件 type）：数组，或逗号/空白分隔字符串；短名会归一成事件全名。
 * @param {Record<string, unknown>} input
 * @returns {{ workspace: string, since: number, until: number, range: string,
 *             kinds: string[] | null }}
 */
function normalizeFilter(input) {
  const workspace =
    typeof input.workspace === 'string' ? input.workspace.trim().slice(0, 1024) : '';
  let since = toTimestamp(input.since);
  const until = toTimestamp(input.until);
  const range = typeof input.range === 'string' ? input.range.trim().toLowerCase() : '';
  const rangeMs = RANGE_MS.get(range) ?? 0;
  if (rangeMs > 0) {
    const fromRange = Date.now() - rangeMs;
    since = since > 0 ? Math.max(since, fromRange) : fromRange;
  }
  /* `kind` 是 `kinds` 的单值别名（GET 里更顺手）；两个都给时以 `kinds` 为准 */
  const kinds = normalizeKinds(input.kinds ?? input.kind);
  return { workspace, since, until, range: rangeMs > 0 ? range : '', kinds };
}

/**
 * `semantic` 入参归一化。面板传字符串，命令行/脚本可能传布尔或数字；
 * 认不出来就返回 null，由默认模式兜底。
 * @param {unknown} value
 * @returns {'off'|'auto'|'on'|null}
 */
function normalizeMode(value) {
  if (value === true || value === 1) return 'on';
  if (value === false || value === 0) return 'off';
  const text = String(value ?? '').trim().toLowerCase();
  return MODES.has(text) ? text : null;
}
