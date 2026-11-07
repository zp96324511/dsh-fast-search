/**
 * SQLite FTS5 存储层。
 *
 * 布局（单文件）：
 *   docs        FTS5 虚拟表，`text` 是**插过空格**的文本（见 tokenize.js），
 *               其余列 UNINDEXED，只随内容表存放，取回时不用再查第二张表。
 *   doc_paths   `path → rowid` 映射，让"删掉某个文件的全部文档"走主键前缀扫描，
 *               而不是对 UNINDEXED 列做全表扫描。
 *   files       增量索引的水位线（size + mtime），一分钟内可判断 5,400 个文件是否要重解。
 *   sessions    会话元数据（cwd / 创建时间 / 标题），面板分组展示用。
 *
 * 连接参数：`mmap_size=256MB` 是 P0 基准里最大的单项优化（命中 P50 16.1ms → 4.6ms），
 * 且**不随库持久化**，每次开连接都要设。
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cjkSpace, cjkUnspace, toMatch, queryWords } from './tokenize.js';
import { buildSnippet } from './snippet.js';

/** 库结构版本；改动布局就 +1，旧库会被整体重建（索引可重建，不做迁移）。 */
export const SCHEMA_VERSION = 1;

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS files(
  path        TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  session_id  TEXT,
  docs        INTEGER NOT NULL DEFAULT 0,
  indexed_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  session_id  TEXT PRIMARY KEY,
  cwd         TEXT,
  created_at  INTEGER,
  title       TEXT,
  updated_at  INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
  text,
  session_id UNINDEXED,
  seq        UNINDEXED,
  kind       UNINDEXED,
  role       UNINDEXED,
  time       UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS doc_paths(
  path TEXT NOT NULL,
  rid  INTEGER NOT NULL,
  PRIMARY KEY(path, rid)
) WITHOUT ROWID;
`;

export class Store {
  /** @param {string} file 数据库文件路径 */
  constructor(file) {
    this.file = file;
    /* SQLite 不会替你建目录，宿主那边storage 目录可能还没被创建过 */
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA mmap_size = 268435456');
    this.db.exec('PRAGMA temp_store = MEMORY');
    /* 索引器和 CLI/另一个宿主可能同时开库，锁冲突等 5s 而不是立刻报错 */
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.#create();
    this.#prepare();
  }

  /** 建表；`files` 表存在即认为结构就绪。 */
  #create() {
    this.db.exec(CREATE_SQL);
  }

  #prepare() {
    const db = this.db;
    this.st = {
      insDoc: db.prepare(
        'INSERT INTO docs(text, session_id, seq, kind, role, time) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      delDoc: db.prepare('DELETE FROM docs WHERE rowid = ?'),
      selRids: db.prepare('SELECT rid FROM doc_paths WHERE path = ?'),
      insPath: db.prepare('INSERT OR REPLACE INTO doc_paths(path, rid) VALUES (?, ?)'),
      delPaths: db.prepare('DELETE FROM doc_paths WHERE path = ?'),
      upsertFile: db.prepare(
        'INSERT INTO files(path, size, mtime_ms, session_id, docs, indexed_at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, ' +
          'session_id = excluded.session_id, docs = excluded.docs, indexed_at = excluded.indexed_at',
      ),
      delFile: db.prepare('DELETE FROM files WHERE path = ?'),
      upsertSession: db.prepare(
        'INSERT INTO sessions(session_id, cwd, created_at, title, updated_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(session_id) DO UPDATE SET cwd = excluded.cwd, ' +
          'created_at = COALESCE(excluded.created_at, sessions.created_at), ' +
          'title = COALESCE(excluded.title, sessions.title), updated_at = excluded.updated_at',
      ),
      allFiles: db.prepare('SELECT path, size, mtime_ms FROM files'),
      countDocs: db.prepare('SELECT count(*) AS n FROM docs'),
      countSessions: db.prepare('SELECT count(*) AS n FROM sessions'),
      countFiles: db.prepare('SELECT count(*) AS n FROM files'),
      hits: db.prepare(
        'SELECT rowid AS rid, session_id, seq, kind, role, time, bm25(docs) AS score ' +
          'FROM docs WHERE docs MATCH ? ORDER BY score LIMIT ?',
      ),
      hitCount: db.prepare('SELECT count(*) AS n FROM docs WHERE docs MATCH ?'),
      texts: db.prepare(
        'SELECT rowid AS rid, text FROM docs WHERE rowid IN (SELECT value FROM json_each(?))',
      ),
      sessionsById: db.prepare(
        'SELECT session_id, cwd, created_at, title FROM sessions ' +
          'WHERE session_id IN (SELECT value FROM json_each(?))',
      ),
    };
  }

  /** 水位线：`path → {size, mtimeMs}`。 */
  fileState() {
    const map = new Map();
    for (const row of this.st.allFiles.iterate()) {
      map.set(row.path, { size: row.size, mtimeMs: row.mtime_ms });
    }
    return map;
  }

  /** @param {string} path */
  #deleteFileDocs(path) {
    const rids = this.st.selRids.all(path);
    for (const row of rids) this.st.delDoc.run(row.rid);
    this.st.delPaths.run(path);
    this.st.delFile.run(path);
    return rids.length;
  }

  /**
   * 整文件替换：删掉该文件旧文档 → 插入新文档 → 更新水位线与会话元数据。
   * 单事务，中途抛错则回滚，不会留下半份索引。
   *
   * @param {string} path
   * @param {{ size: number, mtimeMs: number, header: any, title: string | null,
   *           docs: Array<{ seq: number, kind: string, role: string, time: number, text: string }> }} payload
   * @returns {number} 写入的文档数
   */
  replaceFile(path, { size, mtimeMs, header, title, docs }) {
    const sessionId = header?.id ?? null;
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.#deleteFileDocs(path);
      for (const doc of docs) {
        const info = this.st.insDoc.run(
          cjkSpace(doc.text),
          sessionId,
          doc.seq,
          doc.kind,
          doc.role,
          doc.time,
        );
        const rid = typeof info.lastInsertRowid === 'bigint' ? Number(info.lastInsertRowid) : info.lastInsertRowid;
        this.st.insPath.run(path, rid);
      }
      this.st.upsertFile.run(path, size, mtimeMs, sessionId, docs.length, now);
      if (sessionId) {
        this.st.upsertSession.run(sessionId, header?.cwd ?? null, header?.createdAt ?? null, title, now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return docs.length;
  }

  /** 文件已消失：只清索引，保留 sessions 行（历史仍可在结果里显示）。 */
  removeFile(path) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const n = this.#deleteFileDocs(path);
      this.db.exec('COMMIT');
      return n;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 丢弃整个索引并重建空库。 */
  reset() {
    this.db.exec('DROP TABLE IF EXISTS docs');
    this.db.exec('DROP TABLE IF EXISTS doc_paths');
    this.db.exec('DROP TABLE IF EXISTS files');
    this.db.exec('DROP TABLE IF EXISTS sessions');
    this.#create();
    this.#prepare();
  }

  stats() {
    return {
      docs: this.st.countDocs.get().n,
      sessions: this.st.countSessions.get().n,
      files: this.st.countFiles.get().n,
    };
  }

  /**
   * 两阶段查询：①取 bm25 排序后的命中 → ②按会话分组后只对展示的文档取原文、
   * 还原、做窗口高亮。
   *
   * @param {string} q 用户输入
   * @param {{ limit?: number, groupLimit?: number, perSession?: number, includeTotal?: boolean }} [options]
   */
  search(q, options = {}) {
    const { limit = 300, groupLimit = 20, perSession = 6, includeTotal = true } = options;
    const match = toMatch(q);
    const started = performance.now();
    if (!match) return { q, match, took: 0, total: 0, groups: [], empty: true };

    let rows;
    try {
      rows = this.st.hits.all(match, limit);
    } catch (err) {
      return { q, match, took: 0, total: 0, groups: [], error: String(err?.message ?? err) };
    }

    /** @type {Map<string, { sessionId: string, best: number, docs: any[] }>} */
    const groups = new Map();
    for (const row of rows) {
      const key = row.session_id ?? '';
      let group = groups.get(key);
      if (!group) {
        if (groups.size >= groupLimit) continue;
        group = { sessionId: key, best: row.score, docs: [] };
        groups.set(key, group);
      }
      if (group.docs.length >= perSession) continue;
      group.docs.push(row);
    }

    const ids = [];
    for (const group of groups.values()) for (const doc of group.docs) ids.push(doc.rid);

    /** @type {Map<number, string>} */
    const texts = new Map();
    if (ids.length) {
      for (const row of this.st.texts.all(JSON.stringify(ids))) texts.set(row.rid, row.text);
    }

    const words = queryWords(q);
    const sessionIds = [...groups.keys()].filter(Boolean);
    /** @type {Map<string, any>} */
    const metas = new Map();
    if (sessionIds.length) {
      for (const row of this.st.sessionsById.all(JSON.stringify(sessionIds))) metas.set(row.session_id, row);
    }

    const out = [];
    for (const group of groups.values()) {
      const meta = metas.get(group.sessionId) ?? {};
      out.push({
        sessionId: group.sessionId,
        title: meta.title ?? null,
        cwd: meta.cwd ?? null,
        createdAt: meta.created_at ?? null,
        docs: group.docs.map((doc) => {
          const raw = texts.get(doc.rid);
          const snippet = buildSnippet(raw === undefined ? '' : cjkUnspace(raw), words);
          return {
            seq: doc.seq,
            kind: doc.kind,
            role: doc.role,
            time: doc.time,
            snippet: snippet.segments,
            matched: snippet.matched,
          };
        }),
      });
    }

    const total = includeTotal ? this.st.hitCount.get(match).n : rows.length;
    return {
      q,
      match,
      took: Math.round((performance.now() - started) * 100) / 100,
      total,
      groups: out,
      truncated: total > ids.length,
    };
  }

  /**
   * 把 WAL 落回主库并截断。
   * 整库重建会往 WAL 里灌几十 MB，不截断的话磁盘上会一直留着这份尾巴。
   * 有读者正在用（面板搜索）时 checkpoint 会失败，直接忽略，下一轮再来。
   */
  checkpoint() {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return true;
    } catch {
      return false;
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* 已关闭 */
    }
  }
}
