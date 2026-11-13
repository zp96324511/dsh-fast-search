# 变更记录

## 0.6.1 — 2026-11-13

**面板的语义进度改报「块/秒 + 复用率」。**

0.6.0 上线后看着像没提速：面板报的是「字符/秒」，而去重之后重复块完成时字符增量为 0，
字符率被稀释（实测 1,346–1,379，反而低于 0.5.x 的 1,443–1,613）。进度条的单位本来就是块，
速率跟着块走才和看到的进度一致。

- `src/vectors.js`：`progress` 新增 `chunkRate`（块/秒）、`reuseRatio`（复用引用 / 本轮新增引用）、
  `reusedChars`（复用省下的字符，仅统计）；`etaMs` 改由 `chunkRate` 倒推。
  `progress.reused` 修正为**引用条数**（此前误存字符数，与文档口径不一致）。
- `client.js`：建库中显示 `语义索引 9,000/13,219 · 42.5 块/秒 · 复用 38%`；
  空闲时显示 `语义索引 26,994 块 · 唯一 16,661 · 复用 38%`（静态去重率）。
  宿主没有 `chunkRate`（旧版）时自动省略速率段，不显示假数据。
- 测试：`vectors-smoke` 断言 `reused` 是条数、纯复用一轮的 `reuseRatio === 1`；
  `http-smoke` 断言 `/status` 暴露 `chunkRate`/`reuseRatio`；`client-smoke` 断言两种状态行的文案与取值。

## 0.6.0 — 2026-11-13

**建库提速约 3.5×：内容级向量复用 + 并发请求 + 向量表去重存储。**

三件事是叠加的：同一段文本只嵌一次（实测省掉 49% 的字符量）、请求改成 N 路并行
（2 路实测 1.9×）、存储从「每行一份向量」改成「一份内容 + 多条引用」。5.09M 字符的全量建库
从约 42 分钟降到约 12 分钟。

- `src/store.js`：向量表拆成 `vec_content(hash PK, scale, vec)` + `vec_refs(path, hash, chunk_ix,
  rid, start, len)`，新增 `vec_refs_hash` 索引；`migrateVectorSchema()` 在打开库时把 0.5.x 的
  `vec_chunks` 一次性迁过去（同 hash 只留一份）并删旧表——**不重建全文索引、不重新嵌入**。
  `SCHEMA_VERSION` 升到 2，但迁移是就地完成的，旧库不会整体重建。
- `src/vectors.js`：`VectorStore` 改为按唯一内容分配内存槽位（`hashes` / `hashSlots` /
  `refsByHash`），`search()` 每份内容只算一次点积，命中后再从引用里挑一条满足筛选的位置；
  `insertMany()` 对已有内容只写引用、不再要求传向量。
- `src/vectors.js`：扫描阶段跨文件按 hash 分组，库里已有的内容直接补引用（`progress.reused`），
  只把真正的新内容送去嵌入；`progress.charsTotal` 改为「去重后待嵌字符」，ETA 因此变准。
- `src/embed.js`：`Embedder` 新增 `concurrency`（默认 1，上限 4）。`embedTexts()` 按 `batch`
  切片后由 N 条 lane 并行请求，结果按下标回填，顺序与输入严格一致；任一路失败即整批失败。
- 配置新增 `vectors.concurrency`；`batch` 建议回到 8（实测 8→64 总吞吐不变，只是拉长单请求）。
  CLI 增加 `--concurrency`。
- `/vectors` 与 `/status` 增加 `contents`、`batch`、`concurrency`、`progress.reused`。
- 实测（2026-11-13，硬件升级后的 bge 服务，48 个真实块 / 21,529 字符）：串行 2.0k 字符/秒；
  2 路 3.9k（1.9×）；4 路 3.6–3.8k（无增益）；8 路 HTTP 502。批大小 8/16/32/64 的串行吞吐一致。
  服务端没有文本级缓存，所以内容去重的收益是真实的。
