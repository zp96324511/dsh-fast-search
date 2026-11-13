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
   │ hash 是块正文的双 32 位 FNV；**跨文件按 hash 去重**（会话注入上下文、fork 历史几乎全重复）
   ▼
embed.js → 嵌入服务（OpenAI 兼容 /v1/embeddings，`concurrency` 路并行）
   │ L2 归一化 → int8 对称量化（scale = max|x| / 127）
   ▼
vec_content(hash PK, scale, vec BLOB)   ← 每段文本只有一份向量
vec_refs(path, hash, chunk_ix, rid, start, len)  ← 每个会话文件里的引用
   │ 内存里 4096 份内容一组，各占一个独立 Int8Array
   ▼
查询：嵌入问题 → int8 点积（等价于余弦，因为都已归一化）→ 定长 top-k 小顶堆
   ▼
每条命中再从引用里挑一条可展示的位置（受工作区/时间/类型筛选约束）
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

## 4. 实测数据（2026-11-13，硬件升级后复测）

### 4.1 语料与规模

| 项 | 数值 |
|---|---|
| 会话文件 | 5,480 场 / 178 个日志文件 |
| 文档总数 | 68,565 |
| 向量引用（`vec_refs`） | 22,412 块 |
| 唯一内容（`vec_content`） | 约 11,300 份（去重率 ≈49%） |
| 总字符 / 去重后字符 | 5.09M / 2.58M |

重复不是零散噪声：最大的重复块出现 **174 次**（每场会话开头注入的 `<system-reminder>` skill 清单），
HiveMem 项目简报重复 111 次，工作区 AGENTS 说明重复 129 次；assistant 侧的重复主要来自 fork 会话。
按类型：`user/message` 占重复字符 1.82M，`assistant/message` 0.68M。

### 4.2 嵌入服务吞吐（bge-large，48 个真实块 / 21,529 字符，两轮）

| 方式 | 总吞吐 | 单请求耗时 |
|---|---|---|
| 串行，batch 8 | 2,012–2,040 字符/秒 | 1.78s |
| 串行，batch 32 | 2,035–2,054 | 5.24s |
| 串行，batch 64 | 2,048–2,089 | 10.3s |
| **2 路并发，batch 8** | **3,851–3,946** | — |
| 4 路并发，batch 8 | 3,595–3,755（无增益） | 4.4–4.7s |
| 8 路并发 | HTTP 502（openresty 网关） | — |

结论：**批大小不影响总吞吐**，只影响单请求长度与进度粒度，保持 8；
**2 路并发 ≈1.9×**，4 路开始被服务端串行化，8 路被网关拒绝。所以默认 `concurrency: 1`，推荐 2。

服务端没有文本级缓存（同一批文本连发 4 次耗时 2.33/1.92/1.82/1.73s，只是连接预热），
所以内容哈希去重的收益是实打实的。

**结论**：5.09M 字符的全量建库，串行重复嵌入约 42 分钟；去重后（2.58M）串行约 21 分钟；
去重 + 2 路并发约 **11 分钟**，端到端（含扫描与写库）实测 12–13 分钟。
`POST /vectors/pause` 可随时停，下次 `sync` 只补没嵌过的内容（内容哈希去重），不会重头再来。

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

- **只嵌新内容。** 文件被追加写盘后，索引器整文件重解（FTS 的老规矩），
  向量侧按 hash 对比：老块还在就直接跳过。
- **同一段文本只存一份向量。** `vec_content(hash)` 存向量本体，`vec_refs(path, hash)` 存位置；
  同一句话在多场会话里出现，只嵌一次、扇出多条引用。实测重复字符占 49%。
- **rowid 会变，引用要跟着改指向。** `docs` 是 FTS5 虚拟表，`replaceFile` 先删后插，
  同一条消息的 rowid 每一轮都会变。`VectorStore.updateSpans()` 负责把 `vec_refs.rid/start/len`
  重指到新行——**不做这一步，语义命中会指向一条已不存在的文档**（`vectors-smoke` 里有一条专门测它）。
- **删文件即删引用**，最后一个引用消失时顺手回收内容；已删会话不会再被语义召回。
- **失效条件**：`model` / `dim` / `CHUNKER_VERSION` / `chunkChars` 任一变化 → 旧向量整库作废
  （`vec_meta` 里记着这几项），避免两套距离空间混用。
- **老库自动迁移**：0.5.x 的 `vec_chunks` 在打开数据库时一次性迁到 `vec_content` + `vec_refs`
  （同 hash 只留一份），然后删掉旧表；不需要重建全文索引，也不需要重新嵌入。
- **墓碑与压缩**：删除只把内容槽位标死，累计墓碑超过一半时重载内存表（`maybeCompact`）。

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
| `batch` | `8` | 单次请求的文本数（实测与总吞吐无关，小批只为进度平滑） |
| `concurrency` | `1` | 并发请求数；实测 2 路 ≈1.9×，4 路无增益、8 路 502，建议 2 |
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
| `chunks` | 引用数（`vec_refs`），即「被索引的块位置」有多少 |
| `contents` | 唯一内容数（`vec_content`），去重后的真实向量份数 |
| `bytes` | 内存占用（每份内容 1024 字节） |
| `batch` / `concurrency` | 当前生效的请求参数 |
| `docsCovered` / `docsTotal` | 已覆盖文档数 / 应覆盖文档数（覆盖率） |
| `progress.phase` | `idle` / `scanning` / `embedding` / `error` |
| `progress.chars` / `charsTotal` | 本轮已嵌字符 / **去重后**待嵌字符 |
| `progress.embedded` / `reused` | 本轮写入的引用数 / 其中直接复用已有向量的条数 |
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
| 宿主重启 | 建库从断点继续（内容哈希去重），不重算已嵌内容 |
| 用户暂停 | `paused = true`，后台轮次跳过，`/vectors/sync` 可手动恢复 |
| 升级自 0.5.x | 首次打开库自动迁移 `vec_chunks` → `vec_content` + `vec_refs`，不重嵌 |

## 9. 没做的事，以及为什么

- **不做重排（rerank）**：多一路模型调用会把延迟再抬 100ms+，而 RRF 已经够用；
  如果以后发现 top-1 不够准，加一个 `bge-reranker` 只需要在 `search.js` 里对 top-20 再打一次分。
- **不嵌工具输出**：占字符量 86%、语义价值最低。真要嵌，把 `kinds` 加上 `tool/result` 即可，
  代价是建库时间（去重后仍是最贵的一档）。
- **不做多向量/多字段**：标题和正文混在一个空间里，靠 `chunkChars` 自然区分；分开索引会让融合更复杂，
  收益不明显。
- **不在客户端做任何向量计算**：面板只认服务端的 `source` 与 `similarity`，浏览器不需要 WASM。
