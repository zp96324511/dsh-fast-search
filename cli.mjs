#!/usr/bin/env node
/**
 * 独立的命令行入口——不依赖宿主，用来在没有 GUI 的环境里验证索引与查询。
 *
 *   node cli.mjs build  [--db <文件>] [--sessions <目录>] [--force]
 *   node cli.mjs search <关键词...> [--db <文件>] [--limit 20] [--json]
 *                       [--workspace <cwd>] [--range 1d|1w|1m]
 *                       [--kind user,assistant,tool,result,title]
 *                       [--since <毫秒|ISO 日期>] [--until <毫秒|ISO 日期>]
 *                       [--semantic off|auto|on] [--top-k 60]
 *                       [--embed-url <url>] [--embed-key <key>] [--embed-model bge-large]
 *   node cli.mjs vectors status|sync [--db <文件>] [--sessions <目录>] [--force]
 *                       [--chars N] [--chunk-chars 480] [--batch 8] [--concurrency 1]
 *                       [--embed-url <url>] [--embed-key <key>] [--embed-model bge-large]
 *   node cli.mjs status [--db <文件>]
 *
 * 嵌入服务地址也可以从环境变量给：DSH_EMBED_URL / DSH_EMBED_KEY / DSH_EMBED_MODEL。
 */

import os from 'node:os';
import path from 'node:path';
import { Store } from './src/store.js';
import { Indexer } from './src/indexer.js';
import { VectorEngine } from './src/vectors.js';
import { searchWithSemantic } from './src/search.js';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'status';

/** 需要吃一个值的开关；其余 `--xxx` 视为布尔。 */
const VALUE_FLAGS = new Set([
  '--db',
  '--sessions',
  '--limit',
  '--semantic',
  '--top-k',
  '--embed-url',
  '--embed-key',
  '--embed-model',
  '--chars',
  '--chunk-chars',
  '--batch',
  '--concurrency',
  '--workspace',
  '--kind',
  '--since',
  '--until',
  '--range',
]);

