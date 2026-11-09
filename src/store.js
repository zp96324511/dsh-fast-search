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
import { cjkSpace, cjkUnspace, compileQuery } from './tokenize.js';
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
/* 反查索引：向量流水线按文档批量取"这条文档属于哪个文件"，没有它每次都是全表扫 */
CREATE INDEX IF NOT EXISTS doc_paths_rid ON doc_paths(rid);

-- 语义索引（可选，见 src/vectors.js）。关掉开关时这些表保持为空，不占空间。
CREATE TABLE IF NOT EXISTS vec_meta(
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS vec_chunks(
  slot     INTEGER PRIMARY KEY,
  path     TEXT NOT NULL,
  chunk_ix INTEGER NOT NULL,
  rid      INTEGER NOT NULL,
  start    INTEGER NOT NULL,
  len      INTEGER NOT NULL,
  hash     TEXT NOT NULL,
  scale    REAL NOT NULL,
  vec      BLOB NOT NULL,
  UNIQUE(path, hash)
);
CREATE INDEX IF NOT EXISTS vec_chunks_path ON vec_chunks(path);
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
    /* 带筛选的 SQL 有 8 种 AND 组合，按 SQL 文本缓存 prepare 结果，别每次查询都解析一遍 */
    this.dynamic = new Map();
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
      /* 工作区筛选：面板传的是 sessions.cwd 的原值，Windows 盘符/路径大小写不敏感 */
      sessionIdsByCwd: db.prepare('SELECT session_id FROM sessions WHERE cwd = ? COLLATE NOCASE'),
      /* 工作区下拉列表：分开取「会话 → cwd」与「每条会话的消息数/最近时间」再在 JS 合并。
       * 不能在一条 SQL 里 LEFT JOIN docs：FTS5 的 session_id 是 UNINDEXED，5k 会话 × 56k 文档
       * 会退化成 3 亿次比较（实测超过 3 分钟），分组聚合后只有 5k 行要 join。 */
      workspaceSessions: db.prepare(
        "SELECT session_id, cwd FROM sessions WHERE cwd IS NOT NULL AND cwd <> ''",
      ),
      workspaceTotals: db.prepare(
        'SELECT session_id, count(*) AS docs, max(time) AS updated_at FROM docs ' +
          'WHERE session_id IS NOT NULL GROUP BY session_id',
      ),
      /* 语义索引用：按事件类型遍历（新的会话文件优先，先让最近的对话可被语义召回） */
      docsForKinds: db.prepare(
        'SELECT d.rowid AS rid, d.kind, d.text, p.path ' +
          'FROM docs d JOIN doc_paths p ON p.rid = d.rowid JOIN files f ON f.path = p.path ' +
          'WHERE d.kind IN (SELECT value FROM json_each(?)) ' +
          'ORDER BY f.mtime_ms DESC, d.rowid',
      ),
      docsForPaths: db.prepare(
        'SELECT d.rowid AS rid, d.kind, d.text, p.path ' +
          'FROM doc_paths p JOIN docs d ON d.rowid = p.rid ' +
          'WHERE p.path IN (SELECT value FROM json_each(?))',
      ),
      countDocsForKinds: db.prepare(
        'SELECT count(*) AS n FROM docs WHERE kind IN (SELECT value FROM json_each(?))',
      ),
      docsByRid: db.prepare(
        'SELECT rowid AS rid, session_id, seq, kind, role, time, text FROM docs ' +
          'WHERE rowid IN (SELECT value FROM json_each(?))',
      ),
    };
  }

  /**
   * 动态 SQL 的 prepare 缓存。筛选条件有「工作区 / 起始时间 / 结束时间」三种，
   * 组合出的 SQL 文本稳定，按文本缓存即可。
   * @param {string} sql
   */
  #dynamic(sql) {
    let statement = this.dynamic.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.dynamic.set(sql, statement);
    }
    return statement;
  }

  /**
   * 把请求参数归一成可执行的筛选条件。
   * `workspace` 是 sessions.cwd 的**精确值**（面板从 /workspaces 拿到的原样传回）；
   * `since` / `until` 是毫秒时间戳，0 表示不设边界。
   *
   * @param {{ workspace?: string, since?: number, until?: number }} [options]
   * @returns {{ workspace: string, sessionIds: string[] | null, since: number, until: number }}
   */
  createFilter({ workspace = '', since = 0, until = 0 } = {}) {
    let cwd = typeof workspace === 'string' ? workspace.trim() : '';
    /* 容忍末尾斜杠：`C:\data\projects\` 与 `C:\data\projects` 视为同一个工作区 */
    if (cwd.length > 3) cwd = cwd.replace(/[\\/]+$/, '');
    const sessionIds = cwd === ''
      ? null
      : this.st.sessionIdsByCwd.all(cwd).map((row) => row.session_id);
    const from = Number.isFinite(Number(since)) && Number(since) > 0 ? Math.trunc(Number(since)) : 0;
    const to = Number.isFinite(Number(until)) && Number(until) > 0 ? Math.trunc(Number(until)) : 0;
    return { workspace: cwd, sessionIds, since: from, until: to };
  }

  /**
   * 筛选条件 → 可出现在 `WHERE` 里的子句与参数（MATCH 之后）。
   * @param {{ sessionIds: string[] | null, since: number, until: number }} filter
   * @param {any[]} params 追加参数
   * @returns {string[]} 条件片段
   */
  #filterClauses(filter, params) {
    const clauses = [];
    if (filter.sessionIds !== null) {
      clauses.push('session_id IN (SELECT value FROM json_each(?))');
      params.push(JSON.stringify(filter.sessionIds));
    }
    if (filter.since > 0) {
      clauses.push('time >= ?');
      params.push(filter.since);
    }
    if (filter.until > 0) {
      clauses.push('time <= ?');
      params.push(filter.until);
    }
    return clauses;
  }

  /** 返回给面板的筛选状态（不含内部 sessionIds）。 */
  #publicFilter(filter) {
    return {
      workspace: filter.workspace === '' ? null : filter.workspace,
      since: filter.since === 0 ? null : filter.since,
      until: filter.until === 0 ? null : filter.until,
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
    this.dynamic.clear();
    this.db.exec('DROP TABLE IF EXISTS docs');
    this.db.exec('DROP TABLE IF EXISTS doc_paths');
    this.db.exec('DROP TABLE IF EXISTS files');
    this.db.exec('DROP TABLE IF EXISTS sessions');
    this.db.exec('DROP TABLE IF EXISTS vec_chunks');
    this.db.exec('DROP TABLE IF EXISTS vec_meta');
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
   * 工作区（项目）列表，供面板筛选下拉用。
   * 按「最近一条消息的时间」倒序——用户最可能想找刚聊过的项目。
   * @returns {Array<{ cwd: string, sessions: number, docs: number, updatedAt: number }>}
   */
  workspaces() {
    /** @type {Map<string, { docs: number, updatedAt: number }>} */
    const totals = new Map();
    for (const row of this.st.workspaceTotals.all()) {
      totals.set(row.session_id, {
        docs: Number(row.docs) || 0,
        updatedAt: Number(row.updated_at) || 0,
      });
    }

    /** @type {Map<string, { cwd: string, sessions: number, docs: number, updatedAt: number }>} */
    const byCwd = new Map();
    for (const row of this.st.workspaceSessions.all()) {
      let item = byCwd.get(row.cwd);
      if (item === undefined) {
        item = { cwd: row.cwd, sessions: 0, docs: 0, updatedAt: 0 };
        byCwd.set(row.cwd, item);
      }
      item.sessions += 1;
      const agg = totals.get(row.session_id);
      if (agg !== undefined) {
        item.docs += agg.docs;
        if (agg.updatedAt > item.updatedAt) item.updatedAt = agg.updatedAt;
      }
    }
    /* 只剩会话元数据、文档都已删除的工作区不放进下拉：选了也搜不到东西。 */
    return [...byCwd.values()]
      .filter((item) => item.docs > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 筛选条件 → 允许参与语义召回的 rowid 集合。`null` 表示不筛选。
   * 语义召回在打分时就要排除范围外的块，否则 topK 会被别的项目/时间段占满，
   * 过滤后反而一条不剩——那是"过滤"而不是"召回"。
   * @param {{ sessionIds: string[] | null, since: number, until: number }} filter
   * @returns {Set<number> | null}
   */
  ridFilter(filter) {
    if (filter.sessionIds === null && filter.since === 0 && filter.until === 0) return null;
    const params = [];
    const clauses = this.#filterClauses(filter, params);
    const sql = `SELECT rowid AS rid FROM docs WHERE ${clauses.join(' AND ')}`;
    const set = new Set();
    for (const row of this.#dynamic(sql).iterate(...params)) set.add(row.rid);
    return set;
  }

  /**
   * 按事件类型遍历文档（语义索引用）。**用迭代器而不是 all()**：把工具输出也纳入时
   * 一次就是 5 万条 / 53MB，全量驻留没必要。
   * @param {string} kindsJson `JSON.stringify(['user/message', …])`
   */
  iterateDocsForKinds(kindsJson) {
    return this.st.docsForKinds.iterate(kindsJson);
  }

  /** @param {string} pathsJson `JSON.stringify([path, …])` */
  docsForPaths(pathsJson) {
    return this.st.docsForPaths.all(pathsJson);
  }

  /** @param {string} ridsJson @returns {Map<number, any>} rid → 文档元数据（含插过空格的 text） */
  docsByRid(ridsJson) {
    const out = new Map();
    for (const row of this.st.docsByRid.all(ridsJson)) out.set(row.rid, row);
    return out;
  }

  /** @param {string} kindsJson */
  countDocsForKinds(kindsJson) {
    return this.st.countDocsForKinds.get(kindsJson);
  }

  /** @param {string} idsJson @returns {any[]} 会话元数据（没有的行就是没索引过） */
  sessionsById(idsJson) {
    return this.st.sessionsById.all(idsJson);
  }

  /**
   * 两阶段查询：①取 bm25 排序后的命中 → ②按会话分组后只对展示的文档取原文、
   * 还原、做窗口高亮。
   *
   * 筛选在**第一阶段之前**生效（MATCH + 工作区/时间条件同一个查询），所以 total、
   * 分组、截断都以筛选后的结果为准，不会出现"显示 20 个会话、实际全是别的项目"。
   *
   * @param {string} q 用户输入
   * @param {{ limit?: number, groupLimit?: number, perSession?: number, includeTotal?: boolean,
   *           workspace?: string, since?: number, until?: number,
   *           filter?: ReturnType<Store['createFilter']> }} [options]
   */
  search(q, options = {}) {
    const { limit = 300, groupLimit = 20, perSession = 6, includeTotal = true } = options;
    const compiled = compileQuery(q);
    const { match } = compiled;
    const filter = options.filter ?? this.createFilter(options);
    const started = performance.now();
    const base = {
      q,
      match,
      terms: compiled.terms,
      words: compiled.words,
      syntax: compiled.syntax,
      parseError: compiled.error ?? null,
      filters: this.#publicFilter(filter),
    };
    if (!match) return { ...base, took: 0, total: 0, groups: [], empty: true };

    /* 工作区不存在（或从未索引）时不必碰 FTS：这是一种常见的手输筛选值 */
    if (filter.sessionIds !== null && filter.sessionIds.length === 0) {
      return { ...base, took: 0, total: 0, groups: [], truncated: false };
    }

    let rows;
    let total;
    try {
      const params = [match];
      const clauses = this.#filterClauses(filter, params);
      const where = ['docs MATCH ?', ...clauses].join(' AND ');
      const hitsSql =
        'SELECT rowid AS rid, session_id, seq, kind, role, time, bm25(docs) AS score ' +
        `FROM docs WHERE ${where} ORDER BY score LIMIT ?`;
      rows = this.#dynamic(hitsSql).all(...params, limit);
      if (includeTotal) {
        total = this.#dynamic(`SELECT count(*) AS n FROM docs WHERE ${where}`).get(...params).n;
      } else {
        total = rows.length;
      }
    } catch (err) {
      return { ...base, took: 0, total: 0, groups: [], error: String(err?.message ?? err) };
    }

    /** @type {Map<string, { sessionId: string, best: number, lastTime: number, docs: any[] }>} */
    const groups = new Map();
    for (const row of rows) {
      const key = row.session_id ?? '';
      let group = groups.get(key);
      if (!group) {
        if (groups.size >= groupLimit) continue;
        group = { sessionId: key, best: row.score, lastTime: Number(row.time) || 0, docs: [] };
        groups.set(key, group);
      } else if ((Number(row.time) || 0) > group.lastTime) {
        group.lastTime = Number(row.time) || 0;
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

    const words = compiled.words;
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
        lastTime: group.lastTime,
        docs: group.docs.map((doc) => {
          const raw = texts.get(doc.rid);
          const snippet = buildSnippet(raw === undefined ? '' : cjkUnspace(raw), words);
          return {
            rid: doc.rid,
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

    return {
      ...base,
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
