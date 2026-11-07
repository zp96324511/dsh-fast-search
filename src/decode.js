/**
 * 会话日志解码：`session.v4.jsonl.zstd`（或未压缩的 `.jsonl`）→ 可索引的文档。
 *
 * 文件格式（0.2.1-rc.2 实测）：
 *   首行  `{"type":"session","version":4,"id":"session-<uuid>","createdAt":<ms>,"cwd":"...",...}`
 *   之后  `{"type":"<event>","seq":n,"time":<ms>,"data":{...}}`
 *
 * 只索引承载**用户可见文本**的六类事件；`reasoning`（思考过程）实测占 27.5MB，
 * 整段排除。行的类型用 `"type":"` 切片预筛，只有六类才 `JSON.parse`——全量遍历下
 * 这一步省掉的解析量约占总行数的 57%。
 */

import { zstdDecompressSync } from 'node:zlib';

/** 承载文本的事件类型。 */
export const TEXT_KINDS = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'session/title',
  'system/message',
]);
/** zstd 帧魔数：字节序为 `28 B5 2F FD`，按小端读成 uint32 就是 0xFD2FB528。 */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * 从 content 数组里取纯文本。兼容 `{type:'text',text}`、裸字符串；
 * `reasoning` 与 `tool-call` 片段被跳过（前者是思考过程，后者是结构化调用）。
 * @param {unknown} content
 * @returns {string}
 */
function joinParts(content) {
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const part of content) {
    if (typeof part === 'string') {
      out.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const type = /** @type {{type?: string}} */ (part).type;
    if (type === 'reasoning' || type === 'tool-call' || type === 'tool_call') continue;
    if (typeof (/** @type {{text?: unknown}} */ (part).text) === 'string') {
      out.push(/** @type {{text: string}} */ (part).text);
    }
  }
  return out.join('\n');
}

/** @param {string} line @returns {Record<string, any> | null} */
function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * 解压（若需要）并解析一个会话文件。
 *
 * @param {Buffer} buf 文件的原始字节
 * @param {{ cap?: number, includeSystem?: boolean }} [options]
 *   `cap` 为单条文档的字符上限（默认 8192）；
 *   `includeSystem` 默认 false——系统提示词每个会话都一样（"You are an AI agent…"），
 *   进索引会让"工具""插件""agent"这类词的命中被几百份样板文本淹没。
 * @returns {{ header: { id: string | null, cwd: string | null, createdAt: number | null, parentId: string | null },
 *             title: string | null,
 *             docs: Array<{ seq: number, kind: string, role: string, time: number, text: string }>,
 *             lines: number, badLines: number }}
 */
export function decodeSessionFile(buf, { cap = 8192, includeSystem = false } = {}) {
  let body;
  if (buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC) {
    body = zstdDecompressSync(buf).toString('utf8');
  } else {
    body = buf.toString('utf8');
  }

  /** @type {Array<{ seq: number, kind: string, role: string, time: number, text: string }>} */
  const docs = [];
  let header = /** @type {any} */ (null);
  let title = /** @type {string | null} */ (null);
  let lines = 0;
  let badLines = 0;

  let start = 0;
  while (start < body.length) {
    let end = body.indexOf('\n', start);
    if (end < 0) end = body.length;
    const line = body.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    lines += 1;

    const at = line.indexOf('"type":"');
    if (at < 0) continue;
    const quoteEnd = line.indexOf('"', at + 8);
    if (quoteEnd < 0) continue;
    const kind = line.slice(at + 8, quoteEnd);

    if (kind === 'session') {
      if (!header) {
        const parsed = parseLine(line);
        if (parsed) {
          header = {
            id: parsed.id ?? null,
            cwd: parsed.cwd ?? null,
            createdAt: Number.isFinite(parsed.createdAt) ? parsed.createdAt : null,
            parentId: parsed.parentId ?? parsed.parent_id ?? null,
          };
        }
      }
      continue;
    }
    if (!TEXT_KINDS.has(kind)) continue;

    const ev = parseLine(line);
    if (!ev) {
      badLines += 1;
      continue;
    }
    const data = ev.data ?? {};
    let text = '';
    let role = '';

    switch (kind) {
      case 'user/message':
        text = joinParts(data.content);
        role = typeof data.role === 'string' ? data.role : 'user';
        break;
      case 'assistant/message':
        /* 只有 `text` 片段进索引：`reasoning` 是模型自述、`tool-call` 是结构化调用
           （它们已分别由"思考过程"统计与 tool/call 事件覆盖）。实测这样留下 6.6k 条
           可见文本，全量 59k 事件里约 10k 条 assistant 事件只有 reasoning + tool-call。 */
        text = joinParts(data.message?.content ?? data.content);
        role = 'assistant';
        break;
      case 'tool/call':
        text = `${data.name ?? ''}\n${data.arguments ?? ''}`;
        role = 'assistant';
        break;
      case 'tool/result':
        text = joinParts(data.message?.content ?? data.content);
        role = 'tool';
        break;
      case 'system/message':
        /* 系统提示词在 `data.message.content`，不在 `data.content`（实测）。
           默认不进索引，理由见 {@link decodeSessionFile} 的参数说明。 */
        if (!includeSystem) continue;
        text = joinParts(data.message?.content ?? data.content);
        role = 'system';
        break;
      case 'session/title':
        title = typeof data.title === 'string' ? data.title : title;
        if (title) {
          docs.push({ seq: Number(ev.seq) || 0, kind, role: 'title', time: Number(ev.time) || 0, text: title });
        }
        continue;
    }

    if (!text || !text.trim()) continue;
    docs.push({
      seq: Number(ev.seq) || 0,
      kind,
      role,
      time: Number(ev.time) || 0,
      text: cap > 0 && text.length > cap ? text.slice(0, cap) : text,
    });
  }

  return { header, title, docs, lines, badLines };
}
