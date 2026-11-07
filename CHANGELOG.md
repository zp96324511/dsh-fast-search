# 变更记录

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
