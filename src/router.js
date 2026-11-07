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

const MAX_BODY = 256 * 1024;

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
 * @param {{ store: import('./store.js').Store, indexer: import('./indexer.js').Indexer,
 *           basePath: string, sessionsDir: string, dbPath: string, version: string,
 *           updateRoutes?: (req: any, res: any, pathname: string) => Promise<boolean> }} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHandler({ store, indexer, basePath, sessionsDir, dbPath, version, updateRoutes }) {
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
          endpoints: ['POST /search', 'GET /status', 'POST /reindex', 'GET /update', 'POST /update/upgrade', 'POST /update/restart'],
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
        });
        return;
      }

      if (route === '/search') {
        const input = method === 'GET' ? { q: url.searchParams.get('q') ?? '' } : await readJson(req);
        const q = String(input.q ?? '').slice(0, 512);
        if (!q.trim()) {
          sendJson(res, 200, { q, took: 0, total: 0, groups: [], empty: true });
          return;
        }
        const result = store.search(q, {
          limit: clampInt(input.limit, 1, 2000, 300),
          groupLimit: clampInt(input.groupLimit, 1, 100, 20),
          perSession: clampInt(input.perSession, 1, 50, 6),
        });
        sendJson(res, result.error ? 400 : 200, result);
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
