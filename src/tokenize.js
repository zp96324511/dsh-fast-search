/**
 * 分词桥接：**建索引时把 CJK 逐字拆开，查询时用引号短语拼回去**。
 *
 * 为什么不是 trigram：P0 基准（docs/p0-baseline.md §4）在 5,408 个真实会话日志上
 * 实测，trigram 对 2 字中文词（插件/搜索/索引/会话/基准/的）召回全部为 0，而中文
 * 检索的主要形态就是 2 字词；且索引体积 214MB 是 unicode61 的 2.2 倍。
 *
 * 为什么不是原生 unicode61：它把连续中文当成一个 token，"中文搜索"里的"搜索"
 * 根本不在 token 表里（实测 "索引" 只命中 35 条 / 真值 477 条）。
 *
 * 所以：索引期 `插 件` 这样的单字 token 交给 unicode61（英文/代码照旧按词切），
 * 查询期把 `插件` 还原成短语 `"插 件"`。实测召回与全表字面扫描逐条相等，
 * 索引体积只比原生大 2.7%。
 *
 * 查询语法在这一层编译成 FTS5 表达式（见 {@link compileQuery}）：
 *   `插件 缓存`            → AND（空格是隐式的）
 *   `插件 OR 缓存`         → OR（也接受 `或` / `|` / `||`）
 *   `(插件 OR 缓存) AND 索引` → 括号分组，优先级 AND > OR（本版没有 NOT）
 *   `"node sqlite"`        → 显式短语
 *   `mmap*`                → 前缀（布尔模式下前缀必须显式写 `*`）
 * 每个词都会先被包进引号短语，用户输入里的 FTS5 语法字符不会穿透到 MATCH。
 */

const CJK_CLASS =
  '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3040-\\u30FF\\uAC00-\\uD7AF';

/** 匹配任意一个 CJK 字符（含扩展 A、兼容区、假名、谚文）。 */
export const CJK_ONE = new RegExp(`[${CJK_CLASS}]`);

/** 匹配连续 CJK 字符，用于全局替换。 */
export const CJK_ALL = new RegExp(`[${CJK_CLASS}]`, 'g');

/** CJK 字符之间的空白（只在生成高亮词时折叠）。 */
const CJK_GAP = new RegExp(`([${CJK_CLASS}])\\s+(?=[${CJK_CLASS}])`, 'g');

/** @param {string} ch @returns {boolean} */
export const isCJK = (ch) => CJK_ONE.test(ch);

/**
 * 建索引用的文本：每个 CJK 字符前后各插一个空格。
 * 原文里本来就有的空格一个都不动（不动 `[ \t]+` 折叠，代码缩进要保住）。
 * @param {string} s
 * @returns {string}
 */
export function cjkSpace(s) {
  return s.replace(CJK_ALL, (c) => ` ${c} `);
}

/** 按 UTF-16 码元判断是否 CJK：比 `CJK_ONE.test()` 快一个量级（长文本逐字扫描时很关键）。 */
export function isCjkCode(code) {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

/**
 * {@link cjkSpace} 的精确逆变换，展示前必须调用。
 *
 * 只删「自己插入的那一个」前导/后继空格，所以原文本来就有的空格（`hello 世界`
 * 在索引里是 `hello  世  界 `）会恰好剩下一个。
 *
 * 实现注意：第一版用 `out += ch` 再 `out.endsWith(' ')` + `out.slice(0,-1)` 回退，
 * 每遇到一个中文字符就把整条 rope 压平一次，实测 120 篇文档要 60ms（O(n²)）。
 * 改成「按码元判断 + 分片数组 join」后降到 3ms。
 * @param {string} s
 * @returns {string}
 */
export function cjkUnspace(s) {
  const n = s.length;
  const parts = [];
  let buf = '';
  for (let i = 0; i < n; i++) {
    const code = s.charCodeAt(i);
    if (!isCjkCode(code)) {
      buf += s[i];
      continue;
    }
    if (buf.endsWith(' ')) buf = buf.slice(0, -1);
    if (buf) parts.push(buf);
    buf = '';
    parts.push(s[i]);
    if (s[i + 1] === ' ') i += 1;
  }
  if (buf) parts.push(buf);
  return parts.join('');
}

/** 词里是否还有可检索的字符（纯标点/纯符号的 query 词直接丢掉）。 */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** 查询里的布尔运算符（大小写不敏感；引号里的同名文本仍是普通词）。 */
const AND_WORDS = new Set(['and', '且', '＆']);
const OR_WORDS = new Set(['or', '或', '｜']);

/**
 * 把用户输入切成查询 token。
 *
 * token 形态：
 *   `{ type: 'word', text, quoted, prefix }`
 *   `{ type: 'and' }` / `{ type: 'or' }`
 *   `{ type: '(' }` / `{ type: ')' }`
 *
 * 引号里的一切都是字面量（支持 `"..."`、`“...”`；`""` 与 `\"` 表示引号本身）；
 * 词尾的 `*` 是前缀标记。括号接受半角与全角。
 *
 * @param {string} raw
 * @returns {Array<object>}
 */
function lexQuery(raw) {
  const tokens = [];
  const n = raw.length;
  let i = 0;
  while (i < n) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(' || ch === '（') {
      tokens.push({ type: '(' });
      i += 1;
      continue;
    }
    if (ch === ')' || ch === '）') {
      tokens.push({ type: ')' });
      i += 1;
      continue;
    }
    if (ch === '"' || ch === '“' || ch === '”') {
      /* 半角引号配半角；中文引号允许用任意一半开、用右引号或半角引号收。 */
      const close = ch === '"' ? '"' : '”';
      let j = i + 1;
      let text = '';
      let prefix = false;
      while (j < n) {
        const c = raw[j];
        if (c === '\\' && (raw[j + 1] === close || raw[j + 1] === '"')) {
          text += raw[j + 1];
          j += 2;
          continue;
        }
        /* FTS5 的短语转义写法：双引号连写表示一个字面双引号。
         * 必须先于「闭合引号」判断，否则 `"a ""b"" c"` 会在第一个 `""` 处提前收尾。 */
        if (c === '"' && raw[j + 1] === '"') {
          text += '"';
          j += 2;
          continue;
        }
        if (c === close || (close === '”' && c === '"')) {
          j += 1;
          break;
        }
        text += c;
        j += 1;
      }
      if (raw[j] === '*') {
        prefix = true;
        j += 1;
      }
      tokens.push({ type: 'word', text, quoted: true, prefix });
      i = j;
      continue;
    }

    let j = i;
    while (j < n && !/\s/.test(raw[j]) && !'()（）'.includes(raw[j])) j += 1;
    const text = raw.slice(i, j);
    i = j;
    if (text === '') {
      i += 1;
      continue;
    }
    const lower = text.toLowerCase();
    if (text === '&' || text === '&&' || AND_WORDS.has(lower)) {
      tokens.push({ type: 'and' });
      continue;
    }
    if (text === '|' || text === '||' || OR_WORDS.has(lower)) {
      tokens.push({ type: 'or' });
      continue;
    }
    tokens.push({ type: 'word', text, quoted: false, prefix: text.endsWith('*') });
  }
  return tokens;
}

