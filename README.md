# dsh-fast-search

DSH Web 的**会话全文搜索**插件：自带 SQLite FTS5 索引，侧栏一个入口，输入即搜，点结果直接跳进那个会话。

替代官方 `@deepseek-ai/dsh-experimental-session-search`——后者是内存版 MiniSearch，每次启动把 5,400 个会话日志**全量解压重建**，本机实测约 **9.7s**，且只活在进程内存里。本插件把这件事下沉成磁盘索引：首轮建库 36s，之后增量，单次查询 **2–25ms**。

![面板：搜「插件」，869 条命中 / 20 个会话 / 20.1ms](docs/panel.png)

## 实测数据（本机 5,409 个会话 / 49,355 条消息，2026-11-07）

索引会随会话增长，下面的命中数是当时的快照；延迟是稳定的。

| 项目 | 数值 |
|---|---|
| 全量建库（5,408 个 `.jsonl.zstd`） | **35.8s**，解压 2.9s / 解析 3.9s / 写 FTS 12.8s |
| 索引体积 | **94.9MB**（比原始日志 85.1MB 略大，含 FTS 倒排） |
| 查询 P50（`插件` / 885 条命中） | **13.9ms** |
| 查询 P50（`调音台` / 70 条命中） | **19.2ms** |
| 查询 P50（稀有词 / 1 条命中） | **1–3ms** |
| 增量对账（无变化） | 5,408 个文件 stat 后跳过，< 1s |

## 安装

### 从 GitHub Release 安装（推荐，支持在线升级）

```powershell
dsh plugin --profile web add `
  "https://github.com/zp96324511/dsh-fast-search/releases/latest/download/dsh-fast-search.tgz"
```

`dsh-fast-search.tgz` 是一个**不带版本号的稳定名**——`releases/latest/download/<name>` 只解析 `latest` 这个 tag，不会替你改文件名，所以同一条命令永远装最新版。要锁定版本就把 URL 换成带 tag 的那份：

```powershell
dsh plugin --profile web add `
  "https://github.com/zp96324511/dsh-fast-search/releases/download/v0.2.0/dsh-fast-search-0.2.0.tgz"
```

**装完（或升级完）需要重启一次 `dsh web`**：宿主侧代码不参与 HMR，重启前跑的仍是旧版本。之后就有升级通道了——面板右下角的版本号平时只是版本号，有新版本时变成 `↑ vX.Y.Z`，点一下即可换到新版（宿主侧代码需要一次重启，面板会给出按钮）。

### 开发态安装（改代码即时生效）

源码留在工作区，用目录联接挂进 profile：

```powershell
New-Item -ItemType Junction `
  -Path  "C:\Users\win10\.dsh\profiles\web\node_modules\dsh-fast-search" `
  -Target "C:\data\projects\dsh-fast-search"

# 在 profile 的 patch 里注册（追加到文件末尾）
'- insert:
    - id: fast-search
      name: dsh-fast-search' | Add-Content "C:\Users\win10\.dsh\profiles\web\cordis.patch.yml"
```

联接安装的副本是 `link:` 依赖，**不会**提示在线升级（就地升级会覆盖你的工作区），升级接口会明确回一条 `unchanneled`。

`cordis.patch.yml` **是热加载的**，改完不用重启宿主。但插件自己的宿主代码（`index.js` / `src/*.js` / `update.js`）不会热更，改这些要重启 `dsh web`；`client.js` 会随页面刷新重新拉取。

验证：

```powershell
(Invoke-RestMethod http://127.0.0.1:10550/plugin-api/dsh-fast-search/status) | ConvertTo-Json
(Invoke-RestMethod http://127.0.0.1:10550/plugin-api/dsh-fast-search/update) | ConvertTo-Json -Depth 4
```

卸载：`dsh plugin --profile web remove dsh-fast-search`（开发态则是删掉 patch 里那两行再 `Remove-Item` 那个联接，不要删工作区本身）。

## 使用

- 侧栏 **🔍 全文搜索**（在「正在活跃」下面），点开是独立面板。
- 输入即搜（160ms 防抖），`Enter` 打开第一条，`↑ ↓` 在命中间移动，`Esc` 清空。
- 结果按会话分组：会话标题 + 工作区 + 相对时间，每条命中带类型徽标（用户 / 助手 / 工具 / 结果）和高亮片段。
- 点会话标题或任一命中 → 跳到该会话（`uiWorkspace.openSession`）。

### 查询语法

| 写法 | 含义 |
|---|---|
| `插件 缓存` | 空格分隔 = AND，两个词都要出现 |
| `插件` | 中文按**字**建索引，双字词直接命中（内部是短语 `"插 件"`） |
| `mmap` | 纯 ASCII 且长度 ≥3 时，**最后一个词自动前缀匹配**，也命中 `mmap3` / `mmap_size` |
| `mmap*` | 显式前缀（任何词都可以加 `*`） |
| `"node sqlite"` | 显式短语；`unicode61` 在 `_` 与 `-` 处切词，所以 `node_sqlite` 也能被它命中 |

## 架构

