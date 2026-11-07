/**
 * 摘要窗口与高亮，纯 JS 实现，**替代 FTS5 的 `snippet()`**。
 *
 * 为什么不用 `snippet()`：P0 基准实测（docs/p0-baseline.md §5.1）它要对每一条命中
 * 重新分词、重新读原文，300 条 × 8KB 文本让查询从 7.9ms 涨到 36.9ms（"会话" 10.8 → 70.9）。
 * 而列表最终只展示 ~20 条，所以改成两阶段：SQL 只取排序后的 rowid，摘要只对展示的
 * 那几条在 JS 里做。
 *
 * 返回的是**片段数组**而不是 HTML 字符串——交由 React 渲染成节点，杜绝注入。
 */

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const escapeRe = (s) => s.replace(ESCAPE, '\\$&');

/**
 * 在原文里找最早出现的检索词，取它周围的窗口，并把窗口内所有命中标出来。
 *
 * @param {string} raw 原文（已 `cjkUnspace` 还原）
 * @param {string[]} words 检索词（用户原始形态）
 * @param {{ width?: number, marks?: number }} [options]
 * @returns {{ segments: Array<{ text: string, mark: boolean }>, matched: boolean }}
 */
export function buildSnippet(raw, words, { width = 200, marks = 8 } = {}) {
  const text = raw ?? '';
  if (!text) return { segments: [], matched: false };

  const usable = words.filter((w) => typeof w === 'string' && w.length > 0);
  const lower = text.toLowerCase();

  /* 找出所有词的首次出现，取最早的那个作为窗口中心 */
  let best = -1;
  for (const word of usable) {
    const at = lower.indexOf(word.toLowerCase());
    if (at >= 0 && (best < 0 || at < best)) best = at;
  }

  if (best < 0) {
    const head = text.slice(0, width);
    return { segments: collapse(head), matched: false };
  }

  const start = Math.max(0, best - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  const body = text.slice(start, end);

  /* 长词优先，避免短词把长词的命中切碎 */
  const ordered = [...usable].sort((a, b) => b.length - a.length);
  const re = new RegExp(ordered.map(escapeRe).join('|'), 'gi');

  const segments = [];
  let cursor = 0;
  let hits = 0;
  for (const m of body.matchAll(re)) {
    if (hits >= marks) break;
    const at = m.index ?? 0;
    if (at > cursor) segments.push(...collapse(body.slice(cursor, at)));
    segments.push(...collapse(m[0], true));
    cursor = at + m[0].length;
    hits += 1;
  }
  if (cursor < body.length) segments.push(...collapse(body.slice(cursor)));

  /* 窗口被截断时补省略号，让用户知道上下文还在 */
  if (start > 0) segments.unshift({ text: '…', mark: false });
  if (end < text.length) segments.push({ text: '…', mark: false });

  return { segments: merge(segments), matched: true };
}

/**
 * 空白折叠：换行/连续空格压成一个空格（工具输出里满屏换行，不折叠会把窗口撑爆）。
 * @param {string} s
 * @param {boolean} [mark]
 * @returns {Array<{ text: string, mark: boolean }>}
 */
function collapse(s, mark = false) {
  const flat = s.replace(/\s+/g, ' ');
  return flat ? [{ text: flat, mark }] : [];
}

/** 合并相邻同类型片段，减少 React 节点数。 */
function merge(segments) {
  const out = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && last.mark === seg.mark) last.text += seg.text;
    else out.push({ ...seg });
  }
  return out;
}