/**
 * 单个查询词 → 可拼进 MATCH 的引号短语。
 *
 * CJK 逐字拆开后用空格连接（`插件` → `"插 件"`），非 CJK 段保持原样；
 * 这样既命中索引里逐字插空格的形态，也不会让 `_`、`-`、`.` 之类变成 FTS 语法。
 *
 * @param {{ text: string, quoted?: boolean, prefix?: boolean }} token
 * @returns {{ type: 'term', text: string, phrase: string, prefix: boolean,
 *             quoted: boolean, ascii: boolean, length: number } | null}
 */
function makeTerm(token) {
  let text = String(token.text ?? '').replace(/\s+/g, ' ').trim();
  let prefix = token.prefix === true;
  if (!token.quoted && text.endsWith('*')) {
    prefix = true;
    text = text.slice(0, -1).trim();
  }
  if (text === '') return null;

  const tokens = [];
  let buf = '';
  let hasCJK = false;
  for (const ch of text) {
    if (/\s/.test(ch)) {
      /* 短语内部的空白只是分隔符：`"插 件"` 必须还原成 `"插 件"`，
       * 不能把空格本身当成一个 token（会变成 `插   件`，高亮也会拆成单字）。 */
      if (buf) {
        tokens.push(buf);
        buf = '';
      }
      continue;
    }
    if (isCJK(ch)) {
      hasCJK = true;
      if (buf) {
        tokens.push(buf);
        buf = '';
      }
      tokens.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);
  if (!tokens.some((part) => WORD_CHAR.test(part))) return null;

  return {
    type: 'term',
    text,
    phrase: `"${tokens.join(' ').replace(/"/g, '""')}"`,
    prefix,
    quoted: token.quoted === true,
    ascii: !hasCJK,
    length: text.length,
  };
}

/** 合并同类型的 AND/OR 节点，渲染时少一层括号。 */
function combine(type, left, right) {
  if (left.type === type && right.type === type) {
    return { type, children: [...left.children, ...right.children] };
  }
  if (left.type === type) return { type, children: [...left.children, right] };
  if (right.type === type) return { type, children: [left, ...right.children] };
  return { type, children: [left, right] };
}

/**
 * 递归下降：OR 的优先级最低，AND 次之，括号最高。
 * 相邻两个操作数（词或左括号）之间是隐式 AND，保持 `插件 缓存` 的旧行为。
 * @param {Array<object>} tokens
 */
function parseTokens(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseUnary() {
    const token = peek();
    if (token === undefined) throw { code: 'missing-operand' };
    if (token.type === '(') {
      next();
      if (peek()?.type === ')') {
        next();
        throw { code: 'empty-group' };
      }
      const node = parseOr();
      if (peek()?.type !== ')') throw { code: 'unbalanced-paren' };
      next();
      return node;
    }
    if (token.type === 'word') {
      next();
      return token.term;
    }
    if (token.type === ')') throw { code: 'unexpected-close' };
    throw { code: 'missing-operand' };
  }

  function parseAnd() {
    let left = parseUnary();
    for (;;) {
      const token = peek();
      if (token === undefined) break;
      if (token.type === 'and') {
        next();
        left = combine('and', left, parseUnary());
        continue;
      }
      /* 隐式 AND：`A B`、`) (` 都按同时出现处理 */
      if (token.type === 'word' || token.type === '(') {
        left = combine('and', left, parseUnary());
        continue;
      }
      break;
    }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (peek()?.type === 'or') {
      next();
      left = combine('or', left, parseAnd());
    }
    return left;
  }

  const ast = parseOr();
  if (pos !== tokens.length) {
    throw { code: peek()?.type === ')' ? 'unbalanced-paren' : 'unexpected-token' };
  }
  return ast;
}

const PRECEDENCE = { or: 1, and: 2, term: 3 };

/** @param {any} node @param {number} parentPrec */
function renderNode(node, parentPrec) {
  if (node.type === 'term') {
    return node.prefix ? `${node.phrase}*` : node.phrase;
  }
  const prec = PRECEDENCE[node.type];
  const separator = node.type === 'and' ? ' AND ' : ' OR ';
  const body = node.children.map((child) => renderNode(child, prec)).join(separator);
  return prec < parentPrec ? `(${body})` : body;
}

/** 高亮词：引号短语内部的 CJK 空格还原成连续中文，多词短语再补上各个词。 */
function highlightWords(terms) {
  const out = [];
  const seen = new Set();
  const add = (word) => {
    const text = word.trim();
    if (text !== '' && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  };
  for (const term of terms) {
    const whole = term.text.replace(CJK_GAP, '$1');
    add(whole);
    /* 只有还带空格的多词短语才拆开补词；`"插 件"` 折叠后是 `插件`，不该再拆成单字。 */
    if (/\s/.test(whole)) {
      for (const part of whole.split(/\s+/)) add(part);
    }
  }
  return out;
}

/**
 * 用户输入 → `{ match, terms, words, syntax, error }`。
 *
 * `match` 是可直接传给 `MATCH ?` 的 FTS5 表达式；空串表示"没有可检索的词"。
 * 解析失败时**不把错误抛给调用方**：退回旧行为（所有词同时命中），并把
 * `error` 交给面板提示——搜索框永远不应该因为一个多余括号而搜不出东西。
 *
 * @param {string} input 用户原始输入
 * @returns {{ match: string, terms: string[], words: string[],
 *             syntax: 'empty'|'legacy'|'boolean'|'fallback',
 *             error: string | null, explicit: boolean }}
 */
export function compileQuery(input) {
  const raw = String(input ?? '').trim();
  if (raw === '') {
    return { match: '', terms: [], words: [], syntax: 'empty', error: null, explicit: false };
  }

  const lexed = lexQuery(raw);
  /** @type {Array<any>} */
  const tokens = [];
  /** @type {Array<any>} */
  const terms = [];
  for (const token of lexed) {
    if (token.type !== 'word') {
      tokens.push(token);
      continue;
    }
    const term = makeTerm(token);
    if (term === null) continue;
    terms.push(term);
    tokens.push({ type: 'word', term });
  }
  if (terms.length === 0) {
    return { match: '', terms: [], words: [], syntax: 'empty', error: null, explicit: false };
  }

  const explicit = tokens.some((token) => token.type !== 'word');
  let ast = null;
  let error = null;
  try {
    ast = parseTokens(tokens);
  } catch (err) {
    error = typeof err?.code === 'string' ? err.code : 'unexpected-token';
  }

  let match;
  let syntax;
  if (ast !== null) {
    if (explicit) {
      match = renderNode(ast, 0);
      syntax = 'boolean';
    } else {
      /* 旧行为完全保留：空格分隔 = AND，最后一个纯 ASCII 且长度 ≥3 的词自动前缀。
       * 布尔模式不自动加前缀——`A OR B` 里"最后一个词"没有明确语义，要前缀请写 `*`。 */
      const last = terms[terms.length - 1];
      if (!last.quoted && !last.prefix && last.ascii && last.length >= 3) last.prefix = true;
      match = terms.map((term) => (term.prefix ? `${term.phrase}*` : term.phrase)).join(' ');
      syntax = 'legacy';
    }
  } else {
    /* 语法错误：降级成"所有词同时命中"，并保留错误码供面板提示。 */
    match = terms.map((term) => term.phrase).join(' AND ');
    syntax = 'fallback';
  }

  return {
    match,
    terms: terms.map((term) => term.text),
    words: highlightWords(terms),
    syntax,
    error,
    explicit,
  };
}

/**
 * 兼容入口：只要 MATCH 表达式。
 * @param {string} input
 * @returns {string}
 */
export function toMatch(input) {
  return compileQuery(input).match;
}

/**
 * 兼容入口：把 query 拆成用于高亮的字面词。
 * 运算符（AND/OR/且/或/括号）不会出现在结果里；引号短语按原文返回。
 * @param {string} input
 * @returns {string[]}
 */
export function queryWords(input) {
  return compileQuery(input).words;
}
