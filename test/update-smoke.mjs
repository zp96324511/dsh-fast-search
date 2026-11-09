/**
 * update.js 冒烟测试：不碰网络、不装包、不重启任何东西。
 *
 * 覆盖三层：
 *   1. 纯函数——spec 分类、版本比较、range 判定、安装目标拼装；
 *   2. 路由——用假 req/res 走一遍 HTTP 语义，确认「认领 / 不认领」和状态码；
 *   3. 通道判定——本地 checkout / git spec 必须拒绝在线升级，而不是装个寂寞。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'fs-update-'));
process.env.DSH_HOME = sandbox;

const {
  classifySpec,
  compareVersions,
  isNewer,
  satisfiesRange,
  installSpecFor,
  createUpdater,
  createUpdateRoutes,
  LOADED_VERSION,
  PACKAGE_NAME,
} = await import('../update.js');

/* ------------------------------------------------------------------ *
 * 1. 纯函数
 * ------------------------------------------------------------------ */
assert.equal(classifySpec('link:C:\\data\\projects\\dsh-fast-search').kind, 'link');
assert.equal(classifySpec('file:../x.tgz').kind, 'file');
assert.equal(classifySpec('https://github.com/zp96324511/dsh-fast-search/releases/download/v0.2.0/dsh-fast-search.tgz').kind, 'tarball');
assert.equal(classifySpec('https://github.com/zp96324511/dsh-fast-search').kind, 'git');
assert.equal(classifySpec('github:zp96324511/dsh-fast-search').kind, 'git');
assert.equal(classifySpec('dsh-fast-search@^0.2.0').kind, 'registry');
assert.deepEqual(classifySpec('dsh-fast-search@^0.2.0'), { kind: 'registry', name: 'dsh-fast-search', range: '^0.2.0' });
assert.deepEqual(classifySpec('@scope/pkg@latest'), { kind: 'registry', name: '@scope/pkg', range: 'latest' });

assert.ok(isNewer('0.2.0', '0.1.1'), '0.2.0 比 0.1.1 新');
assert.ok(!isNewer('0.1.1', '0.1.1'), '同版本不算新');
assert.ok(!isNewer('0.1.0', '0.1.1'), '更旧的版本不算新');
assert.ok(isNewer('0.2.0', '0.2.0-rc.1'), '正式版比它的 rc 新');
assert.ok(compareVersions('0.2.0-rc.1', '0.2.0') < 0, 'rc 排在正式版之前');

assert.ok(satisfiesRange('>=0.2.0-rc.2', '0.2.1-rc.2'), 'rc 后缀不能挡住兼容判定');
assert.ok(satisfiesRange('>=0.2.0', '0.2.1-rc.2'), '宽松预发布：运行 rc 仍算满足 >=0.2.0');
assert.ok(satisfiesRange('^0.2.0', '0.2.5'), '插入号范围');
assert.ok(!satisfiesRange('^0.2.0', '0.3.0'), '插入号不跨次版本');
assert.ok(!satisfiesRange('>=0.3.0', '0.2.1-rc.2'), '低于下界要判不兼容');

assert.equal(
  installSpecFor({ kind: 'registry', name: PACKAGE_NAME }, '0.2.0'),
  `${PACKAGE_NAME}@0.2.0`,
  'registry 通道的安装目标就是「名字@版本」',
);
/* GitHub 通道的 URL 是查询答案算出来的（release 里可能自带 url），不是这里拼的 */
assert.equal(installSpecFor({ kind: 'github', repo: 'zp96324511/dsh-fast-search' }, '0.2.0', {}), undefined);
assert.equal(
  installSpecFor({ kind: 'github', repo: 'zp96324511/dsh-fast-search' }, '0.2.0', { installSpec: 'https://example.test/x.tgz' }),
  'https://example.test/x.tgz',
);
assert.equal(installSpecFor({ kind: 'local', path: 'C:\\x' }, '0.2.0', {}), undefined, '本地副本没有安装目标');

/* ------------------------------------------------------------------ *
 * 2. 假 HTTP
 * ------------------------------------------------------------------ */
function makeReq({ method = 'GET', url = '/', body = '' } = {}) {
  const listeners = new Map();
  const req = {
    method,
    url,
    on(event, fn) {
      listeners.set(event, fn);
      if (event === 'data' && body !== '') setImmediate(() => fn(body));
      if (event === 'end') setImmediate(fn);
      return req;
    },
    destroy() {},
  };
  return req;
}

function makeRes() {
  const res = {
    status: 0,
    headers: undefined,
    payload: '',
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end(chunk = '') {
      res.payload += chunk;
    },
    get json() {
      return res.payload === '' ? undefined : JSON.parse(res.payload);
    },
  };
  return res;
}

async function call(handle, options) {
  const res = makeRes();
  const claimed = await handle(makeReq(options), res, options.path);
  return { claimed, res };
}

