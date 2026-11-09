# 语义检索（可选通道）的设计与运维

> 版本 0.3.0 引入。默认关闭；配了 `vectors.url` 才启用。全文索引的快路径不受任何影响。

## 1. 为什么是「叠加」而不是「替换」

会话日志里最有价值的东西恰好是精确标识符：路径、命令、报错原文、代码片段。
词法检索（FTS5 + bm25）对这类查询几乎无损——P0 基准里对字面扫描 477/477、1037/1037 逐条一致，
稳态 P50 4.6ms（[p0-baseline.md](p0-baseline.md)）。语义召回补的是另一种提问方式：
**你知道自己在找什么，但不记得原话**（「让搜索更快一点的办法」而不是「mmap_size」）。

所以两者的分工是硬性的：

| | 全文（FTS） | 语义（向量） |
|---|---|---|
| 触发 | 每次查询 | 仅 `on`，或 `auto` 且全文命中 < `autoThreshold` |
| 延迟 | 5–15ms | +60–210ms（一次嵌入 HTTP 往返） |
| 失败影响 | — | 静默退回纯全文 |
| 结果 | 原样保留 | RRF 融合、只做补充，纯语义命中标 `source:"vec"` |

## 2. 数据流

```
sessions/*.jsonl.zstd
   │ decode.js（FTS 索引时已解码）
   ▼
docs 表（FTS5，正文已逐字插空格）
   │ 只取 kinds = user/message, assistant/message, session/title
   ▼  cjkUnspace() 还原原文（插进去的空格是检索用的，不是内容）
chunk.js 切块（480 字符 / 64 重叠，切点优先段落 > 换行 > 句末标点）
   │ (path, hash) 去重：hash 是块正文的双 32 位 FNV
   ▼
embed.js → 嵌入服务（OpenAI 兼容 /v1/embeddings）
   │ L2 归一化 → int8 对称量化（scale = max|x| / 127）
   ▼
vec_chunks(slot PK, path, chunk_ix, rid, start, len, hash, scale, vec BLOB)
   │ 内存里 4096 块一组，各占一个独立 Int8Array
   ▼
查询：嵌入问题 → int8 点积（等价于余弦，因为都已归一化）→ 定长 top-k 小顶堆
   ▼
search.js RRF(k=60) 融合 → 按会话分组 → 面板
```

工作区/时间筛选（0.4.0）：`store.ridFilter()` 先算出允许的 rowid 集合，`store.search()`
把它同时塞进 FTS 的 `MATCH` 查询与 `total`；语义召回则把同一个集合变成 `accept(rid)`
谓词，在点积打分**之前**过滤。所以 top-k 不会被别的项目或更早时间段的块占满，
两条召回路径看到的是同一个筛选视图。

## 3. 关键取舍与理由

### 3.1 为什么是 int8 量化

1024 维 float32 = 4KB/块；17,078 块 = 68MB，每次查询要扫 70MB，明显拖慢。
对称 int8 是 1KB/块（17MB），点积在 JS 里就是 `Int8Array` 乘加，实测精度损失对 top-60 排名无影响
（`vectors-smoke` 的跨词召回用例就是量化后的向量在跑）。

### 3.2 为什么不引入 HNSW / sqlite-vec / usearch

- `node:sqlite` 是内置模块，加载不了 `sqlite-vec` 扩展；
- `usearch` / `hnswlib-node` 是原生模块，破坏「零外部依赖」这条底线（装一次要编译，Windows 上尤其脆）；
- 17k 条 × 1024 维的暴力点积实测 p50 **17.8ms**（p90 26.2ms，含 top-k 堆维护），
  放在 60–200ms 的嵌入往返前面完全不显眼。
  真正要优化的是嵌入调用，不是距离计算。

到十万块（≈ 100MB int8）时暴力扫描会到 60–100ms，那时再谈索引结构不迟。

### 3.3 为什么按字符切而不是按 token

bge 的上限是 512 token，中文大约 1 字 1 token。按字符切 480 是保守估计（英文会比它早切），
好处是不需要引入 tokenizer（那是几 MB 的词表和一次 WASM 初始化）。
代价是英文块偏短、中文块刚好——对这个语料（中文会话）是正确的取舍。

### 3.4 为什么用 RRF 而不是分数加权