- 测试：`vectors-smoke` 增加「跨文件只嵌一次」「第三场会话零嵌入调用」「删一条引用不误删内容」
  「concurrency=2 并行且顺序正确」「concurrency=1 严格串行」「0.5.x 老库自动迁移」六组断言。

## 0.5.0 — 2026-11-11

**新增「消息类型」筛选。** 除工作区和时间窗，结果还可以按会话事件的 `type` 收窄：
用户 / 助手 / 工具调用 / 工具结果 / 会话标题；芯片可多选（取并集），不选就是全部类型。

- `src/store.js`：新增 `KIND_VALUES` 与 `normalizeKinds()`——事件全名（`tool/result`）和短名
  （`user` / `assistant` / `tool` / `result` / `title`）等价，未知值忽略而不是报错；
  `createFilter` 接受 `kinds`，`#filterClauses` 把它拼进与工作区/时间同一个 `WHERE`，
  `ridFilter` 同步约束语义召回的候选集，`filters.kinds` 回显规范化后的数组。
- `src/router.js`：`/search` 接受 `kinds`（数组或逗号/空白分隔字符串）与单值别名 `kind`；
  `filters.kinds` 回显事件全名，认不出时回 `null`。
- `client.js`：筛选行新增「类型」芯片组（全部 + 五种类型），切换立即重跑当前查询，
  选择与工作区/时间一起存 `localStorage`；筛选回显与结果徽标都覆盖 `session/title`
  （此前落进「记录」）。`system/message` 不做开关——它默认不进索引，摆一个永远 0 条的
  按钮只会让人怀疑搜索坏了。
- `cli.mjs`：`search --kind user,assistant,tool,result,title`，别名与 HTTP 同一套归一逻辑。
- 测试：`query-smoke` 增加类型/别名/组合/`ridFilter` 断言；`http-smoke` 增加数组、单值、
  未知值与「语义召回受类型约束」；`client-smoke` 增加芯片默认态、多选叠加与请求体断言。
- 索引结构不变（`kind` 列早已存在于 `docs`），升级**不需要**重建索引。

## 0.4.4 — 2026-11-10

**搜索改为显式触发。** 面板已经有「搜索」按钮，输入框的实时检索（160ms 防抖）随之移除：
打字只更新草稿，不再每敲一个字就发一轮查询。

- `client.js`：`onChange` 只写 `text` / `memory.text`；`DEBOUNCE_MS` 与防抖计时器一并删除，
  检索只由「搜索」按钮或 `Enter` 触发。
- `Enter` 按草稿是否改过分流：词改过 → 先检索新词；词没改 → 保持原来的「打开第一条命中」。
- 只输入、未检索时，空态提示「按 Enter 或点右侧「搜索」开始检索」，不再误报「没有找到匹配的会话」。
- 筛选、日期、语义开关切换仍立即重跑当前查询（一次性动作，不需要再点按钮）。
- 更新 `test/client-smoke.mjs`：输入不自动发请求、未检索空态提示、回车检索新词；
  `bench/cdp-verify.mjs`、`bench/cdp-click.mjs` 改为输入后点「搜索」。
- 不涉及索引、API 与查询语义；升级后不需要重建索引。

## 0.4.3 — 2026-11-09

**修正索引的数据根。** `sessionsDir` / `dbPath` 的默认值不再写死 `~/.dsh`，改为与 DSH 同口径：
显式配置 > `$DSH_HOME` > `~/.dsh`。

- 病灶：`DSH_HOME` 不在用户目录的机器（如 Windows 上 `D:\DeepSeekHarness\data`）会去索引
  `C:\Users\<user>\.dsh\sessions`——那往往是一份历史遗留的旧 home。表现是工作区下拉只剩几个
  旧项目、近期会话一条都搜不到，而界面本身毫无异常，很容易被误判成前端 bug
  （yhzp 实测：16 场 / 2,024 条 / 2 个工作区，真实数据是 520 个会话日志、19 个项目目录）。
- 修复：`index.js` 新增 `resolveDataPaths()`，复用 `update.js` 已有的 `resolveDshHome()`
  ——升级通道早就按 `$DSH_HOME` 找 profile，只有索引这两条路径没跟上，属于插件内部不自洽。
