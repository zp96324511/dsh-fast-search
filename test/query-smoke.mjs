/**
 * 查询语法与筛选的集成冒烟：临时库 + 三条会话，覆盖
 *   空格 AND / 显式 AND·OR / 括号 / 引号短语 / 前缀 / 语法错误降级
 *   工作区（含末尾斜杠与大小写）/ since / until / 消息类型 / 组合筛选 / workspaces 列表
 *
 * 这里直接打 Store（不经 HTTP），因为筛选最终必须落到 SQL 上——只有真库能证明
 * `total`、分组与截断都受同一个 WHERE 约束。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { compileQuery, toMatch } from '../src/tokenize.js';

/* ------------------------------------------------------------------ *
 * 1. 纯解析器
 * ------------------------------------------------------------------ */
const cases = [
  ['插件 缓存', '"插 件" "缓 存"', 'legacy', null],
  ['插件 AND 缓存', '"插 件" AND "缓 存"', 'boolean', null],
  ['插件 且 缓存', '"插 件" AND "缓 存"', 'boolean', null],
  ['插件 OR 缓存', '"插 件" OR "缓 存"', 'boolean', null],
  ['插件 或 缓存', '"插 件" OR "缓 存"', 'boolean', null],
  ['插件 | 缓存', '"插 件" OR "缓 存"', 'boolean', null],
  ['(插件 OR 缓存) AND 索引', '("插 件" OR "缓 存") AND "索 引"', 'boolean', null],
  ['插件 (缓存 OR 索引)', '"插 件" AND ("缓 存" OR "索 引")', 'boolean', null],
  ['"node sqlite"', '"node sqlite"', 'legacy', null],
  ['mmap*', '"mmap"*', 'legacy', null],
  ['"mmap"*', '"mmap"*', 'legacy', null],
  ['"a ""b"" c"', '"a ""b"" c"', 'legacy', null],
  ['A (B OR C)', '"A" AND ("B" OR "C")', 'boolean', null],
  ['A OR', '"A"', 'fallback', 'missing-operand'],
  ['(插件 缓存', '"插 件" AND "缓 存"', 'fallback', 'unbalanced-paren'],
  ['A)', '"A"', 'fallback', 'unbalanced-paren'],
  ['（）', '', 'empty', null],
];
for (const [q, match, syntax, error] of cases) {
  const out = compileQuery(q);
  assert.equal(out.match, match, `match ${q}`);
  assert.equal(out.syntax, syntax, `syntax ${q}`);
  assert.equal(out.error, error, `error ${q}`);
}
assert.deepEqual(compileQuery('"插 件"').words, ['插件'], '引号里的 CJK 空格要折叠');
assert.deepEqual(compileQuery('"node sqlite"').words, ['node sqlite', 'node', 'sqlite'], '多词短语补高亮词');
assert.deepEqual(compileQuery('"a ""b"" c"').words, ['a "b" c', 'a', '"b"', 'c'], '双引号连写是一个字面引号');
assert.equal(toMatch('插件'), '"插 件"');

/* ------------------------------------------------------------------ *
 * 2. 真库
 * ------------------------------------------------------------------ */
