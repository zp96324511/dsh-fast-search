// P0 基准：全量解码会话日志 → 三种 FTS5 分词方案建库 → 计时查询
// 用法: node bench/p0-bench.mjs [--limit N] [--out DIR] [--cap BYTES]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const LIMIT = Number(arg('limit', 0)) || Infinity;
const OUT = arg('out', join(process.cwd(), 'bench', 'out'));
const CAP = Number(arg('cap', 8192));
const ROOT = join(homedir(), '.dsh', 'sessions');

const now = () => performance.now();
const ms = (a, b) => `${(b - a).toFixed(1)}ms`;

/* ---------- 1. 扫描文件 ---------- */
let t = now();
const files = [];
(function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl.zstd')) files.push(p);
  }
})(ROOT);
const tWalk = ms(t, (t = now()));
files.sort();
if (argv.includes('--sort-size')) files.sort((a, b) => statSync(b).size - statSync(a).size);
const picked = files.slice(0, LIMIT === Infinity ? files.length : LIMIT);

/* ---------- 2. 三种方案的表 ---------- */
const dbs = {};
const openDb = (key, ddl) => {
  const file = join(OUT, `${key}.db`);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-65536;');
  db.exec(ddl);
  return db;
};
const mkDir = (await import('node:fs')).mkdirSync(OUT, { recursive: true });

const SCHEMA = (tok) => `
CREATE TABLE IF NOT EXISTS sessions(session_id TEXT PRIMARY KEY, cwd TEXT, parent_id TEXT, created_at INTEGER, title TEXT);
CREATE TABLE IF NOT EXISTS file_state(path TEXT PRIMARY KEY, session_id TEXT, size INTEGER, mtime_ms INTEGER, line_count INTEGER);
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
  text, session_id UNINDEXED, seq UNINDEXED, type UNINDEXED, role UNINDEXED, time UNINDEXED,
  tokenize='${tok}'
);`;

dbs.s1 = openDb('s1', SCHEMA('unicode61 remove_diacritics 2'));
dbs.s2 = openDb('s2', SCHEMA('unicode61 remove_diacritics 2'));
if (arg('dbs', 's1,s2').split(',').includes('s3')) dbs.s3 = openDb('s3', SCHEMA('trigram'));

const ins = (db) => db.prepare(
  'INSERT INTO docs(text, session_id, seq, type, role, time) VALUES(?,?,?,?,?,?)',
);
const prep = {};
for (const k of Object.keys(dbs)) prep[k] = ins(dbs[k]);
for (const k of Object.keys(dbs)) dbs[k].prepare('DELETE FROM docs').run();

/* ---------- 3. 文本抽取 ---------- */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const CJK_CHAR_RE = /([\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF])/g;

const cjkSpace = (s) => s.replace(CJK_CHAR_RE, ' $1 ').replace(/[ \t]+/g, ' ');

function joinParts(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') out += part.text;
    else if (part.type === 'tool-call') out += ` ${part.name} ${part.arguments ?? ''}`;
  }
  return out;
}

const stats = {
  files: 0, lines: 0, parsedEvents: 0, docs: 0,
  rawBytes: 0, textBytes: 0, cappedTextBytes: 0, reasoningChars: 0,
  perType: new Map(), badLines: 0, unsupported: 0,
  tRead: 0, tDecomp: 0, tParse: 0, tInsert: { s1: 0, s2: 0, s3: 0 },
  fileTimes: [], errors: [],
};

