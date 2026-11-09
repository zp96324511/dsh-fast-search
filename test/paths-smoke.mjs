#!/usr/bin/env node
/**
 * 数据根冒烟：`sessionsDir` / `dbPath` 必须跟着 `$DSH_HOME` 走。
 *
 * 回归对象（0.4.3 之前）：默认值写死成 `~/.dsh`，于是 `DSH_HOME` 不在用户目录的机器
 * （Windows 上 `D:\DeepSeekHarness\data`）会去索引一份历史遗留的旧 home——工作区下拉
 * 只剩几个旧项目、近期会话一条都搜不到，而前端看起来毫无问题（yhzp 实测：16 场 /
 * 2,024 条 / 2 个工作区）。
 *
 * 每个用例起一个子进程：`resolveDshHome()` 读的是 `process.env`，在同一个进程里改
 * 环境会影响别的断言，也不容易验证「变量确实不存在」那条分支。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const entry = pathToFileURL(path.join(root, 'index.js')).href;

/* 子进程只做一件事：按当前环境算一遍默认落点，显式配置另算一遍 */
const probe = `
  const { resolveDataPaths } = await import(process.env.PROBE_URL);
  const explicit = process.env.PROBE_EXPLICIT === undefined
    ? null
    : {
        sessionsDir: process.env.PROBE_EXPLICIT + '-sessions',
        dbPath: process.env.PROBE_EXPLICIT + '.db',
      };
  process.stdout.write(JSON.stringify({
    defaults: resolveDataPaths(),
    explicit: explicit === null ? null : resolveDataPaths(explicit),
  }));
`;

/**
 * @param {Record<string, string | undefined>} env 覆盖项；值为 undefined 表示删掉该变量
 */
function probeWith(env) {
  const merged = { ...process.env, ...env, PROBE_URL: entry };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: root,
    env: merged,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

const defaultHome = path.resolve(path.join(os.homedir(), '.dsh'));
const customHome = path.resolve(os.tmpdir(), 'fs-paths-smoke-home');

/* ---------- 1. $DSH_HOME 生效：不在用户目录也要跟过去 ---------- */
{
  const out = probeWith({ DSH_HOME: customHome });
  assert.equal(out.defaults.sessionsDir, path.join(customHome, 'sessions'));
  assert.equal(out.defaults.dbPath, path.join(customHome, 'storages', 'fast-search.db'));
  assert.notEqual(out.defaults.sessionsDir, path.join(defaultHome, 'sessions'), '不能落回 ~/.dsh');
}

/* ---------- 2. 显式配置仍然优先于 $DSH_HOME ---------- */
{
  const explicit = path.join(customHome, 'explicit');
  const out = probeWith({ DSH_HOME: customHome, PROBE_EXPLICIT: explicit });
  assert.equal(out.explicit.sessionsDir, `${explicit}-sessions`);
  assert.equal(out.explicit.dbPath, `${explicit}.db`);
}

/* ---------- 3. 空白 $DSH_HOME 当作未设置（与 DSH 的 resolveDshHome 一致） ---------- */
{
  const out = probeWith({ DSH_HOME: '   ' });
  assert.equal(out.defaults.sessionsDir, path.join(defaultHome, 'sessions'));
  assert.equal(out.defaults.dbPath, path.join(defaultHome, 'storages', 'fast-search.db'));
}

/* ---------- 4. 没有 $DSH_HOME 时回落到 ~/.dsh ---------- */
{
  const out = probeWith({ DSH_HOME: undefined });
  assert.equal(out.defaults.sessionsDir, path.join(defaultHome, 'sessions'));
  assert.equal(out.defaults.dbPath, path.join(defaultHome, 'storages', 'fast-search.db'));
}

console.log('paths-smoke ok：$DSH_HOME 生效、显式配置优先、空白回退、默认 ~/.dsh（4 组断言）');
