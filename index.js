/**
 * dsh-fast-search — 宿主半边。
 *
 * 职责：维护 SQLite FTS5 索引（增量、自带水位线），并通过 webServer 前缀路由
 * 暴露三个 JSON 端点给浏览器半边的面板。
 *
 * 零外部依赖：只用 `node:sqlite` / `node:zlib` / `node:fs`。profile 的 node_modules
 * 根目录没有 schemastery，所以这里也不写 `export const Config`（Cordis 允许）
 * ——配置直接从 patch 里传对象进来，缺字段就用默认值。
 */

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { Store } from './src/store.js';
import { Indexer } from './src/indexer.js';
import { VectorEngine } from './src/vectors.js';
import { createHandler } from './src/router.js';
import { LOADED_VERSION, createUpdater, createUpdateRoutes, resolveDshHome } from './update.js';

export const name = 'dsh-fast-search';

/** 版本号只有 package.json 一个来源（升级写的是它，这里读的就是它）。 */
export const version = LOADED_VERSION;

/** API 前缀。**刻意避开 `/plugins/`**——那是 client bundle 的领地（最长前缀优先）。 */
export const API_PREFIX = '/plugin-api/dsh-fast-search';

/**
 * 索引目录与索引库的落点：显式配置 > `$DSH_HOME` > `~/.dsh`。
 *
 * DSH 自己的数据根就是这个优先级（`@deepseek-ai/dsh-home-paths` 的
 * `resolveDshHome`，base profile 里会话库写的是 `root: !!js dshHomePath('sessions')`），
 * 这里必须同口径。**不能**写死 `os.homedir()`：在 `DSH_HOME=D:\DeepSeekHarness\data`
 * 这类机器上，`~/.dsh` 只是一份历史遗留的旧 home，索引它会让工作区下拉只剩几个旧项目、
 * 近期会话一条都搜不到——而且看起来像前端出了问题（见 0.4.3 变更记录）。
 *
 * @param {{ sessionsDir?: string, dbPath?: string }} [config]
 * @returns {{ sessionsDir: string, dbPath: string }}
 */
export function resolveDataPaths(config = {}) {
  const home = path.resolve(resolveDshHome());
  return {
    sessionsDir: config.sessionsDir ?? path.join(home, 'sessions'),
    dbPath: config.dbPath ?? path.join(home, 'storages', 'fast-search.db'),
  };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ sessionsDir?: string, dbPath?: string, cap?: number, bootDelayMs?: number,
 *           watch?: boolean, sweepMs?: number,
 *           search?: { mode?: 'off'|'auto'|'on' },
 *           vectors?: Record<string, any> }} [config]
 */
export async function apply(ctx, config = {}) {
  const { sessionsDir, dbPath } = resolveDataPaths(config);
  const log = (message) => {
    try {
      if (typeof ctx.logger === 'function') ctx.logger(`${name}: ${message}`);
      else console.log(message);
    } catch {
      /* 日志失败不影响索引 */
    }
  };

  mkdirSync(path.dirname(dbPath), { recursive: true });

  const store = new Store(dbPath);

  /* 语义索引完全可选：没配 url（或 enabled=false）时这个对象是空壳，
   * 索引路线、查询路线、HTTP 路由都和引入它之前一致。 */
  const vectors = new VectorEngine({ store, config: config.vectors ?? {}, log });

  const indexer = new Indexer({
    store,
    root: sessionsDir,
    cap: Number.isFinite(config.cap) ? Number(config.cap) : 8192,
    log,
    watch: config.watch !== false,
    /* 索引器一落盘就通知向量流水线：只补这个文件新增的块 */
    onIndexed: (file) => vectors.queuePath(file),
    onRemoved: (file) => vectors.removePath(file),
  });

  ctx.effect(() => {
    /* 首轮对账延后启动：别和宿主自己的启动 I/O 抢盘；首轮扫描本身会让出事件循环 */
    const delay = Number.isFinite(config.bootDelayMs) ? Number(config.bootDelayMs) : 3000;
    const timer = setTimeout(() => {
      void indexer.syncAll({ force: false }).catch((err) => {
        indexer.state.phase = 'error';
        indexer.state.lastError = String(err?.message ?? err);
        log(`首轮索引失败：${indexer.state.lastError}`);
      });
    }, delay);
    timer.unref?.();

    indexer.startWatch({ intervalMs: Number.isFinite(config.sweepMs) ? Number(config.sweepMs) : 15 * 60 * 1000 });

    /* 向量建库比 FTS 晚一步起：先把索引对上账，再让后台慢慢嵌入（服务端很慢，见 docs/semantic.md） */
    if (vectors.enabled) vectors.start();

    return () => {
      clearTimeout(timer);
      vectors.stop();
      indexer.stop();
      store.close();
    };
  });

  /* webServer 单独一个 fiber：headless 宿主没有它，路由挂了也不该拖垮索引 */
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer');
    if (webServer === undefined) return;
    const disposers = [];
    let updater;
    try {
      /* 升级通道整体包在 try/catch 里：它坏了只该让升级不可用，不能让整个插件起不来 */
      try {
        updater = createUpdater({ ctx, config, logger: (message) => log(message) });
      } catch (err) {
        log(`升级通道不可用：${String(err?.message ?? err)}`);
      }
      const handler = createHandler({
        store,
        indexer,
        vectors,
        searchMode: config.search?.mode ?? 'auto',
        basePath: API_PREFIX,
        sessionsDir,
        dbPath,
        version,
        updateRoutes: updater === undefined ? undefined : createUpdateRoutes(updater, { prefix: API_PREFIX }),
      });
      disposers.push(webServer.register({ kind: 'prefix', path: API_PREFIX, handler }));
      log(`HTTP API 已挂载：${API_PREFIX}`);
    } catch (err) {
      log(`HTTP API 挂载失败：${String(err?.message ?? err)}`);
    } finally {
      scoped.effect(() => () => {
        try {
          updater?.dispose();
        } catch {
          /* 没有在跑的作业 */
        }
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 已释放 */
          }
        }
      });
    }
  });
}
