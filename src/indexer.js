/**
 * 增量索引器。
 *
 * 策略（P0 实测支撑）：
 * - 全量 5,408 文件约 24s，但**200 个最大文件就占 83.6MB**，其余 5,200 个是几百字节
 *   的空壳（0 文档）。所以增量扫描的成本几乎全在"判断要不要重解"上，用
 *   `size + mtime` 水位线（files 表）直接跳过。
 * - 会话日志只追加不改写，因此文件一变就**整文件重解**（单文件 1–3ms），不做行级 diff。
 * - 每个文件一个事务，中途失败只丢这一个文件，索引不会半残。
 * - 解索引期间每 20 个文件让出一次事件循环：宿主是单线程，不能让面板卡住。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { decodeSessionFile } from './decode.js';

const SESSION_FILE = /\.jsonl(\.zstd)?$/;

/** 让出事件循环一次，避免长任务把宿主主线程占死。 */
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

export class Indexer {
  /**
   * @param {{ store: import('./store.js').Store, root: string, cap?: number,
   *           log?: (msg: string) => void, watch?: boolean,
   *           onIndexed?: (file: string) => void, onRemoved?: (file: string) => void }} options
   */
  constructor({
    store,
    root,
    cap = 8192,
    log = () => {},
    watch: enableWatch = true,
    onIndexed = () => {},
    onRemoved = () => {},
  }) {
    this.store = store;
    this.root = root;
    this.cap = cap;
    this.log = log;
    this.enableWatch = enableWatch;
    this.onIndexed = onIndexed;
    this.onRemoved = onRemoved;
    this.timer = null;
    this.watcher = null;
    this.queued = new Set();
    this.running = null;
    this.pending = false;
    this.state = {
      phase: 'idle',
      done: 0,
      total: 0,
      indexed: 0,
      skipped: 0,
      removed: 0,
      docs: 0,
      startedAt: 0,
      finishedAt: 0,
      lastError: null,
    };
  }

