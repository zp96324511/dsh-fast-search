/**
 * 嵌入客户端：一个 OpenAI 兼容的 `/v1/embeddings` 客户端，零依赖。
 *
 * 目标服务实测（2026-11-13，bge-large / 1024 维，硬件升级后）：
 * - 串行约 2,000 字符/秒；2 路并发约 3,900（≈1.9×）；4 路不再涨（3,600–3,750），
 *   8 路直接被网关 502。所以默认 `concurrency: 1`、`batch: 8`，服务扛得住时建议 2。
 * - 批大小 8→64 的总吞吐不变，只是把单请求拉长、进度变粗、超时窗口变大。
 * - 超过 512 token 的输入**不报错、静默截断**，所以切块必须自己守住上限（见 chunk.js）。
 * - 返回的向量已 L2 归一化，这里仍会再归一化一次（不依赖服务端行为）。
 *
 * 出错分类很重要：429/5xx/网络错误重试；4xx（除 408/425/429）立即失败并带上服务端消息，
 * 免得对着一个写错的 URL 重试三轮。
 */

/** @typedef {Error & { status?: number, retryable?: boolean }} EmbedError */

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

/**
 * 从各种常见响应体里抠出向量数组。
 * 支持：`{data:[{embedding:[…]}]}`（OpenAI）、`{embeddings:[[…]]}`、裸 `[[…]]`（TEI）。
 * @param {any} json
 * @param {number} expected 期望条数
 * @param {number} dim 期望维度（0 表示不校验）
 * @returns {number[][]}
 */
export function parseEmbeddings(json, expected, dim = 0) {
  /** @type {any[] | null} */
  let rows = null;
  if (Array.isArray(json)) rows = json;
  else if (Array.isArray(json?.data)) rows = json.data;
  else if (Array.isArray(json?.embeddings)) rows = json.embeddings;
  if (rows === null) throw new Error(`无法识别的响应结构：${JSON.stringify(json).slice(0, 200)}`);
  if (rows.length !== expected) {
    throw new Error(`响应条数不符：期望 ${expected}，收到 ${rows.length}`);
  }
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const vec = Array.isArray(row) ? row : row?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error(`第 ${i} 条没有 embedding 字段：${JSON.stringify(row)?.slice(0, 120)}`);
    }
    if (dim > 0 && vec.length !== dim) {
      throw new Error(`维度不符：配置 ${dim}，服务端返回 ${vec.length}`);
    }
    out.push(vec);
  }
  return out;
}

/** L2 归一化（原地改 Float32Array）。零向量原样返回，避免除零得到 NaN。 */
export function normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  if (sum <= 0 || !Number.isFinite(sum)) return vec;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < vec.length; i++) vec[i] *= inv;
  return vec;
}

/**
 * 对称量化成 int8：`value ≈ q * scale`。
 * 1024 维 float32 是 4KB/块，int8 是 1KB/块——本机实测服务只值这个精度，
 * 量化带来的余弦误差在 1e-3 量级，对排序没有可见影响。
 * @param {Float32Array} vec
 * @returns {{ data: Int8Array, scale: number }}
 */