const { flags, rest } = (() => {
  /** @type {Map<string, string|true>} */
  const map = new Map();
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (VALUE_FLAGS.has(token)) {
      map.set(token, argv[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (token.startsWith('--')) {
      map.set(token, true);
      continue;
    }
    words.push(token);
  }
  return { flags: map, rest: words };
})();

/** @param {string} flag @param {string} [fallback] */
function arg(flag, fallback) {
  const value = flags.get(flag);
  return typeof value === 'string' ? value : fallback;
}

const dbPath = arg('--db', path.join(os.homedir(), '.dsh', 'storages', 'fast-search.db'));
const sessionsDir = arg('--sessions', path.join(os.homedir(), '.dsh', 'sessions'));
const force = flags.has('--force');
const asJson = flags.has('--json');

const RANGE_MS = new Map([
  ['1d', 86_400_000],
  ['24h', 86_400_000],
  ['day', 86_400_000],
  ['1天', 86_400_000],
  ['1w', 604_800_000],
  ['7d', 604_800_000],
  ['week', 604_800_000],
  ['1周', 604_800_000],
  ['1m', 2_592_000_000],
  ['30d', 2_592_000_000],
  ['month', 2_592_000_000],
  ['1月', 2_592_000_000],
]);

/** @param {string} value @returns {number} */
function timestamp(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** @param {string} value @returns {number} 快捷时间窗的起点（毫秒），空值/未知值 → 0 */
function rangeSince(value) {
  const ms = RANGE_MS.get(value.trim().toLowerCase()) ?? 0;
  return ms > 0 ? Date.now() - ms : 0;
}

/** @returns {{ enabled: boolean, url: string, model: string, apiKey: string, chunkChars: number,
 *             batch: number, concurrency: number }} */
function vectorConfig() {
  const url = arg('--embed-url', process.env.DSH_EMBED_URL ?? '');
  return {
    enabled: url !== '',
    url,
    model: arg('--embed-model', process.env.DSH_EMBED_MODEL ?? 'bge-large'),
    apiKey: arg('--embed-key', process.env.DSH_EMBED_KEY ?? ''),
    chunkChars: Number(arg('--chunk-chars', '480')),
    batch: Number(arg('--batch', '8')),
    concurrency: Number(arg('--concurrency', '1')),
  };
}

if (command === 'build') {
  const store = new Store(dbPath);
  if (force) store.reset();
  const indexer = new Indexer({ store, root: sessionsDir, log: (m) => process.stderr.write(`${m}\n`) });
  const started = Date.now();
  const result = await indexer.syncAll({ force });
  const stats = store.stats();
  console.log(
    JSON.stringify({ ...result, wallMs: Date.now() - started, ...stats, dbPath, sessionsDir }, null, 2),
  );
  store.close();
} else if (command === 'search') {
  const query = rest.slice(1).join(' ').trim();
  if (!query) {
    console.error('用法：node cli.mjs search <关键词> [--limit 20] [--json] [--semantic off|auto|on]');
    process.exit(2);
  }
  const limit = Number(arg('--limit', '20'));
  const mode = arg('--semantic', 'off');
  const store = new Store(dbPath);
  const config = vectorConfig();
  const options = {
    groupLimit: limit,
    perSession: 3,
    topK: Number(arg('--top-k', '60')),
    workspace: arg('--workspace', ''),
    /* 消息类型：短名或事件全名都行，逗号分隔；由 store.createFilter 统一归一 */
    kinds: arg('--kind', ''),
    since: timestamp(arg('--since', '0')),
    until: timestamp(arg('--until', '0')),
  };
  const since = rangeSince(arg('--range', ''));
  if (since > 0) options.since = options.since > 0 ? Math.max(options.since, since) : since;

  const result =
    mode !== 'off' && config.enabled
      ? await searchWithSemantic({
          store,
          engine: new VectorEngine({ store, config, log: (m) => process.stderr.write(`${m}\n`) }),
          q: query,
          mode,
          options,
        })
      : store.search(query, options);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const semantic = result.semantic ?? { used: false };
    console.log(
      `查询 ${JSON.stringify(result.q)}  →  ${result.total} 条命中，${result.groups.length} 个会话，${result.took}ms` +
        (semantic.used ? `（语义补召 ${semantic.hits} 块 / ${semantic.ms}ms）` : ''),
    );
    console.log(`MATCH ${result.match}`);
    for (const group of result.groups) {
      console.log('');
      console.log(`● ${group.title ?? '(无标题)'}  ${group.sessionId}`);
      console.log(`  ${group.cwd ?? ''}  ${group.createdAt ? new Date(group.createdAt).toISOString() : ''}`);
      for (const doc of group.docs) {
        const text = doc.snippet.map((s) => (s.mark ? `[${s.text}]` : s.text)).join('');
        const tag = doc.source === 'vec' ? '语义' : doc.source === 'both' ? '双' : '';
        console.log(`  · [${doc.kind}]${tag ? `(${tag})` : ''} ${text}`);
      }
    }
  }
  store.close();
} else if (command === 'vectors') {
  const sub = rest[1] ?? 'status';
  const store = new Store(dbPath);
  const indexer = new Indexer({
    store,
    root: sessionsDir,
    log: () => {},
    watch: false,
    onIndexed: (file) => engine.queuePath(file),
    onRemoved: (file) => engine.removePath(file),
  });
  const config = vectorConfig();
  const engine = new VectorEngine({ store, config, log: (m) => process.stderr.write(`${m}\n`) });

  if (!engine.enabled) {
    console.error('未提供嵌入服务地址：加 --embed-url <url> 或设 DSH_EMBED_URL');
    store.close();
    process.exit(2);
  }

  await engine.init();
  if (sub === 'sync') {
    /* 先让 FTS 对上账——语义索引是 FTS 的投影，源不新就白算 */
    await indexer.syncAll({ force: false });
    const chars = Number(arg('--chars', '0')) || 0;
    const timer = setInterval(() => {
      const progress = engine.state;
      process.stderr.write(
        `\r${progress.phase} 块 ${progress.chunks}/${progress.chunksTotal} ` +
          `字符 ${progress.chars}/${progress.charsTotal} ` +
          `${Math.round(progress.rate)} 字符/秒 ETA ${Math.round(progress.etaMs / 1000)}s   `,
      );
    }, 3000);
    timer.unref?.();
    const result = await engine.sync({ force, maxChars: chars });
    clearInterval(timer);
    process.stderr.write('\n');
    console.log(JSON.stringify({ ...result, ...engine.status() }, null, 2));
  } else {
    console.log(JSON.stringify(engine.status(), null, 2));
  }
  store.close();
} else {
  const store = new Store(dbPath);
  const stats = store.stats();
  console.log(JSON.stringify({ dbPath, sessionsDir, ...stats }, null, 2));
  store.close();
}