  /**
   * @param {string[]} [problems] 遍历失败的位置（Windows 上 EPERM/EMFILE 偶发）
   * @returns {Promise<string[]>} 目录下所有会话日志的绝对路径
   */
  async discover(problems = []) {
    /** @type {string[]} */
    const out = [];
    /** @param {string} dir */
    const walk = async (dir) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        problems.push(`${dir}: ${err?.code ?? err?.message ?? err}`);
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && SESSION_FILE.test(entry.name)) out.push(full);
      }
    };
    await walk(this.root);
    return out;
  }

  /**
   * 索引单个文件（大小/时间未变且非强制时直接跳过）。
   * @param {string} file
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<'indexed' | 'skipped' | 'missing'>}
   */
  async indexFile(file, { force = false } = {}) {
    let info;
    try {
      info = await stat(file);
    } catch {
      this.store.removeFile(file);
      this.onRemoved(file);
      return 'missing';
    }
    const size = info.size;
    const mtimeMs = Math.trunc(info.mtimeMs);
    if (!force) {
      const known = this.store.fileState().get(file);
      if (known && known.size === size && known.mtimeMs === mtimeMs) return 'skipped';
    }

    let buf;
    try {
      buf = await readFile(file);
    } catch {
      return 'missing';
    }
    const decoded = decodeSessionFile(buf, { cap: this.cap });
    this.store.replaceFile(file, {
      size,
      mtimeMs,
      header: decoded.header,
      title: decoded.title,
      docs: decoded.docs,
    });
    this.onIndexed(file);
    return 'indexed';
  }

  /**
   * 全量对账：遍历 → 重解变动文件 → 清理已消失文件。
   * @param {{ force?: boolean }} [options]
   */
  async syncAll({ force = false } = {}) {
    if (this.running) {
      this.pending = true;
      return this.running;
    }
    this.running = this.#run({ force }).finally(() => {
      this.running = null;
      if (this.pending) {
        this.pending = false;
        void this.syncAll({ force: false });
      }
    });
    return this.running;
  }

  /** @param {{ force: boolean }} options */
  async #run({ force }) {
    const started = Date.now();
    Object.assign(this.state, {
      phase: 'scanning',
      done: 0,
      total: 0,
      indexed: 0,
      skipped: 0,
      removed: 0,
      docs: 0,
      startedAt: started,
      lastError: null,
      partial: false,
    });

    const problems = [];
    let files;
    try {
      files = await this.discover(problems);
    } catch (err) {
      this.state.phase = 'error';
      this.state.lastError = String(err?.message ?? err);
      throw err;
    }

    if (problems.length > 0) {
      this.state.partial = true;
      this.state.lastError = `遍历有 ${problems.length} 处失败：${problems[0]}`;
    }

    this.state.total = files.length;
    this.state.phase = 'indexing';
    const seen = new Set(files);
    const state = this.store.fileState();

    let counter = 0;
    for (const file of files) {
      this.state.done += 1;
      try {
        let info;
        try {
          info = await stat(file);
        } catch {
          continue;
        }
        const size = info.size;
        const mtimeMs = Math.trunc(info.mtimeMs);
        const known = state.get(file);
        if (!force && known && known.size === size && known.mtimeMs === mtimeMs) {
          this.state.skipped += 1;
          continue;
        }
        const buf = await readFile(file);
        const decoded = decodeSessionFile(buf, { cap: this.cap });
        const written = this.store.replaceFile(file, {
          size,
          mtimeMs,
          header: decoded.header,
          title: decoded.title,
          docs: decoded.docs,
        });
        this.state.indexed += 1;
        this.state.docs += written;
        this.onIndexed(file);
      } catch (err) {
        this.state.lastError = `${path.basename(file)}: ${String(err?.message ?? err)}`;
      }

      counter += 1;
      if (counter % 20 === 0) await yieldLoop();
    }

    /* 文件被删掉的情况：水位线里有、这次没扫到。
     * 只在**遍历完全成功**时回收：walk 里一次 EPERM/EMFILE 就会让某个目录提前返回，
     * 把那里的文件当成"已删除"，下一轮再全量重解一遍——索引没坏，但白白吃掉几十秒。 */
    if (problems.length === 0) {
      for (const knownPath of state.keys()) {
        if (seen.has(knownPath)) continue;
        try {
          this.store.removeFile(knownPath);
          this.onRemoved(knownPath);
          this.state.removed += 1;
        } catch {
          /* 忽略单个文件的清理失败 */
        }
      }
    } else if (state.size > 0) {
      this.log(
        `[fast-search] 目录遍历有 ${problems.length} 处失败，本轮跳过删除回收（保留 ${state.size} 条水位线）`,
      );
    }

    /* 大写入会把 WAL 撑到几十 MB，收尾时截断，别让磁盘上留一份主库副本 */
    if (this.state.indexed > 0 || this.state.removed > 0) this.store.checkpoint();

    this.state.phase = 'idle';
    this.state.finishedAt = Date.now();
    this.log(
      `[fast-search] 索引对账完成：新增/更新 ${this.state.indexed}，跳过 ${this.state.skipped}，` +
        `清理 ${this.state.removed}，文档 ${this.state.docs}，耗时 ${this.state.finishedAt - started}ms`,
    );
    return {
      indexed: this.state.indexed,
      skipped: this.state.skipped,
      removed: this.state.removed,
      docs: this.state.docs,
      ms: this.state.finishedAt - started,
    };
  }

  /**
   * 起 watcher：会话日志被追加时只重解那一个文件。
   * 全量对账兜底：`fs.watch` 在 Windows 上偶发丢事件，所以另有定时对账。
   */
  startWatch({ intervalMs = 15 * 60 * 1000 } = {}) {
    if (!this.enableWatch || this.watcher) return;
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const name = String(filename);
        if (!SESSION_FILE.test(name)) return;
        this.queued.add(path.join(this.root, name));
        this.#schedule();
      });
      this.watcher.on('error', (err) => this.log(`[fast-search] watcher 错误：${err?.message ?? err}`));
    } catch (err) {
      this.log(`[fast-search] watcher 启动失败：${err?.message ?? err}`);
    }
    if (intervalMs > 0) {
      this.timer = setInterval(() => void this.syncAll({ force: false }), intervalMs);
      this.timer.unref?.();
    }
  }

  /** 防抖：一轮写盘会连发多个事件，250ms 后一次性处理。 */
  #schedule() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.#flush();
    }, 250);
  }

  async #flush() {
    if (this.running) {
      this.pending = true;
      return;
    }
    const files = [...this.queued];
    this.queued.clear();
    for (const file of files) {
      try {
        const result = await this.indexFile(file, { force: false });
        if (result === 'indexed') this.log(`[fast-search] 增量索引 ${path.basename(path.dirname(file))}`);
      } catch (err) {
        this.state.lastError = `${path.basename(file)}: ${String(err?.message ?? err)}`;
      }
    }
  }

  stop() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.watcher?.close();
    } catch {
      /* 已关闭 */
    }
    this.watcher = null;
  }
}