const root = mkdtempSync(path.join(tmpdir(), 'dsh-fast-search-query-'));
const db = path.join(root, 'index.db');
const store = new Store(db);
try {
  store.replaceFile('s1.jsonl', {
    size: 1,
    mtimeMs: 1,
    header: { id: 's1', cwd: 'C:\\alpha', createdAt: 1_000 },
    title: 'Alpha 会话',
    docs: [
      { seq: 1, kind: 'user/message', role: 'user', time: 1_000, text: '插件 缓存 实现' },
      { seq: 2, kind: 'assistant/message', role: 'assistant', time: 2_000, text: '缓存 命中 说明' },
    ],
  });
  store.replaceFile('s2.jsonl', {
    size: 1,
    mtimeMs: 1,
    header: { id: 's2', cwd: 'C:\\beta', createdAt: 3_000 },
    title: 'Beta 会话',
    docs: [
      { seq: 1, kind: 'user/message', role: 'user', time: 3_000, text: '插件 索引 重建' },
      { seq: 2, kind: 'assistant/message', role: 'assistant', time: 4_000, text: '索引 缓存 复查' },
      { seq: 3, kind: 'tool/call', role: 'assistant', time: 3_500, text: '类型 工具调用 参数' },
      { seq: 4, kind: 'tool/result', role: 'tool', time: 3_600, text: '类型 工具结果 输出' },
    ],
  });
  store.replaceFile('s3.jsonl', {
    size: 1,
    mtimeMs: 1,
    header: { id: 's3', cwd: 'C:\\alpha', createdAt: 5_000 },
    title: 'Alpha 追加',
    docs: [
      { seq: 1, kind: 'user/message', role: 'user', time: 5_000, text: '插件 缓存 索引 三件套' },
      { seq: 2, kind: 'session/title', role: 'title', time: 5_000, text: '类型 会话标题' },
    ],
  });

  const sids = (result) => result.groups.map((group) => group.sessionId).sort();

  const and = store.search('插件 缓存');
  assert.equal(and.total, 2, '空格是 AND');
  assert.deepEqual(sids(and), ['s1', 's3']);

  const or = store.search('插件 OR 缓存');
  assert.equal(or.total, 5, 'OR 取并集');

  const grouped = store.search('(插件 OR 缓存) AND 索引');
  assert.equal(grouped.total, 3, '括号 + OR + AND');
  assert.deepEqual(sids(grouped), ['s2', 's3']);

  const phrase = store.search('"插件 缓存"');
  assert.equal(phrase.total, 2, '引号短语');
  assert.deepEqual(sids(phrase), ['s1', 's3']);

  const prefix = store.search('重*');
  assert.equal(prefix.total, 1, '显式前缀');
  assert.deepEqual(sids(prefix), ['s2']);

  const fallback = store.search('(插件 缓存');
  assert.equal(fallback.total, 2, '语法错误降级为 AND，不返回 0 条');
  assert.equal(fallback.syntax, 'fallback');
  assert.equal(fallback.parseError, 'unbalanced-paren');

  const alpha = store.search('缓存', { workspace: 'C:\\alpha' });
  assert.equal(alpha.total, 3, '工作区筛选');
  assert.deepEqual(sids(alpha), ['s1', 's3']);
  assert.equal(alpha.groups.find((group) => group.sessionId === 's1').lastTime, 2_000);

  const alphaSlash = store.search('缓存', { workspace: 'C:\\alpha\\' });
  assert.equal(alphaSlash.total, 3, '容忍工作区末尾斜杠');

  const alphaCase = store.search('缓存', { workspace: 'c:\\ALPHA' });
  assert.equal(alphaCase.total, 3, 'Windows 路径大小写不敏感');

  const betaSince = store.search('缓存', { workspace: 'C:\\beta', since: 3_500 });
  assert.equal(betaSince.total, 1, '工作区 + since');
  assert.deepEqual(sids(betaSince), ['s2']);

  const until = store.search('缓存', { until: 1_500 });
  assert.equal(until.total, 1, 'until');
  assert.deepEqual(sids(until), ['s1']);

  const missing = store.search('缓存', { workspace: 'C:\\nope' });
  assert.equal(missing.total, 0, '不存在的工作区直接 0 条');
  assert.deepEqual(missing.groups, []);

  const filter = store.createFilter({ workspace: 'C:\\alpha', since: 1_500 });
  const allowed = store.ridFilter(filter);
  assert.ok(allowed instanceof Set && allowed.size === 3, '语义召回用的 rid 过滤集合');

  /* 消息类型筛选：类型是索引里的会话事件 `type`，与工作区/时间同一层 WHERE */
  const typed = store.search('类型');
  assert.equal(typed.total, 3, '工具调用 / 工具结果 / 会话标题各一条');
  assert.deepEqual(sids(typed), ['s2', 's3']);

  const toolOnly = store.search('类型', { kinds: ['tool/call'] });
  assert.equal(toolOnly.total, 1, '按消息类型筛选');
  assert.equal(toolOnly.groups[0].docs[0].kind, 'tool/call');
  assert.deepEqual(toolOnly.filters.kinds, ['tool/call'], '筛选回显规范化后的类型');

  const resultOnly = store.search('类型', { kinds: 'result' });
  assert.equal(resultOnly.total, 1, '短名别名等价于 tool/result');
  assert.equal(resultOnly.groups[0].docs[0].kind, 'tool/result');

  const bothTools = store.search('类型', { kinds: ['tool/call', 'tool/result'] });
  assert.equal(bothTools.total, 2, '多个类型取并集');

  const titleOnly = store.search('类型', { kinds: 'title' });
  assert.equal(titleOnly.total, 1, '会话标题也能单独筛');
  assert.equal(titleOnly.groups[0].docs[0].kind, 'session/title');

  const userOnly = store.search('类型', { kinds: ['user/message'] });
  assert.equal(userOnly.total, 0, '没有用户消息时类型筛选是真的 0 条');

  const kindAlpha = store.search('类型', { kinds: ['tool/result'], workspace: 'C:\\alpha' });
  assert.equal(kindAlpha.total, 0, '类型与工作区叠加');
  const kindBeta = store.search('类型', { kinds: ['tool/result'], workspace: 'C:\\beta' });
  assert.equal(kindBeta.total, 1);

  const kindUntil = store.search('类型', { kinds: ['tool/result'], until: 3_650 });
  assert.equal(kindUntil.total, 1, '类型与时间窗叠加');

  const normalized = store.createFilter({ kinds: [' User ', 'result', 'nope', 'tool/result'] });
  assert.deepEqual(normalized.kinds, ['user/message', 'tool/result'], '别名归一、去重、忽略未知值');
  assert.equal(store.createFilter({ kinds: [] }).kinds, null, '空数组 = 不筛选');

  const kindRids = store.ridFilter(store.createFilter({ kinds: ['tool/result'] }));
  assert.ok(kindRids instanceof Set && kindRids.size === 1, '语义召回的 rid 集合也要受类型约束');

  const list = store.workspaces();
  assert.deepEqual(list.map((item) => item.cwd), ['C:\\alpha', 'C:\\beta'], '按最近消息倒序');
  assert.deepEqual(list.map((item) => item.sessions), [2, 1]);
  assert.deepEqual(list.map((item) => item.docs), [4, 4]);
  assert.equal(list[0].updatedAt, 5_000);

  console.log(`query-smoke ok：${cases.length} 组语法 + 16 组筛选/类型断言`);
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