```
~/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd
        │  zstdDecompressSync + 逐行 JSON（type 预筛，只 parse 6 类事件）
        ▼
   decode.js ──► docs(text) ──► FTS5(unicode61, 建索引前逐字插空格)
        │                              │
        │                    两阶段查询：bm25 排序取 300 → 只对展示的 20 条取正文
        ▼                              ▼
   store.js ◄────────────── router.js ◄─── HTTP(JSON) ───► client.js 面板
   (水位线/增量)              /status /search /reindex
```

| 文件 | 职责 |
|---|---|
| `index.js` | Cordis 插件入口：起索引器、挂 HTTP 前缀路由（零外部依赖，连 Config schema 都不写） |
| `src/decode.js` | 日志解码：`user/message`、`assistant/message`(text)、`tool/call`、`tool/result`、`system/message`、`session/title` |
| `src/tokenize.js` | `cjkSpace`（建索引）/ `cjkUnspace`（还原）/ `toMatch`（查询→FTS5 MATCH） |
| `src/snippet.js` | 片段窗口 + 高亮，返回 `[{text, mark}]` 段数组（React 渲染，不拼 HTML） |
| `src/store.js` | FTS5 + 水位线表；`replaceFile` 单事务先删后插；两阶段 `search()` |
| `src/indexer.js` | 全量对账（size+mtime 跳过）、`fs.watch` 增删、15 分钟兜底扫描 |
| `src/router.js` | JSON 路由，请求体上限 256KB；`/update*` 交给升级路由先认领 |
| `update.js` | 升级通道：判断 came-from（Release / registry / 本地）、版本比较、跑 `dsh plugin add`、重启交接 |
| `respawn.cjs` | 重启助手：等旧进程退出 + 端口释放，再把同一条命令行拉起来 |
| `client.js` | 浏览器半边：侧栏图标 + 主面板 + 版本号入口，只用 `require('react')` |
| `scripts/check-manifest.mjs` | 发布前自检：清单里写的每个文件必须真的存在 |
| `scripts/make-channel.mjs` | 由打包产物算出 `channel.json`（版本、大小、sha256） |

### HTTP API

前缀 `/plugin-api/dsh-fast-search`（刻意避开 `/plugins/`——那是 client bundle 的领地，按最长前缀会被抢走）。

| 路由 | 说明 |
|---|---|
| `GET /status` | `{ version, sessionsDir, dbPath, dbBytes, docs, sessions, files, index: { phase, done, total, indexed, skipped, removed, lastError } }` |
| `GET\|POST /search` | 入参 `q`（必填）、`limit`（≤300）、`groupLimit`、`perSession`、`includeTotal` |
| `POST /reindex` | 触发全量对账（`force=true` 时整库重建），异步，进度看 `/status` |
| `GET /ping` | `{ ok: true, version, package }`，重启后用来判断宿主回来了没有 |
| `GET /update` | 查最新版本；`?force=1` 跳过 6 小时缓存。返回 `{ ok, current, latest, hasUpdate, canUpgrade, channel:{kind,…}, installSpec, compatible, stale, restartRequired, upgrading, error }` |
| `GET /update/job` | 升级作业状态 `{ state: idle\|running\|done\|failed, phase, from, to, log, error }` |
| `POST /update/upgrade` | 起一次升级（`{version}` 可指定）。`ok:false` 时看 `reason`：`up-to-date` / `unchanneled` / `busy` / `no-launcher` … |
| `POST /update/restart` | 交接重启：`{ mode: respawn\|exit\|none }` |

`/search` 返回：

```json
{ "q": "插件", "match": "\"插 件\"", "took": 16.1, "total": 872, "truncated": true,
  "groups": [{ "sessionId": "session-…", "title": "…", "cwd": "…", "createdAt": 1793…,
               "docs": [{ "seq": 42, "kind": "assistant", "role": "assistant", "time": 1793…,
                          "snippet": [{ "text": "这个", "mark": false }, { "text": "插件", "mark": true }],
                          "matched": 2 }] }] }
```

### 配置

写在 patch 的条目上即可（都有默认值）：

```yaml
- insert:
    - id: fast-search
      name: dsh-fast-search
      config:
        sessionsDir: C:\Users\win10\.dsh\sessions
        dbPath: C:\Users\win10\.dsh\storages\fast-search.db
        cap: 8192          # 单条消息进索引的最大字符数
        bootDelayMs: 3000  # 宿主启动后延迟多久开始对账
        sweepMs: 900000    # 兜底全量对账间隔
        watch: true        # fs.watch 增量
        update:
          github: zp96324511/dsh-fast-search   # 留空则从安装 spec 自己推断
          checkIntervalMs: 21600000            # 6 小时
          restart: respawn                     # respawn | exit | none
```

## 在线升级

升级通道分三步，任何一步失败都只影响那一步：