- 升级影响：`DSH_HOME` 与 `~/.dsh` 相同的机器（含 win10）行为逐字节不变；不同的机器第一次
  启动会在 `$DSH_HOME/storages/fast-search.db` 全量重建索引（会话日志本来就可重建），
  旧位置那份索引的是错误目录，可以直接删。
- 新增 `test/paths-smoke.mjs`：`$DSH_HOME` 生效、显式配置优先、空白 `$DSH_HOME` 回退、
  默认 `~/.dsh` 四组断言，并接进 `npm run check` / `npm test`。

## 0.4.2 — 2026-11-09

**修正运行要求。** 功能与 0.4.1 相同；0.3.0 起存储层直接使用内置 `node:sqlite`，
但 `engines` 仍写着 Node 20，CI 也还覆盖 20——实际从 Node 22.13 起才不需要
`--experimental-sqlite` 开关。

- `engines.node` 改为 `>=22.13.0`，README 安装段写明运行要求。
- CI 矩阵从 `20/22/24` 改为 `22/24/26`，避免再出现「Node 20 装不上却发布成功」。
- 不涉及查询、索引、API 或面板行为；从 0.4.1 升级不需要重建索引。

## 0.4.1 — 2026-11-09

**面板布局与升级流程调整。** 不改查询、索引和 API 语义，只调整控件位置与安全边界。

- 过滤组件与语义开关统一移到搜索框上方；语义开关从「点击循环」的按钮改成原生下拉
  （关 / 自动 / 开），宿主没启用向量服务时下拉禁用并显示「关」。
- 空态与无结果提示写详细：空格、`AND`/`&`、`OR`/`|`、括号分组、`"短语"`、词尾 `*` 前缀，
  都给了可直接照抄的示例。
- 「重建索引」按钮移到状态行，紧跟「x 条消息 · 语义索引 x/x」之后，并保留禁用与进度。
- 升级完成或检测到磁盘版本更新（`stale`）时只提示「请手动重启 dsh web」；移除面板重启按钮、
  客户端 `/update/restart` 调用、宿主重启端点与 `respawn.cjs`。宿主可能由外部脚本带自定义参数、
  端口和环境变量拉起，插件不再替用户操作宿主进程。
- 搜索框右侧增加「搜索」按钮；`Enter` 仍保持打开第一条命中的行为。
- 时间筛选增加自定义起止日期（本地时区、含首尾两天，可只填一端），快捷档 `1 天 / 1 周 / 1 月`
  仍是一键选择；自定义区间与工作区、语义召回继续共用同一组筛选。
- 重建索引按钮不再被状态文字推到最右边，版本号移到重建按钮之后；原生下拉和日期框显式声明
  `color-scheme`，宿主深色主题下不再出现白底白字弹层。
- 更新 client 冒烟（控件顺序、语义下拉、状态行顺序、搜索按钮、日期区间、版本号位置、无重启入口）
  与 update 冒烟（重启端点不再认领）。

## 0.4.0 — 2026-11-09

**查询组合与结果筛选。** 搜索框不再只能「所有词同时出现」：`且 / 或 / 括号` 可以自由组合；
结果可以按工作区（项目）和 `1 天 / 1 周 / 1 月` 收窄，全文命中、总数、分组与语义召回共用同一组条件。

- 重写 `src/tokenize.js` 的查询编译：递归下降解析器，支持 `AND`/`OR`/`且`/`或`/`&`/`|`（含全角）、
  `()`/`（）`、`"..."`/`“...”` 短语、词尾 `*` 前缀；优先级 `AND > OR`，相邻词仍是隐式 AND。
  纯词查询完全保留旧行为（空格 AND、最后一个 ASCII 词自动前缀），布尔查询要前缀必须显式写 `*`。
- 语法错误不再等于 0 条：括号不匹配、运算符缺词等会降级为「全部词 AND」，响应里带
  `syntax: "fallback"` 与 `parseError`，面板显示提示而不是让用户以为搜不到。