function buildDocs(buf) {
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const docs = [];
  let header = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 12) continue;
    stats.lines++;
    // 快速取 type，避免对非目标行做 JSON.parse
    let type;
    if (line.charCodeAt(0) === 123 /* { */) {
      const s = line.indexOf('"type":"');
      if (s < 0) continue;
      const e = line.indexOf('"', s + 8);
      type = line.slice(s + 8, e);
    } else continue;

    if (type === 'session') {
      try { header = JSON.parse(line); } catch { stats.badLines++; }
      continue;
    }
    if (type !== 'user/message' && type !== 'assistant/message' && type !== 'tool/call' &&
        type !== 'tool/result' && type !== 'session/title' && type !== 'system/message') continue;

    let ev;
    try { ev = JSON.parse(line); } catch { stats.badLines++; continue; }
    stats.parsedEvents++;
    stats.perType.set(type, (stats.perType.get(type) ?? 0) + 1);
    const d = ev.data ?? {};
    let txt = '';
    let role = '';
    switch (type) {
      case 'user/message':
        txt = joinParts(d.content);
        role = d.role ?? 'user';
        break;
      case 'assistant/message': {
        const msg = d.message ?? {};
        txt = joinParts(msg.content);
        for (const p of msg.content ?? []) if (p?.type === 'reasoning') stats.reasoningChars += (p.text ?? '').length;
        role = 'assistant';
        break;
      }
      case 'tool/call':
        txt = `${d.name ?? ''}\n${d.arguments ?? ''}`;
        role = 'tool';
        break;
      case 'tool/result':
        txt = joinParts(d.message?.content);
        role = 'tool';
        break;
      case 'system/message':
        txt = joinParts(d.content);
        role = 'system';
        break;
      case 'session/title':
        docs.push({ text: d.title ?? '', seq: ev.seq, type, role: 'title', time: ev.time, title: d.title });
        continue;
      default:
        continue;
    }
    if (!txt || !txt.trim()) continue;
    stats.textBytes += Buffer.byteLength(txt);
    let capped = txt;
    if (CAP > 0 && txt.length > CAP) capped = txt.slice(0, CAP);
    stats.cappedTextBytes += Buffer.byteLength(capped);
    docs.push({ text: capped, seq: ev.seq, type, role, time: ev.time });
  }
  return { header, docs };
}

const sessionStmt = (db) => db.prepare(
  'INSERT INTO sessions(session_id,cwd,parent_id,created_at,title) VALUES(?,?,?,?,?) ' +
  'ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd, parent_id=excluded.parent_id, title=excluded.title',
);

const perFile = [];
for (const path of picked) {
  const t0 = now();
  let raw;
  try {
    raw = readFileSync(path);
  } catch (err) {
    stats.errors.push(`${path}: ${err.message}`);
    continue;
  }
  const t1 = now();
  stats.rawBytes += raw.length;
  let buf;
  try {
    buf = zstdDecompressSync(raw);
  } catch (err) {
    stats.errors.push(`${path}: zstd: ${err.message}`);
    continue;
  }
  const t2 = now();
  const { header, docs } = buildDocs(buf);
  const t3 = now();
  if (header?.version && header.version !== 4) stats.unsupported++;

  for (const k of Object.keys(dbs)) {
    const ti = now();
    const p = prep[k];
    dbs[k].exec('BEGIN');
    if (header?.id) {
      for (const doc of docs) {
        if (doc.type === 'session/title') {
          sessionStmt(dbs[k]).run(header.id, header.cwd ?? null, header.parentId ?? null, header.createdAt ?? null, doc.title ?? null);
        }
      }
      if (!docs.some((d) => d.type === 'session/title')) {
        sessionStmt(dbs[k]).run(header.id, header.cwd ?? null, header.parentId ?? null, header.createdAt ?? null, null);
      }
    }
    if (k === 's2') {
      for (const doc of docs) p.run(cjkSpace(doc.text), header?.id ?? '', doc.seq ?? 0, doc.type, doc.role, doc.time ?? 0);
    } else {
      for (const doc of docs) p.run(doc.text, header?.id ?? '', doc.seq ?? 0, doc.type, doc.role, doc.time ?? 0);
    }
    dbs[k].exec('COMMIT');
    stats.tInsert[k] += now() - ti;
  }
  const t4 = now();
  stats.files++;
  stats.docs += docs.length;
  stats.tRead += t1 - t0;
  stats.tDecomp += t2 - t1;
  stats.tParse += t3 - t2;
  stats.fileTimes.push(t4 - t0);
  if (stats.files % 500 === 0) console.log(`  ...${stats.files} files`);
}

const tAfterBuild = now();
for (const k of Object.keys(dbs)) dbs[k].exec("INSERT INTO docs(docs) VALUES('optimize')");

/* ---------- 4. 查询基准 ---------- */
const QUERIES = [
  ['插件', 'zh2'], ['搜索', 'zh2'], ['会话', 'zh2'], ['索引', 'zh2'],
  ['基准', 'zh2'], ['工作区', 'zh3'], ['PowerShell', 'en'], ['session', 'en'],
  ['nvm', 'en3'], ['的', 'zh1-hot'], ['the', 'en-hot'],
];

