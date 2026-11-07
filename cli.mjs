#!/usr/bin/env node
/**
 * 独立的命令行入口——不依赖宿主，用来在没有 GUI 的环境里验证索引与查询。
 *
 *   node cli.mjs build  [--db <文件>] [--sessions <目录>] [--force]
 *   node cli.mjs search <关键词...> [--db <文件>] [--limit 20] [--json]
 *   node cli.mjs status [--db <文件>]
 */

import os from 'node:os';
import path from 'node:path';
import { Store } from './src/store.js';
import { Indexer } from './src/indexer.js';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'status';

/** @param {string} flag @param {string} [fallback] */
function arg(flag, fallback) {
  const at = argv.indexOf(flag);
  if (at < 0 || at + 1 >= argv.length) return fallback;
  return argv[at + 1];
}

const dbPath = arg('--db', path.join(os.homedir(), '.dsh', 'storages', 'fast-search.db'));
const sessionsDir = arg('--sessions', path.join(os.homedir(), '.dsh', 'sessions'));
const force = argv.includes('--force');
const asJson = argv.includes('--json');

if (command === 'build') {
  const store = new Store(dbPath);
  if (force) store.reset();
  const indexer = new Indexer({ store, root: sessionsDir, log: (m) => process.stderr.write(`${m}\n`) });
  const started = Date.now();
  const result = await indexer.syncAll({ force });
  const stats = store.stats();
  console.log(
    JSON.stringify(
      { ...result, wallMs: Date.now() - started, ...stats, dbPath, sessionsDir },
      null,
      2,
    ),
  );
  store.close();
} else if (command === 'search') {
  const query = argv.slice(1).filter((a) => !a.startsWith('--') && a !== arg('--db') && a !== arg('--limit')).join(' ');
  if (!query) {
    console.error('用法：node cli.mjs search <关键词> [--limit 20] [--json]');
    process.exit(2);
  }
  const limit = Number(arg('--limit', '20'));
  const store = new Store(dbPath);
  const result = store.search(query, { groupLimit: limit, perSession: 3 });
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`查询 ${JSON.stringify(result.q)}  →  ${result.total} 条命中，${result.groups.length} 个会话，${result.took}ms`);
    console.log(`MATCH ${result.match}`);
    for (const group of result.groups) {
      console.log('');
      console.log(`● ${group.title ?? '(无标题)'}  ${group.sessionId}`);
      console.log(`  ${group.cwd ?? ''}  ${group.createdAt ? new Date(group.createdAt).toISOString() : ''}`);
      for (const doc of group.docs) {
        const text = doc.snippet.map((s) => (s.mark ? `[${s.text}]` : s.text)).join('');
        console.log(`  · [${doc.kind}] ${text}`);
      }
    }
  }
  store.close();
} else {
  const store = new Store(dbPath);
  const stats = store.stats();
  console.log(JSON.stringify({ dbPath, sessionsDir, ...stats }, null, 2));
  store.close();
}