- `store.search()` 新增 `workspace` / `since` / `until` 筛选：工作区精确匹配 `sessions.cwd`
  （`COLLATE NOCASE`、容忍末尾斜杠），时间按消息 `docs.time` 过滤；筛选在 MATCH 查询、
  `total`、分组与截断之前生效。
- 新增 `GET /workspaces`：按最近一条消息倒序列出 `{ cwd, sessions, docs, updatedAt }`。
- `/search` 新增 `workspace`、`since`/`until`（毫秒或 ISO 日期）、`range`（`1d`/`1w`/`1m` 及别名，
  `1m`=30 天）；响应新增 `filters`、`terms`、`words`、`syntax`、`parseError`，分组新增 `lastTime`。
- 语义召回在打分前套用同一份筛选（`VectorStore.search(..., accept)`），topK 不会被别的项目/时间段占满。
- 面板新增第二行筛选：工作区下拉（`cwdTail · 会话数`，含「全部工作区」）+ 时间 chips；
  选择存 `localStorage`（`dsh-fast-search:filters`），切换立即重跑；筛选回显在 meta，
  时间筛选下分组时间改用 `lastTime`；语法错误单独提示。
- CLI `search` 新增 `--workspace` / `--since` / `--until` / `--range`。
- 引号转义修正：`"a ""b"" c"` 里的 `""` 现在是一个字面引号，不再被误判成短语收尾。
- 修正「重建索引」按钮的进度读取（读 `status.index.phase`，而不是不存在的 `status.phase`）：
  对账期间按钮禁用、文案变成「重建中…」，meta 行显示 `done/total`。
- 面板发现磁盘版本比运行中的宿主新（`stale` / `restartRequired`）时显示重启条，
  不再等下一次线上升级才给重启入口。
- 新增 `test/query-smoke.mjs`（17 组语法 + 10 组筛选断言）；HTTP 冒烟增加 `/workspaces`、
  工作区/时间筛选、布尔组合、语义召回筛选共 5 项；client 冒烟增加筛选行、选中态与重启条断言。
- 不新增 schema 列、不改 `SCHEMA_VERSION`：工作区与时间都落在已有的 `sessions.cwd` / `docs.time` 上，
  升级后**不需要重建索引**。

## 0.3.0 — 2026-11-09

**可选语义检索：换个词也能找到那句话。** 全文索引照旧是快路径（默认行为逐字节不变），
语义是叠在旁边的第二条召回通道，用自己的一台 bge-large 服务把会话正文嵌进本地向量库。

- 新增 `src/chunk.js`：按 bge 的 512 token 上限切块（默认 480 字符），切点优先段落 > 换行 >
  句末标点 > 空格，只有长代码块这类硬切才带 64 字重叠；块内容哈希用于「这条已经嵌过」判断。
- 新增 `src/embed.js`：OpenAI 兼容 `/v1/embeddings` 客户端，零依赖；4xx 不重试、429/5xx 退避重试，
  返回的向量强制 L2 归一化并按 int8 量化（4KB/块 → 1KB/块）。
- 新增 `src/vectors.js`：`vec_chunks` 存 int8 向量（`(path, hash)` 唯一），内存里按 4096 块一组
  装进独立 `Int8Array`，1024 维暴力点积 + 定长 top-k 小顶堆。追加写盘的文件整文件重解后，
  只有**新块**要重新嵌入，老块的 rowid 会自动改指向（`updateSpans`）。
- 新增 `src/search.js`：RRF（k=60）融合全文与语义两路排名，按会话重新分组；
  语义只补不替——全文结果原样保留，语义命中标 `source: "vec"`。
- 查询开关 `off` / `auto` / `on`：`auto` 只在全文命中少于 `autoThreshold`（默认 5）时补一轮，
  面板 meta 行上的「语义 关/自动/开」就是它，选择记在 `localStorage`。
- 后台建库：启动 8s 后跑一轮，之后 30 分钟兜底；`maxCharsPerMinute` 可限速，
  `/vectors` 看覆盖率与 ETA，`POST /vectors/sync`、`POST /vectors/pause` 手动控制。