/* ------------------------------------------------------------------ *
 * 3. 通道：GitHub release（fetch 用桩，绝不联网）
 * ------------------------------------------------------------------ */
const PROFILE = join(sandbox, 'profiles', 'web');
mkdirSync(PROFILE, { recursive: true });
writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({
  name: 'web',
  dependencies: {
    [PACKAGE_NAME]: `https://github.com/zp96324511/${PACKAGE_NAME}/releases/download/v0.1.1/${PACKAGE_NAME}.tgz`,
  },
}));

const fetchCalls = [];
const fakeFetch = async (url) => {
  fetchCalls.push(String(url));
  if (String(url).endsWith('/channel.json')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        name: PACKAGE_NAME,
        channel: 'stable',
        latest: '0.5.0',
        versions: { '0.5.0': { url: 'https://example.test/x.tgz', engines: { dsh: '>=0.2.0' } } },
      }),
      text: async () => '',
    };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

const ctx = { get: (name) => (name === 'profileContext' ? { dir: PROFILE } : undefined), effect: () => () => {} };
const config = {};
const updater = createUpdater({ ctx, config, logger: () => {}, fetch: fakeFetch, spawn: () => { throw new Error('spawn must not run in this test'); } });
const handle = createUpdateRoutes(updater);

{
  const { claimed, res } = await call(handle, { path: '/plugin-api/dsh-fast-search/ping' });
  assert.equal(claimed, true, '/ping 要被认领');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(LOADED_VERSION === res.json.version, 'ping 报的版本要和模块一致');
}

{
  const { claimed, res } = await call(handle, { path: '/plugin-api/dsh-fast-search/update', url: '/plugin-api/dsh-fast-search/update?force=1' });
  assert.equal(claimed, true);
  assert.equal(res.status, 200);
  const info = res.json;
  assert.equal(info.channel.kind, 'github', '从 release tarball 装的副本应走 GitHub 通道');
  assert.equal(info.latest, '0.5.0');
  assert.equal(info.current, LOADED_VERSION);
  assert.equal(info.hasUpdate, true, '0.5.0 应比本机当前版本新');
  assert.equal(info.installSpec, 'https://example.test/x.tgz', '安装目标取 release 里登记的那个 URL');
  assert.ok(fetchCalls.some((u) => u.endsWith('/releases/latest/download/channel.json')), '主路径是 release 里的 channel.json');
}

{
  /* 缓存：非 force 的第二次查询不该再打网络 */
  const before = fetchCalls.length;
  await call(handle, { path: '/plugin-api/dsh-fast-search/update', url: '/plugin-api/dsh-fast-search/update' });
  assert.equal(fetchCalls.length, before, '6 小时缓存内不应重复请求');
}

{
  const { claimed } = await call(handle, { path: '/plugin-api/dsh-fast-search/search' });
  assert.equal(claimed, false, '搜索路径不该被升级路由吞掉');
}

{
  const { claimed, res } = await call(handle, { path: '/plugin-api/dsh-fast-search/update/job' });
  assert.equal(claimed, true);
  assert.equal(res.json.state, 'idle');
}

{
  const { claimed } = await call(handle, { method: 'POST', path: '/plugin-api/dsh-fast-search/update/restart' });
  assert.equal(claimed, false, '插件不再提供宿主重启端点');
}

/* ------------------------------------------------------------------ *
 * 4. 通道：本地 checkout 必须拒绝在线升级
 * ------------------------------------------------------------------ */
{
  const local = join(sandbox, 'profiles', 'local');
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, 'package.json'), JSON.stringify({
    name: 'web',
    dependencies: { [PACKAGE_NAME]: 'link:C:\\data\\projects\\dsh-fast-search' },
  }));
  const localCtx = { get: (name) => (name === 'profileContext' ? { dir: local } : undefined) };
  const localUpdater = createUpdater({ ctx: localCtx, config, logger: () => {}, fetch: fakeFetch });
  const localHandle = createUpdateRoutes(localUpdater);

  const check = await call(localHandle, { path: '/plugin-api/dsh-fast-search/update', url: '/plugin-api/dsh-fast-search/update?force=1' });
  assert.equal(check.res.json.channel.kind, 'local', 'link: 装的副本应识别为本地通道');
  assert.equal(check.res.json.hasUpdate, false);

  const upgrade = await call(localHandle, { method: 'POST', path: '/plugin-api/dsh-fast-search/update/upgrade' });
  assert.equal(upgrade.res.status, 200);
  assert.equal(upgrade.res.json.ok, false);
  assert.equal(upgrade.res.json.reason, 'unchanneled', '本地副本不该被在线升级覆盖');
  localUpdater.dispose();
}

updater.dispose();
rmSync(sandbox, { recursive: true, force: true });

console.log(`update.js 冒烟通过：通道分类、版本比较、range 判定、/ping、/update、缓存、本地拒绝升级、无重启端点（模块版本 ${LOADED_VERSION}）`);
