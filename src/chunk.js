/**
 * 切块：把一条会话文档切成 bge 能吃下的片段。
 *
 * 约束来自模型侧（实测）：`bge-large` 上下文 512 token，中文 1 字 ≈ 1 token。
 * 所以默认 `maxChars = 480`——纯中文刚好不越界，中英混排只会更短，宁可少塞一点
 * 也不要让服务端静默截断（截断后的向量会把"后半段"当成不存在）。
 *
 * 切点优先级：段落（空行）> 换行 > 句末标点 > 空格 > 硬切。
 * 只有硬切（长代码块、没有标点的长串）才带 `overlap` 重叠，避免一个概念被劈成两半；
 * 正常文本不在块之间留重叠——重叠等于重复付费，而这条链路的成本是**按字符线性**的。
 */

import { isCjkCode } from './tokenize.js';

/** 切块算法版本：改切法就 +1，已有的向量索引会整体作废重建（meta 里记着它）。 */
export const CHUNKER_VERSION = 1;

/**
 * 估算 token 数：CJK 一字 ≈ 1 token，其余按 3.5 字符/token（BERT 系词表经验值）。
 * 只用于判断"会不会超"，不追求精确——精确要真分词器，插件是零依赖的。
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCjkCode(text.charCodeAt(i))) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 3.5);
}

/**
 * 稳定哈希（两个 32 位 FNV 变体拼成 16 位十六进制）。
 * 用途：判断"这一块是否已经嵌入过"，让追加写盘的文件只补新块。
 * @param {string} s
 * @returns {string}
 */
export function hashText(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** 句末标点（含全角），切点落在它后面。 */
const SENTENCE_END = '。！？；!?;';

/**
 * 在 `[start, start+maxChars)` 里找一个尽量体面的切点。
 * 找不到就硬切，并告诉调用方这是硬切（需要重叠）。
 * @param {string} text
 * @param {number} start
 * @param {number} maxChars
 * @returns {{ end: number, hard: boolean }}
 */
function nextCut(text, start, maxChars) {
  const limit = Math.min(text.length, start + maxChars);
  if (limit >= text.length) return { end: text.length, hard: false };

  /* 只在后半段找切点：太早的切点会让块长减半，白付一次嵌入 */
  const windowStart = Math.max(start + Math.floor(maxChars * 0.6), start + 1);
  const slice = text.slice(windowStart, limit);

  let idx = slice.lastIndexOf('\n\n');
  if (idx >= 0) return { end: windowStart + idx + 2, hard: false };

  idx = slice.lastIndexOf('\n');
  if (idx >= 0) return { end: windowStart + idx + 1, hard: false };

  for (let i = slice.length - 1; i >= 0; i--) {
    if (SENTENCE_END.includes(slice[i])) return { end: windowStart + i + 1, hard: false };
  }

  /* ASCII 句子：`. ` / `! ` / `? ` 后面落刀，别把 1.5 这种小数点当句号 */
  const ascii = /[.!?][\s"'\])]/g;
  let last = -1;
  for (let m = ascii.exec(slice); m !== null; m = ascii.exec(slice)) last = m.index + 1;
  if (last >= 0) return { end: windowStart + last, hard: false };

  idx = slice.lastIndexOf(' ');
  if (idx >= 0) return { end: windowStart + idx + 1, hard: false };

  return { end: limit, hard: true };
}

/**
 * 切成若干块，每块 ≤ `maxChars`。
 *
 * @param {string} raw 原文（**还原过的**，不是 FTS 里插过空格的那份）
 * @param {{ maxChars?: number, overlap?: number }} [options]
 * @returns {Array<{ start: number, end: number, text: string, hash: string }>}
 */
export function chunkText(raw, { maxChars = 480, overlap = 64 } = {}) {
  const text = typeof raw === 'string' ? raw : '';
  if (text.length === 0) return [];
  const size = Math.max(32, Math.trunc(maxChars) || 480);
  const lap = Math.max(0, Math.min(Math.trunc(overlap) || 0, Math.floor(size / 4)));

  /** @type {Array<{ start: number, end: number, text: string, hash: string }>} */
  const out = [];
  let start = 0;
  while (start < text.length) {
    const cut = nextCut(text, start, size);
    const end = Math.min(text.length, Math.max(cut.end, start + 1));
    /* 块首尾的纯空白不要进嵌入：它对语义没有贡献，却要按字符付费 */
    let from = start;
    let to = end;
    while (from < to && text[from] <= ' ') from += 1;
    while (to > from && text[to - 1] <= ' ') to -= 1;
    if (to > from) {
      const piece = text.slice(from, to);
      out.push({ start: from, end: to, text: piece, hash: hashText(piece) });
    }
    if (end >= text.length) break;
    start = cut.hard ? Math.max(start + 1, end - lap) : end;
  }
  return out;
}
