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
 */

const CJK_CLASS =
  '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3040-\\u30FF\\uAC00-\\uD7AF';

/** 匹配任意一个 CJK 字符（含扩展 A、兼容区、假名、谚文）。 */
export const CJK_ONE = new RegExp(`[${CJK_CLASS}]`);

/** 匹配连续 CJK 字符，用于全局替换。 */
export const CJK_ALL = new RegExp(`[${CJK_CLASS}]`, 'g');

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
function isCJCode(code) {
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
    if (!isCJCode(code)) {
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

/**
 * 用户输入 → FTS5 MATCH 表达式。
 *
 * 规则：按空白切词；每词包成引号短语（FTS5 里引号内的一切都是字面量，`*`、`-`、
 * `AND`、`NEAR` 都不再是语法）；CJK 字符之间插空格，让 `插件` 变成 `"插 件"`；
 * 词与词之间用空格（隐式 AND）。
 *
 * **前缀**：unicode61 把 `mmap3`、`mmap_size` 这类标识符当成整 token，用户搜 `mmap`
 * 时按 token 精确匹配会漏（实测漏 36/79 条，全是 `mmap3`/`mmap256` 这类带数字尾巴的）。
 * 所以：最后一个词如果是纯 ASCII 且长度 ≥3，自动按前缀匹配（`mmap*`）；用户显式在词尾
 * 写 `*` 也生效（中文短语模板同样支持 `"插 件"*`）。
 *
 * @param {string} input 用户原始输入
 * @returns {string} 可直接传给 `MATCH ?` 的表达式；空串表示"没有可检索的词"
 */
export function toMatch(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  /** @type {Array<{ phrase: string, prefix: boolean, ascii: boolean, length: number }>} */
  const items = [];
  for (const word of raw.split(/\s+/)) {
    let text = word;
    let prefix = false;
    if (text.endsWith('*')) {
      prefix = true;
      text = text.slice(0, -1);
    }
    /* 拆成「连续非 CJK 段」与「单个 CJK 字符」交替的 token 序列 */
    const tokens = [];
    let buf = '';
    let hasCJK = false;
    for (const ch of text) {
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
    if (!tokens.some((t) => WORD_CHAR.test(t))) continue;
    /* 引号内的 `"` 用两个 `"` 转义 */
    items.push({
      phrase: `"${tokens.join(' ').replace(/"/g, '""')}"`,
      prefix,
      ascii: !hasCJK,
      length: text.length,
    });
  }
  if (!items.length) return '';

  const last = items[items.length - 1];
  if (!last.prefix && last.ascii && last.length >= 3) last.prefix = true;

  return items.map((item) => (item.prefix ? `${item.phrase}*` : item.phrase)).join(' ');
}

/**
 * 把 query 拆成用于高亮的字面词（原始形态，不含插进去的空格）。
 * @param {string} input
 * @returns {string[]}
 */
export function queryWords(input) {
  return String(input ?? '')
    .trim()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && WORD_CHAR.test(w));
}