bm25 是负值、量纲随查询长度漂移；余弦在 [-1,1]。两者融合要么学一个缩放常数（换查询就失效），
要么只看名次。RRF 只看名次：`score = Σ 1/(60 + rank)`，对「某一路没命中」天然稳健，
也是 Elasticsearch / Vespa 的默认混合检索方案。

## 4. 实测数据（2026-11-09，本机）

### 4.1 语料与规模

| 项 | 数值 |
|---|---|
| 会话文件 | 144 |
| 文档总数 | 55,932 |
| 默认嵌入的文档（user + assistant + title） | 11,892 条 / 382 万字符 |
| 切块结果 | 17,078 块（平均 224 字符/块） |
| 全量（含工具输出） | 5,300 万字符 / 约 23 小时 |

### 4.2 嵌入服务吞吐（bge-large，单实例）

| 批 | 内容 | 耗时 | 吞吐 |
|---|---|---|---|
| 1 | 100 字符 | 154ms | — |
| 1 | 400 字符 | 612ms | — |
| 64 | 100 字符 × 64 | 10.1s | 632 字符/秒 |
| 32 | 400 字符 × 32 | 14.2s | 444 字符/秒 |
| 8 | 生产切片（均值 297 字符） | 37.6s / 21,370 字符 | **568 字符/秒** |

并发不提速：conc 1/2/4/8 的总吞吐都在 540–560 字符/秒（服务端串行）。
所以默认 `batch: 8`、单飞，小批只为进度平滑，不是性能手段。

**结论**：对话正文一次完整建库 ≈ **1.9 小时**；`POST /vectors/pause` 可随时停，
下次 `sync` 只补没嵌过的块（hash 去重），不会重头再来。

### 4.3 相似度分布（决定 `minScore`）

| 查询 | top | p50 | 说明 |
|---|---|---|---|
| 让搜索更快一点的办法 | 0.571 | 0.396 | 相关，全文 0 条命中，纯语义救回 |
| 向量检索 | 0.670 | 0.331 | 相关（字面也命中） |
| 怎么配置 chrome 调试端口 | 0.707 | 0.424 | 相关 |
| 今天天气怎么样 | 0.257 | 0.178 | **无关**，语料里根本没有相关内容 |

相关与无关之间有很宽的空档（0.26 → 0.57），所以 `minScore` 默认 **0.45**：
最佳分低于它整体不召回（返回 `reason: "no-match"`），单条再按 `0.75 × minScore`（≈0.34）砍尾巴。
这比「返回 top-60 并且全部展示」诚实得多——后者会把 60 条 0.2x 的噪声顶到用户脸上。

### 4.4 查询延迟构成

| 阶段 | 耗时（实测） |
|---|---|
| 查询向量嵌入（服务端热点） | 55–200ms |
| int8 点积（17,078 块 × 1024 维） | **p50 17.8ms / p90 26.2ms** |
| `docsByRid` 回表取正文 | < 5ms |
| 总数 | **80–230ms** |

点积基准：`VectorStore.search()` 直接扫内存里的块状矩阵，17k 行写入用时 994ms，
落盘 24.2MB（1KB/块 + 元数据 + 索引），25 次查询取分布。
面板上「语义补召 N 块 · Xms」就是这一段。嵌入结果按问题做 LRU 缓存（`queryCacheSize: 32`），
同一个问题重输几乎零成本。

## 5. 增量与一致性

- **只嵌新块。** 文件被追加写盘后，索引器整文件重解（FTS 的老规矩），
  向量侧按 `(path, hash)` 对比：老块的 hash 还在就直接跳过。
- **rowid 会变，向量要跟着改指向。** `docs` 是 FTS5 虚拟表，`replaceFile` 先删后插，
  同一条消息的 rowid 每一轮都会变。`VectorStore.updateSpans()` 负责把 `vec_chunks.rid/start/len`
  重指到新行——**不做这一步，语义命中会指向一条已不存在的文档**（`vectors-smoke` 里有一条专门测它）。
- **删文件即删向量**，已删会话不会再被语义召回。
- **失效条件**：`model` / `dim` / `CHUNKER_VERSION` / `chunkChars` 任一变化 → 旧向量整库作废
  （`vec_meta` 里记着这几项），避免两套距离空间混用。
- **墓碑与压缩**：删除只把槽位标死，累计墓碑超过一半时重载内存表（`maybeCompact`）。