- 服务不可达时静默降级成纯全文（`semantic.reason = "error"`），不会让搜索失败；
  模型/维度/切块版本变化时旧向量整库作废，不混用两套距离。
- 默认只嵌 `user/message`、`assistant/message`、`session/title`：工具输出占字符量的 86%、
  语义价值最低，实测这台服务约 600 字符/秒，全量 53M 字符要 23 小时，对话正文 5.6M 约 2.6 小时。
- 新增 `test/vectors-smoke.mjs`（假嵌入器端到端 15 项）、CLI 的 `vectors status|sync` 与
  `search --semantic`。

## 0.2.1 — 2026-11-07

**对账不再把「读不到」当成「已删除」。** 会话目录在 Windows 上偶发 EPERM/EMFILE
（杀毒扫描、目录正在被改写），旧的 `walk` 会静默跳过整个子目录；随后那轮对账把
它们的 5,400 条水位线当成"文件已删除"清掉，下一轮再全量重解一遍。

- `discover()` 现在把遍历失败的位置收集起来，`/status` 的 `index.partial` 会置真。
- 只要这一轮有遍历失败，就**跳过删除回收**（水位线与文档一条不动），日志里写明保留了多少条。
- 遍历完全成功时才回收，语义与之前一致。

## 0.2.0 — 2026-11-07

**在线升级。** 插件现在是一次发布、长期跟进的形态：安装来自 GitHub Release 的 tarball，
面板上出现新版本时点一下就能换到新版，不用再手工 clone / 改 patch / 重启终端。

- 新增 `update.js`：按 `package.json` 里那条依赖判断「这一份是从哪个通道装的」
  （Release tarball → GitHub；`^1.2.3` → npm registry；`link:` / `file:` / git spec → 不提供在线升级），
  然后问那个通道的最新版本。答案缓存 6 小时，`GET /update?force=1` 可强制刷新。
- 新增面板内的版本号入口：平时显示当前版本，有新版本时变成 `↑ vX.Y.Z`；
  升级走 `dsh plugin --profile <name> add <spec>`（和用户手敲同一条命令），
  作业状态、日志、超时、真装到的版本都在 `GET /update/job` 里可查。
- 新增一键重启：宿主侧 `respawn.cjs` 等旧进程退出、端口释放后把同一条命令行重新拉起；
  `update.restart` 可配 `respawn`（默认）/ `exit` / `none`。
- 新增 `scripts/check-manifest.mjs` 与 `.github/workflows/{ci,publish}.yml`：
  打 tag 即发布 tarball + 稳定文件名 + `channel.json`。
- `version` 改为从 `package.json` 读取，不再有两处版本号可以走散。

## 0.1.1 — 2026-11-06

- 加 `PRAGMA busy_timeout = 5000`：宿主启动对账与 CLI 全量建库撞车时不再立刻报 `database is locked`。
- 大重建后 `PRAGMA wal_checkpoint(TRUNCATE)`：曾观察到 `-wal` 涨到 71MB 不回收。
- 面板：切换会话再回来会重跑上次查询；空结果文案带上查询词；分组计数与总数改成千分位。

## 0.1.0 — 2026-11-06

首个可用版本。

- 自建 SQLite FTS5 索引：每文件按大小 + mtime 增量对账，不随每轮对话重建。
- 中文按字分词（建索引时逐字插空格，查询端还原成短语），英文/代码仍走 `unicode61`；
  末尾 ASCII 词自动前缀匹配（`mmap` 命中 `mmap3`、`mmap_size`）。
- 两阶段查询：先 `bm25` 排序取 top-N，再只对展示的十几条取正文并在 JS 侧高亮；
  5,400 个会话 / 4.9 万条消息上稳态 3–15ms。
- 侧栏图标 + 独立面板：按会话分组、kind 徽标、相对时间、键盘上下键、回车跳会话。
- `cli.mjs`：`build` / `search` / `status`，可脱离宿主验证索引。