export function quantize(vec) {
  let max = 0;
  for (let i = 0; i < vec.length; i++) {
    const abs = Math.abs(vec[i]);
    if (abs > max) max = abs;
  }
  const scale = max > 0 ? max / 127 : 1;
  const inv = 1 / scale;
  const data = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const q = Math.round(vec[i] * inv);
    data[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return { data, scale };
}

/** 归一化 float 向量与 int8 查询向量的点积（查询侧同样量化，加速 3 倍左右）。 */
export function dotQuantized(block, offset, data, scale, query, queryScale) {
  let dot = 0;
  for (let i = 0; i < data.length; i++) dot += block[offset + i] * query[i];
  return dot * scale * queryScale;
}

export class Embedder {
  /**
   * @param {{ url: string, model?: string, apiKey?: string, dim?: number, batch?: number,
   *           concurrency?: number, timeoutMs?: number, retries?: number, userAgent?: string,
   *           fetchImpl?: typeof fetch, log?: (msg: string) => void }} options
   */
  constructor({
    url,
    model = 'bge-large',
    apiKey = '',
    dim = 1024,
    batch = 8,
    concurrency = 1,
    timeoutMs = 120_000,
    retries = 3,
    userAgent = 'dsh-fast-search',
    fetchImpl = globalThis.fetch,
    log = () => {},
  }) {
    if (!url) throw new Error('未配置嵌入服务地址（vectors.url）');
    if (typeof fetchImpl !== 'function') throw new Error('当前 Node 没有 fetch');
    this.url = url;
    this.model = model;
    this.apiKey = apiKey;
    this.dim = dim > 0 ? dim : 0;
    this.batch = Math.max(1, Math.trunc(batch) || 8);
    /* 实测 2 路是这台服务的甜点；4 路无增益、8 路 502，所以客户端最多放 4 路，
     * 默认仍是 1（不改变老配置的行为）。 */
    this.concurrency = Math.max(1, Math.min(4, Math.trunc(concurrency) || 1));
    this.timeoutMs = Math.max(1000, Math.trunc(timeoutMs) || 120_000);
    this.retries = Math.max(1, Math.trunc(retries) || 3);
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.stats = { calls: 0, batches: 0, texts: 0, chars: 0, errors: 0, ms: 0 };
  }

  /** @param {number} status */
  #error(message, status) {
    const error = /** @type {EmbedError} */ (new Error(message));
    error.status = status;
    error.retryable = status === undefined || RETRYABLE_STATUS.has(status);
    return error;
  }

  /**
   * 发一批（≤ batch 条），成功返回原始向量数组。
   * @param {string[]} texts
   */
  async #request(texts) {
    const body = JSON.stringify({ model: this.model, input: texts });
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': this.userAgent,
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let lastError = this.#error('未发起请求', undefined);
    for (let attempt = 0; attempt < this.retries; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempt - 1)));
      const started = Date.now();
      try {
        const response = await this.fetchImpl(this.url, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await response.text();
        this.stats.calls += 1;
        this.stats.ms += Date.now() - started;
        if (!response.ok) {
          const detail = (() => {
            try {
              const parsed = JSON.parse(text);
              return parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? text;
            } catch {
              return text;
            }
          })();
          const error = this.#error(
            `嵌入服务 ${response.status}：${String(detail).slice(0, 300)}`,
            response.status,
          );
          lastError = error;
          this.stats.errors += 1;
          if (!error.retryable) throw error;
          continue;
        }
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw this.#error(`响应不是 JSON：${text.slice(0, 200)}`, response.status);
        }
        return parseEmbeddings(json, texts.length, this.dim);
      } catch (err) {
        /* 4xx 已经抛出去了，这里只兜网络/超时/JSON 之外的异常 */
        if (err?.status !== undefined && err.retryable === false) throw err;
        lastError =
          err?.name === 'TimeoutError' || err?.name === 'AbortError'
            ? this.#error(`嵌入请求超时（${this.timeoutMs}ms）`, undefined)
            : this.#error(`嵌入请求失败：${String(err?.message ?? err)}`, undefined);
        this.stats.errors += 1;
        this.log(`[fast-search] ${lastError.message}（第 ${attempt + 1}/${this.retries} 次）`);
      }
    }
    throw lastError;
  }

  /**
   * 批量嵌入，返回**已归一化**的 Float32Array。
   * 请求按 `batch` 切片；`concurrency > 1` 时多片并行，但结果顺序与输入严格一致。
   * @param {string[]} texts
   * @returns {Promise<Float32Array[]>}
   */
  async embedTexts(texts) {
    if (texts.length === 0) return [];
    /** @type {Array<{ at: number, slice: string[] }>} */
    const slices = [];
    for (let at = 0; at < texts.length; at += this.batch) {
      slices.push({ at, slice: texts.slice(at, at + this.batch) });
    }
    const out = new Array(texts.length);
    let cursor = 0;
    /** @type {Error | null} */
    let failure = null;

    const lane = async () => {
      while (failure === null && cursor < slices.length) {
        const job = slices[cursor++];
        try {
          const rows = await this.#request(job.slice);
          for (let i = 0; i < rows.length; i++) {
            const vec = new Float32Array(rows[i].length);
            for (let d = 0; d < rows[i].length; d++) vec[d] = rows[i][d];
            out[job.at + i] = normalize(vec);
          }
          this.stats.batches += 1;
          this.stats.texts += job.slice.length;
          for (const text of job.slice) this.stats.chars += text.length;
        } catch (err) {
          failure = /** @type {Error} */ (err);
          throw err;
        }
      }
    };

    const lanes = Math.min(this.concurrency, slices.length);
    await Promise.all(Array.from({ length: lanes }, lane));
    return out;
  }

  /** @param {string} text @returns {Promise<Float32Array>} */
  async embedOne(text) {
    const [vec] = await this.embedTexts([text]);
    return vec;
  }

  /**
   * 探活：发一条极短文本，确认地址/鉴权/维度都对。
   * @returns {Promise<{ ok: boolean, dim?: number, ms: number, error?: string }>}
   */
  async probe() {
    const started = Date.now();
    try {
      const [vec] = await this.embedTexts(['ping']);
      this.dim = vec.length;
      return { ok: true, dim: vec.length, ms: Date.now() - started };
    } catch (err) {
      return { ok: false, ms: Date.now() - started, error: String(err?.message ?? err) };
    }
  }
}