## 6. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关；`url` 非空且它不为 false 才算启用 |
| `url` | `''` | OpenAI 兼容端点，如 `http://127.0.0.1:10450/v1/embeddings` |
| `apiKey` | `''` | 以 `Authorization: Bearer …` 发出；明文，注意 patch 文件权限 |
| `model` | `bge-large` | 会随请求发出，仅用于服务端路由 |
| `dim` | `1024` | 服务端上报维度优先；对不上会按新维度整库重建 |
| `kinds` | `user/message, assistant/message, session/title` | 嵌哪些事件类型 |
| `chunkChars` / `chunkOverlap` | `480` / `64` | 切块窗口；只在硬切时使用重叠 |
| `batch` | `8` | 单次请求的文本数（实测与吞吐无关） |
| `autoThreshold` | `5` | `auto` 模式下全文命中少于此数才补语义 |
| `topK` | `60` | 语义候选数（也是 RRF 的输入深度） |
| `minScore` | `0.45` | 最佳分门槛；0 = 关闭门控 |
| `maxCharsPerMinute` | `0` | 限速；0 = 不限 |
| `sweepMs` | `1800000` | 兜底对账间隔（30 分钟） |
| `timeoutMs` | `120000` | 单次请求超时 |
| `bootDelayMs` | `8000` | 启动后延迟多久开始建库（先让全文对账跑完） |
| `queryCacheSize` | `32` | 问答向量 LRU 条数 |
| `search.mode` | `auto` | 面板默认模式，用户在面板里的选择会覆盖它并持久化 |

## 7. 运维

```powershell
$api = 'http://127.0.0.1:10550/plugin-api/dsh-fast-search'
Invoke-RestMethod "$api/vectors"                                  # 覆盖率、进度、ETA、lastError
Invoke-RestMethod "$api/vectors/sync" -Method Post -Body '{"maxChars":50000}' -ContentType 'application/json'
Invoke-RestMethod "$api/vectors/pause" -Method Post -Body '{"paused":true}' -ContentType 'application/json'
Invoke-RestMethod "$api/search" -Method Post -ContentType 'application/json' `
  -Body '{"q":"让搜索更快一点的办法","semantic":"on"}'
```

`/vectors` 里几个字段的含义：

| 字段 | 含义 |
|---|---|
| `chunks` / `bytes` | 已建向量的块数与内存占用（每块 1024 字节） |
| `docsCovered` / `docsTotal` | 已覆盖文档数 / 应覆盖文档数（覆盖率） |
| `progress.phase` | `idle` / `scanning` / `embedding` / `error` |
| `progress.chars` / `charsTotal` | 本轮已嵌字符 / 待处理字符 |
| `progress.rate` | 字符/秒（实测值，不受配置影响） |
| `progress.etaMs` | 按当前速率估算的剩余时间 |
| `lastError` | 最近一次失败原因（服务不可达、4xx 原文） |

## 8. 失败模式

| 现象 | 行为 |
|---|---|
| 服务不可达 / 超时 | 查询：静默降级，`semantic.reason = "error"`；建库：`phase = "error"`，下一轮重试 |
| 返回 400（批太大） | 该批失败但整轮不中断，`lastError` 记录服务端原文；调小 `batch` |
| 服务端静默截断超长输入 | 我们不依赖它的截断：块本身就在 480 字符以内 |
| 服务返回维度不符 | `probe()` 以服务端为准，维度变了整库作废重建 |
| 宿主重启 | 建库从断点继续（hash 去重），不重算已嵌块 |
| 用户暂停 | `paused = true`，后台轮次跳过，`/vectors/sync` 可手动恢复 |

## 9. 没做的事，以及为什么

- **不做重排（rerank）**：多一路模型调用会把延迟再抬 100ms+，而 RRF 已经够用；
  如果以后发现 top-1 不够准，加一个 `bge-reranker` 只需要在 `search.js` 里对 top-20 再打一次分。
- **不嵌工具输出**：占字符量 86%、语义价值最低，全量要 23 小时。真要嵌，
  把 `kinds` 加上 `tool/result` 即可，代价是建库时间。
- **不做多向量/多字段**：标题和正文混在一个空间里，靠 `chunkChars` 自然区分；分开索引会让融合更复杂，
  收益不明显。
- **不在客户端做任何向量计算**：面板只认服务端的 `source` 与 `similarity`，浏览器不需要 WASM。