1. **判断这一份是从哪装的。** 读 profile 的 `package.json` 里那条依赖：Release 的 tarball URL → 问 GitHub；`^0.2.0` / `latest` → 问 npm registry；`link:` / `file:` / git spec → **不提供**在线升级（就地升级会覆盖本地 checkout，接口会明确回 `unchanneled`）。
2. **问最新版本。** 主路径是 `https://github.com/<owner>/<repo>/releases/latest/download/channel.json`——它跟着 release 的 `latest` 标签走，且不吃 GitHub API 的限流；拿不到就退回 `api.github.com/repos/.../releases/latest`。答案缓存 6 小时。
3. **装 + 重启。** 升级就是跑一遍 `dsh plugin --profile <name> add <spec>`（和用户手敲完全同一条命令），锁文件、失败回滚、兼容性闸门都由它负责；装完用 `node_modules/<pkg>/package.json` 的真实版本对账（pnpm 的供应链延迟策略会让你以为装上了新版）。宿主侧代码不会热更，所以最后要一次重启：`respawn.cjs` 等旧进程退出、端口释放，再把同一条命令行拉起来。

面板上的交互只有两处：版本号（点它强制检查，有新版本时变成 `↑ vX.Y.Z`）和升级/重启按钮。后台静默检查失败不会弹红字——离线机器不该顶着一条错误。

### 发一个新版本

```powershell
# 1. 改 package.json 的 version + CHANGELOG 里加一节
# 2. 本地自检
npm run check
# 3. 提交并打 tag（tag 必须等于 version，publish.yml 会校验）
git add -A; git commit -m "release 0.2.1"; git tag v0.2.1
git push origin main --tags
```

`publish.yml` 会跑自检、`npm pack`、生成 `channel.json`（版本 / 大小 / sha256）、建 release 并上传三个资产：`dsh-fast-search-<version>.tgz`、稳定名 `dsh-fast-search.tgz`、`channel.json`。配置了 `NPM_TOKEN` 时会额外 `npm publish`，没配就跳过。

## 命令行（不装宿主也能用）

```powershell
node cli.mjs build  --db .tmp\test.db --sessions C:\Users\win10\.dsh\sessions --force
node cli.mjs search --db .tmp\test.db "插件" --limit 10
node cli.mjs status --db .tmp\test.db
```

## 测试

```powershell
npm run check               # 清单自检 + 语法 + 两个冒烟测试（CI 跑的就是它）
node test\update-smoke.mjs  # 升级通道：通道分类、版本比较、HTTP 语义、本地副本拒绝升级
node test\client-smoke.mjs  # 不装宿主：工厂 → apply → 槽注册 → 渲染（自带 React 桩）
node test\verify.mjs        # 建库 + 召回真值对照（FTS 计数 vs 全表字面扫描）+ 往返一致性
node bench\cdp-verify.mjs 9222 插件   # 真浏览器端到端：bundle 加载、点图标、搜出结果、截图
node bench\cdp-click.mjs   9222      # 点结果跳会话 + 回来恢复上次查询
```

`bench/` 里还有 P0 基准脚本（分词方案对比、查询分解、逐阶段剖析），结论写在 `docs/p0-baseline.md`。

## 已知限制

- **只索引 `text` 片段**。`reasoning`（27.5MB，占正文 40%）不进索引——它是模型的思考草稿，噪声远大于价值。要打开就改 `decode.js` 里的 `joinParts`。
- **系统提示词默认不入索引**。每个会话的 `system/message` 都是同一份模板，进索引会让「工具」「插件」「agent」这类词被几百份样板文本淹没。
- **面板与主视图互斥**：点结果会切到会话视图，面板被卸载；回来时会自动重跑上次的查询（结果和耗时都是新的）。
- **首查可能慢一拍**：宿主刚重启、OS 页缓存冷时，第一次查询约 300ms，之后稳定在 20ms 内。
- **只搜已落盘的会话**：日志由宿主追加写入，`fs.watch` 250ms 防抖后会补进索引，正在进行的会话可能有几百毫秒延迟。
- **升级必须重启一次**：宿主侧代码（`index.js` / `src/*.js` / `update.js`）不参与 HMR；`restart: none` 时只提示、不自动重启。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 侧栏没有图标 | profile 的 patch 没生效：`GET /plugin-api/dsh-fast-search/status` 若 200 说明宿主已加载，浏览器硬刷新（`Ctrl+Shift+R`）即可 |
| `/plugin-api/...` 404 | patch 里 `id`/`name` 写错，或联接没建好（`Test-Path …\node_modules\dsh-fast-search\index.js`） |
| `lastError: database is locked` | 两个进程同时写库（比如 CLI 建库时宿主也在对账）。已设 `busy_timeout=5000`，重启宿主后自愈 |
| 磁盘上出现几十 MB 的 `fast-search.db-wal` | 大写入后的 WAL 尾巴，收尾时自动 `wal_checkpoint(TRUNCATE)`；也可以手动 `PRAGMA wal_checkpoint(TRUNCATE)` |
| 索引明显落后 | `POST /reindex` 触发对账，盯着 `/status` 的 `index.done/total` |

## 变更记录

见 [CHANGELOG.md](CHANGELOG.md)。最近一次：**0.2.0** — 在线升级（Release tarball + 版本号入口 + 一键重启 + 发布流水线）。