function toMatchQuery(q) {
  return q.split(/\s+/).filter(Boolean).map((w) => {
    if (!CJK_RE.test(w)) return w;
    return '"' + [...w].join(' ') + '"';
  }).join(' ');
}

const stmtCount = (db) => db.prepare('SELECT count(*) c FROM docs WHERE docs MATCH ?');
const stmtHits = (db) => db.prepare(
  'SELECT session_id, seq, bm25(docs) AS score FROM docs WHERE docs MATCH ? ORDER BY score LIMIT 300',
);
const stmtSnip = (db) => db.prepare(
  `SELECT session_id, seq, bm25(docs) AS score, snippet(docs,0,'[',']','…',12) AS s
   FROM docs WHERE docs MATCH ? ORDER BY score LIMIT 300`,
);

function timeIt(fn, iters = 15) {
  const times = [];
  let out;
  for (let i = 0; i < iters; i++) {
    const a = now();
    try { out = fn(); } catch (e) { return { err: e.message, p50: -1, p95: -1, max: -1 }; }
    times.push(now() - a);
  }
  times.sort((a, b) => a - b);
  return {
    p50: +times[Math.floor(times.length * 0.5)].toFixed(2),
    p95: +times[Math.min(times.length - 1, Math.floor(times.length * 0.95))].toFixed(2),
    max: +times[times.length - 1].toFixed(2),
    rows: Array.isArray(out) ? out.length : out?.c,
  };
}

const report = { build: {}, sizes: {}, queries: [] };
for (const k of Object.keys(dbs)) {
  dbs[k].exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const size = readFileSync(join(OUT, `${k}.db`)).length;
  report.sizes[k] = {
    dbMB: +(size / 1048576).toFixed(1),
    docs: dbs[k].prepare('SELECT count(*) c FROM docs').get().c,
  };
  for (const [q, tag] of QUERIES) {
    const match = k === 's2' ? toMatchQuery(q) : q;
    const c = timeIt(() => stmtCount(dbs[k]).all(match));
    const h = timeIt(() => stmtHits(dbs[k]).all(match));
    const s = timeIt(() => stmtSnip(dbs[k]).all(match));
    report.queries.push({ db: k, q, tag, match, total: h.rows, countMs: c.p50, hitsP50: h.p50, hitsP95: h.p95, snipP50: s.p50, snipP95: s.p95, snipMax: s.max, err: h.err ?? s.err ?? c.err });
  }
}

report.build = {
  walk: tWalk,
  files: stats.files,
  lines: stats.lines,
  parsedEvents: stats.parsedEvents,
  docs: stats.docs,
  errors: stats.errors.length,
  badLines: stats.badLines,
  unsupported: stats.unsupported,
  rawMB: +(stats.rawBytes / 1048576).toFixed(1),
  textMB: +(stats.textBytes / 1048576).toFixed(1),
  cappedTextMB: +(stats.cappedTextBytes / 1048576).toFixed(1),
  capBytes: CAP,
  reasoningMB: +(stats.reasoningChars / 1048576).toFixed(1),
  wall: ms(t, tAfterBuild),
  tRead: `${stats.tRead.toFixed(0)}ms`,
  tDecomp: `${stats.tDecomp.toFixed(0)}ms`,
  tParse: `${stats.tParse.toFixed(0)}ms`,
  tInsert: Object.fromEntries(Object.entries(stats.tInsert).map(([k, v]) => [k, `${v.toFixed(0)}ms`])),
  perType: Object.fromEntries([...stats.perType].sort((a, b) => b[1] - a[1])),
};
const ft = stats.fileTimes.slice().sort((a, b) => a - b);
report.perFile = {
  p50: ft[Math.floor(ft.length * 0.5)]?.toFixed(1),
  p95: ft[Math.floor(ft.length * 0.95)]?.toFixed(1),
  max: ft[ft.length - 1]?.toFixed(1),
};

console.log(JSON.stringify(report.build, null, 2));
console.log(JSON.stringify(report.sizes, null, 2));
console.table(report.queries);
const label = arg('label', 'run');
const jsonPath = join(OUT, `report-${label}.json`);
(await import('node:fs')).writeFileSync(jsonPath, JSON.stringify(report, null, 2));
console.log('report:', jsonPath);
for (const k of Object.keys(dbs)) dbs[k].close();
