/**
 * dsh-fast-search — 在线升级通道（宿主半边）。
 *
 * 参考 dsh-context-control 的 update.js，按本插件的形态裁到三件互相独立的事，
 * 因为它们的失败模式完全不同：
 *
 * 1. **检查**（只读）——问「安装来源」这个通道有没有新版本，答案缓存 6 小时。
 *    通道挂了只会得到「未知」，不会变成「已是最新」。
 * 2. **升级**——跑一条用户自己也会敲的命令：`dsh plugin --profile <p> add <spec>`。
 *    走同一条路意味着继承插件管理器的清单锁、失败回滚和兼容性检查；而且是
 *    「就地换版本」而不是先卸载再装（自升级半路失败必须还能用）。
 * 3. **重启**——宿主自己退出，一个脱离的 helper 等旧进程死掉、端口释放后把同一条
 *    命令再拉起来。没有监督进程时直接退出会把 GUI 变成一具尸体。
 *
 * 通道形态（按 profile 里的依赖 spec 自动判断）：
 * - `https://github.com/<owner>/<repo>/releases/download/vX.Y.Z/<pkg>.tgz` → GitHub Release
 * - 普通 registry 范围（`^1.2.3`、`latest`）→ npm registry
 * - `link:` / `file:`（本地 checkout，开发形态）→ 不提供在线升级
 * - `github:owner/repo#vX` 这类 git spec → 版本无法比较，不提供在线升级
 *
 * 任何一处出错都只让升级不可用，绝不影响搜索本体：index.js 把整个模块包在 try/catch 里。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'dsh-fast-search';

/** 本包根目录（index.js / update.js 都在根上）。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** 正在运行的代码的版本——磁盘上的 package.json 可能已经被升级改写了。 */
export const LOADED_VERSION = readOwnManifest().version;

function readOwnManifest() {
  const manifest = readJson(join(HERE, 'package.json'));
  return typeof manifest?.version === 'string' ? manifest : { version: '0.0.0' };
}

/** 从 package.json 的 repository 字段推出 `owner/repo`。 */
export function repoFromManifest() {
  const manifest = readJson(join(HERE, 'package.json'));
  const url = typeof manifest?.repository === 'string' ? manifest.repository : manifest?.repository?.url;
  if (typeof url !== 'string') return undefined;
  const match = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[#/]|$)/i.exec(url);
  return match === null ? undefined : match[1];
}

const LOG_LIMIT = 48 * 1024;
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const UPGRADE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_WEB_PORT = 10550;

/* ------------------------------------------------------------------ *
 * 版本号
 * ------------------------------------------------------------------ */

/** 把语义化版本拆成部件；不是版本号时返回 undefined。 */
export function parseVersion(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function comparePrereleaseIdentifiers(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** 语义化版本先后：-1 | 0 | 1。解析不了的一律视为相等。 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === undefined || b === undefined) return 0;
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  return comparePrereleaseIdentifiers(a.prerelease, b.prerelease);
}

/** `candidate` 是否严格新于 `current`。 */
export function isNewer(candidate, current) {
  if (parseVersion(candidate) === undefined) return false;
  return compareVersions(candidate, current) > 0;
}

/**
 * `version` 是否满足 `>=0.2.0-rc.2` / `^0.3.0` 这类范围。
 *
 * 只用于界面显示（「这个更新声明兼容当前 DSH 吗」）。权威检查在插件管理器里，
 * 这里乐观一点只会换来一次带真实诊断的失败安装，悲观一点却会藏掉一个合法更新。
 * `loosePrerelease` 对应 DSH 本身是预发布版的情况：范围按 `>=0.2.0` 写，运行时是
 * `0.2.1-rc.2`，严格 npm 语义会判全部不兼容。
 */
export function satisfiesRange(range, version, { loosePrerelease = true } = {}) {
  if (typeof range !== 'string' || range.trim() === '') return true;
  const parsed = parseVersion(version);
  if (parsed === undefined) return false;
  const loose = loosePrerelease && parsed.prerelease.length > 0;
  const triple = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  const effective = loose ? triple : version;
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter((part) => part !== '');
    if (comparators.length === 0) return true;
    if (!loose && parsed.prerelease.length > 0) {
      const namesThisPrerelease = comparators.some((comparator) => {
        const wanted = expandComparatorVersion(comparator.replace(/^(?:>=|<=|>|<|=|\^|~)\s*/, ''));
        return wanted !== undefined && wanted.suffix !== '' && wanted.version === triple;
      });
      if (!namesThisPrerelease) return false;
    }
    return comparators.every((comparator) => matchesComparator(comparator, effective));
  });
}

/** 把比较符的版本展开成下界（通配形式再算上界）：`0.3` 即 `0.3.x`。 */
function expandComparatorVersion(value) {
  const match = /^v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (match === null) return undefined;
  const parts = [match[1], match[2], match[3]];
  let wildcardFrom = 3;
  const numbers = parts.map((part, index) => {
    if (part === undefined || /^(?:x|X|\*)$/.test(part)) {
      if (wildcardFrom === 3) wildcardFrom = index;
      return '0';
    }
    return String(Number(part));
  });
  const version = numbers.join('.');
  const suffix = match[4] ?? '';
  return { version, suffix, full: `${version}${suffix}`, wildcardFrom, parts: numbers.map(Number) };
}

function matchesComparator(comparator, version) {
  const operatorMatch = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator);
  if (operatorMatch === null) return false;
  const operator = operatorMatch[1] ?? '=';
  const wantedRaw = operatorMatch[2];
  if (/^(?:\*|x|X)$/.test(wantedRaw.trim())) return true;

  const wanted = expandComparatorVersion(wantedRaw);
  if (wanted === undefined) return false;
  const order = compareVersions(version, wanted.full);

  const ceiling = (fields) => {
    const [major, minor, patch] = wanted.parts;
    if (fields === 1) return `${major + 1}.0.0`;
    if (fields === 2) return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
  };

  switch (operator) {
    case '>=': return order >= 0;
    case '>': return order > 0;
    case '<=': return order <= 0;
    case '<': return order < 0;
    case '=':
      return wanted.wildcardFrom === 3
        ? order === 0
        : order >= 0 && compareVersions(version, ceiling(wanted.wildcardFrom)) < 0;
    case '^': {
      if (order < 0) return false;
      const fields = wanted.parts[0] > 0 ? 1 : wanted.parts[1] > 0 ? 2 : 3;
      return compareVersions(version, ceiling(fields)) < 0;
    }
    case '~': {
      if (order < 0) return false;
      return compareVersions(version, ceiling(2)) < 0;
    }
    default: return false;
  }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 带超时的 fetch；失败时抛一句能看懂的话。 */
async function fetchJson(url, { timeout = FETCH_TIMEOUT_MS, headers = {}, fetch: fetchImpl } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await (fetchImpl ?? fetch)(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': `${PACKAGE_NAME}-updater`, ...headers },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`timed out after ${timeout}ms: ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * profile / launcher / 通道
 * ------------------------------------------------------------------ */

/** DSH home，和启动器解析方式保持一致。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return join(homedir(), '.dsh');
}

/**
 * 按 pnpm / 插件管理器的口径给依赖 spec 分类。
 * 类别决定「哪个通道能回答有没有新版本」：registry 范围有 tag 可问，
 * tarball URL 有 GitHub Release 或同目录的 channel.json 可问。
 */
export function classifySpec(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return { kind: 'unknown' };
  const value = spec.trim();
  if (/^(?:link|portal):/i.test(value)) return { kind: 'link', path: value.replace(/^(?:link|portal):/i, '') };
  if (/^file:/i.test(value)) return { kind: 'file', path: value.replace(/^file:/i, '') };
  if (/^(?:https?):\/\//i.test(value)) {
    return /\.(?:tgz|tar\.gz)$/i.test(value.split(/[?#]/)[0])
      ? { kind: 'tarball', url: value }
      : { kind: 'git', url: value };
  }
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:)/i.test(value) || /\.git(?:#|$)/i.test(value)) {
    return { kind: 'git', url: value };
  }
  const at = value.lastIndexOf('@');
  if (at > 0) return { kind: 'registry', name: value.slice(0, at), range: value.slice(at + 1) };
  return { kind: 'registry', name: value, range: '*' };
}

/** 读 profile 自己给本包写的那条依赖。 */
export function readProfileDependency(profileDir, name = PACKAGE_NAME) {
  const manifest = readJson(join(profileDir, 'package.json'));
  if (manifest === undefined) return { spec: undefined, kind: 'unknown', manifest: undefined };
  const spec = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
  return { spec, ...classifySpec(spec), manifest };
}

/** 本进程服务的 web 端口，重启时要等它释放。 */
function resolvePort(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--port' && index + 1 < argv.length) return Number(argv[index + 1]) || undefined;
    const inline = /^--port=(.+)$/.exec(argument);
    if (inline !== null) return Number(inline[1]) || undefined;
  }
  return undefined;
}

/** 正在跑的 DSH 启动脚本（`.../@deepseek-ai/dsh/lib/bin.js`）。 */
export function resolveLauncher() {
  const fromEnv = process.env.DSH_BIN;
  if (typeof fromEnv === 'string' && fromEnv !== '' && existsSync(fromEnv)) return fromEnv;
  const argvScript = process.argv[1];
  if (typeof argvScript === 'string' && /(?:^|[\\/])bin\.js$/.test(argvScript) && existsSync(argvScript)) {
    return argvScript;
  }
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve('@deepseek-ai/dsh/package.json');
    const candidate = join(dirname(manifest), 'lib', 'bin.js');
    if (existsSync(candidate)) return candidate;
  } catch { /* 解析不到就靠 argv */ }
  return undefined;
}

/** 运行中的 DSH 版本，从启动器所属的安装里读。 */
export function resolveRuntimeVersion(launcher) {
  if (typeof launcher === 'string') {
    const manifest = readJson(join(dirname(dirname(launcher)), 'package.json'));
    if (typeof manifest?.version === 'string') return manifest.version;
  }
  return undefined;
}

/**
 * 本宿主用的 profile、它的依赖 spec、以及 profile 名——CLI 要的三件东西。
 * `profileContext` 是启动器自己的答案，扫描是拿不到它时的兜底。
 */
export function findProfile(ctx, name = PACKAGE_NAME) {
  try {
    const context = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined;
    if (context !== undefined && typeof context?.dir === 'string' && existsSync(join(context.dir, 'package.json'))) {
      return { dir: context.dir, name: basename(context.dir), ...readProfileDependency(context.dir, name), source: 'profileContext' };
    }
  } catch { /* 落到扫描 */ }
  const profilesDir = join(resolveDshHome(), 'profiles');
  let entries = [];
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const dir = join(profilesDir, entry);
    const dependency = readProfileDependency(dir, name);
    if (dependency.spec !== undefined) return { dir, name: entry, ...dependency, source: 'scan' };
  }
  return undefined;
}

/** pnpm 会用的 registry，来自 `.npmrc` 或环境变量。 */
export function resolveRegistry(fallback = 'https://registry.npmjs.org/') {
  const fromEnv = process.env.npm_config_registry;
  if (typeof fromEnv === 'string' && /^https?:\/\//.test(fromEnv)) return fromEnv;
  try {
    const npmrc = readFileSync(join(homedir(), '.npmrc'), 'utf8');
    const match = /^\s*registry\s*=\s*(\S+)\s*$/m.exec(npmrc);
    if (match !== null && /^https?:\/\//.test(match[1])) return match[1];
  } catch { /* 没有 .npmrc */ }
  return fallback;
}

/**
 * 这个 profile 的依赖该由哪个通道来回答。
 *
 * 显式配置优先（`update.github` / `update.registry`）；否则看安装 spec，
 * 这样「从哪个 URL 装的就从哪个 URL 升级」，用户不用手配。
 */
export function resolveChannel({ config, profile }) {
  const update = config?.update ?? {};
  const name = update.packageName ?? PACKAGE_NAME;
  const kind = profile?.kind ?? 'unknown';

  if (typeof update.github === 'string' && /^[\w.-]+\/[\w.-]+$/.test(update.github.trim())) {
    return { kind: 'github', name, repo: update.github.trim(), origin: 'config' };
  }
  if (kind === 'tarball') {
    // GitHub Release 的 tarball URL：同目录的 channel.json 冻结在那一版上，
    // 永远看不到下一个 release；仓库级的 releases/latest 才会跟着 latest 走。
    const url = profile.url.split(/[?#]/)[0];
    const repoMatch = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\//i.exec(url);
    if (repoMatch !== null) {
      const repo = repoMatch[1].replace(/\.git$/, '');
      // 从哪个仓库装的就问哪个仓库的 latest，而不是那一版冻结的 channel.json。
      return { kind: 'github', name, repo, origin: 'spec', tarball: url };
    }
    return { kind: 'manifest', name, manifestUrl: new URL('channel.json', url).href, origin: 'spec' };
  }
  if (kind === 'link' || kind === 'file') {
    // 本地 checkout 不是发行版：就地升级会覆盖作者的工作区，只能在显式配置某通道时提供。
    return { kind: 'local', name, path: profile.path, origin: 'spec' };
  }
  if (kind === 'git') {
    return { kind: 'git', name, url: profile.url, origin: 'spec' };
  }
  const registry = typeof update.registry === 'string' && update.registry.trim() !== ''
    ? update.registry.trim()
    : resolveRegistry();
  return { kind: 'registry', name, registry, origin: kind === 'registry' ? 'spec' : 'config' };
}

/**
 * 问通道最新版本是多少。
 * @returns {Promise<{version?: string, notes?: string, engines?: object, publishedAt?: string,
 *                    url?: string, installSpec?: string, error?: string}>}
 */
export async function queryChannel(channel, { timeout = FETCH_TIMEOUT_MS, fetch: fetchImpl, repo } = {}) {
  try {
    if (channel.kind === 'registry') {
      const base = channel.registry.replace(/\/$/, '');
      const document = await fetchJson(`${base}/${encodeURIComponent(channel.name).replace(/^%40/, '@')}/latest`, { timeout, fetch: fetchImpl });
      if (typeof document?.version !== 'string') return { error: 'registry answered without a version' };
      let engines;
      try {
        engines = (await fetchJson(`${base}/${encodeURIComponent(channel.name).replace(/^%40/, '@')}/${document.version}`, { timeout, fetch: fetchImpl }))?.engines;
      } catch { /* engines 只是参考 */ }
      return {
        version: document.version,
        notes: typeof document.description === 'string' ? document.description : undefined,
        engines,
        url: typeof document.homepage === 'string' ? document.homepage : undefined,
        installSpec: `${channel.name}@${document.version}`,
      };
    }
    if (channel.kind === 'github') {
      const target = channel.repo ?? repo;
      if (typeof target !== 'string') return { error: 'not a GitHub channel' };
      // 主路径是 release 里那份 channel.json：它跟着 `latest` 走，且不吃 API 限流。
      const stable = `https://github.com/${target}/releases/latest/download/channel.json`;
      try {
        const document = await fetchJson(stable, { timeout, fetch: fetchImpl });
        const latest = typeof document?.latest === 'string' ? document.latest : undefined;
        if (latest !== undefined) {
          const entry = document?.versions?.[latest] ?? {};
          const file = channel.name.replace(/^@[^/]+\//, '');
          return {
            version: latest,
            notes: typeof entry.notes === 'string' ? entry.notes : (typeof document.notes === 'string' ? document.notes : undefined),
            engines: entry.engines ?? document.engines,
            publishedAt: entry.publishedAt ?? document.publishedAt,
            url: typeof document.homepage === 'string' ? document.homepage : `https://github.com/${target}`,
            installSpec: typeof entry.url === 'string' && entry.url !== ''
              ? entry.url
              : `https://github.com/${target}/releases/download/v${latest}/${file}.tgz`,
          };
        }
      } catch { /* channel.json 不可用就退回 API */ }
      const release = await fetchJson(`https://api.github.com/repos/${target}/releases/latest`, {
        timeout,
        fetch: fetchImpl,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' },
      });
      const tag = typeof release?.tag_name === 'string' ? release.tag_name : undefined;
      if (tag === undefined) return { error: 'release has no tag_name' };
      const version = tag.replace(/^v/i, '');
      const file = channel.name.replace(/^@[^/]+\//, '');
      return {
        version,
        notes: typeof release?.body === 'string' ? release.body.slice(0, 4000) : undefined,
        publishedAt: release?.published_at,
        url: release?.html_url ?? `https://github.com/${target}`,
        installSpec: `https://github.com/${target}/releases/download/${tag}/${file}.tgz`,
      };
    }
    if (channel.kind === 'manifest') {
      const document = await fetchJson(channel.manifestUrl, { timeout, fetch: fetchImpl });
      const latest = typeof document?.latest === 'string' ? document.latest : undefined;
      if (latest === undefined) return { error: 'channel document has no "latest"' };
      const entry = document?.versions?.[latest] ?? {};
      const raw = typeof entry.url === 'string' ? entry.url : undefined;
      return {
        version: latest,
        notes: typeof entry.notes === 'string' ? entry.notes : (typeof document.notes === 'string' ? document.notes : undefined),
        engines: entry.engines ?? document.engines,
        publishedAt: entry.publishedAt ?? document.publishedAt,
        url: typeof document.homepage === 'string' ? document.homepage : undefined,
        installSpec: raw === undefined ? undefined : new URL(raw, channel.manifestUrl).href,
      };
    }
    if (channel.kind === 'local') {
      return { error: `installed from a local path (${channel.path}); set update.github to upgrade from a release` };
    }
    if (channel.kind === 'git') {
      return { error: `installed from a git spec (${channel.url}), which carries no version to compare; set update.github to upgrade from a release` };
    }
    return { error: `channel "${channel.kind}" cannot be queried` };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

/** 给 `dsh plugin add` 的参数——和用户手敲的是同一个字符串。 */
export function installSpecFor(channel, version, info = {}) {
  if (channel.kind === 'registry') return `${channel.name}@${version}`;
  if (channel.kind === 'github' || channel.kind === 'manifest') {
    return typeof info.installSpec === 'string' && info.installSpec !== '' ? info.installSpec : undefined;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * updater
 * ------------------------------------------------------------------ */

/**
 * 造一个 updater：带缓存的版本检查、只允许一个在跑的升级作业、以及重启交接。
 *
 * @param options.ctx     宿主上下文（只用来读 `profileContext`）
 * @param options.config  插件配置；`config.update` 每次调用时读，改配置不用重载
 * @param options.logger  警告出口（`logger.warn` 形状）
 */
export function createUpdater({ ctx, config, logger, spawn: spawnProcess = spawn, fetch: fetchImpl } = {}) {
  const warn = (message) => {
    try { logger?.(message); } catch { /* 日志坏了不能拖垮路由 */ }
  };

  const state = { check: undefined, job: undefined, profile: undefined };
  // 插件重载（安装后的 HMR 重组）会起一个新的模块实例，触发那次安装的结果必须活下来。
  state.job = loadJobRecord();

  const updateConfig = () => (config?.update ?? {});
  const repo = () => updateConfig().github ?? repoFromManifest();

  /** 磁盘上的真实版本——故意每次读：安装会先改写它，而内存里的模块还是旧的。 */
  function version() {
    return readOwnManifest().version;
  }

  /** 运行中的模块是否落后于磁盘上的文件。 */
  function stale() {
    return LOADED_VERSION !== version();
  }

  function profile() {
    if (state.profile === undefined) state.profile = findProfile(ctx, updateConfig().packageName ?? PACKAGE_NAME);
    return state.profile;
  }

  function channel() {
    return resolveChannel({ config: config ?? {}, profile: profile() });
  }

  function launcher() {
    const override = updateConfig().launcher;
    if (typeof override === 'string' && override !== '') return override;
    return resolveLauncher();
  }

  function runtimeVersion() {
    const override = updateConfig().runtimeVersion;
    if (typeof override === 'string' && override !== '') return override;
    return resolveRuntimeVersion(launcher());
  }

  function hmr() {
    try {
      return (typeof ctx?.get === 'function' ? ctx.get('hmr') : undefined) !== undefined;
    } catch {
      return false;
    }
  }

  /** 版本检查，缓存 `update.checkIntervalMs`。 */
  async function check({ force = false } = {}) {
    const ttl = Number(updateConfig().checkIntervalMs ?? CHECK_TTL_MS);
    const cached = state.check;
    if (cached !== undefined && !force && Date.now() - cached.at < ttl) return cached.result;

    const current = version();
    const resolved = channel();
    const profileInfo = profile();
    const answer = profileInfo === undefined && resolved.origin !== 'config'
      ? { error: 'profile not found: cannot tell which channel this copy came from; set update.github' }
      : await queryChannel(resolved, { fetch: fetchImpl, repo: repo() });

    const latest = typeof answer.version === 'string' ? answer.version : undefined;
    const hasUpdate = latest !== undefined && isNewer(latest, current);
    const runtime = runtimeVersion();
    const compatible = typeof answer.engines?.dsh === 'string' && typeof runtime === 'string'
      ? satisfiesRange(answer.engines.dsh, runtime)
      : undefined;
    const result = {
      ok: answer.error === undefined,
      current,
      latest,
      hasUpdate,
      canUpgrade: hasUpdate && typeof installSpecFor(resolved, latest, answer) === 'string' && profileInfo !== undefined,
      channel: {
        kind: resolved.kind,
        origin: resolved.origin,
        ...(resolved.registry ? { registry: resolved.registry } : {}),
        ...(resolved.repo ? { repo: resolved.repo } : {}),
        ...(resolved.manifestUrl ? { manifestUrl: resolved.manifestUrl } : {}),
      },
      installSpec: installSpecFor(resolved, latest ?? current, answer) ?? answer.installSpec,
      notes: answer.notes,
      publishedAt: answer.publishedAt,
      url: answer.url,
      installedSpec: profileInfo?.spec,
      profile: profileInfo === undefined ? undefined : { name: profileInfo.name, dir: profileInfo.dir, source: profileInfo.source },
      runtime,
      compatible,
      engines: answer.engines,
      checkedAt: Date.now(),
      error: answer.error,
      upgrading: state.job?.state === 'running',
      hmr: hmr(),
      loaded: LOADED_VERSION,
      restartRequired: stale() || !hmr(),
      stale: stale(),
    };
    state.check = { at: Date.now(), result };
    return result;
  }

  function append(job, stream, text) {
    job.log += text;
    if (job.log.length > LOG_LIMIT) job.log = job.log.slice(job.log.length - LOG_LIMIT);
    job.updatedAt = Date.now();
    for (const listener of job.listeners) {
      try { listener({ stream, text }); } catch { /* 一个坏监听不能拖垮整条流 */ }
    }
  }

  function jobView(job) {
    if (job === undefined) return { state: 'idle' };
    return {
      id: job.id,
      state: job.state,
      phase: job.phase,
      from: job.from,
      to: job.to,
      spec: job.spec,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      installed: job.installed,
      restartRequired: job.restartRequired,
      error: job.error,
      log: job.log,
    };
  }

  function jobRecordPath() {
    return join(resolveDshHome(), 'storages', `${PACKAGE_NAME.replace(/^@[^/]+\//, '')}-update.json`);
  }

  function saveJobRecord(job) {
    try {
      mkdirSync(dirname(jobRecordPath()), { recursive: true });
      writeFileSync(jobRecordPath(), `${JSON.stringify({ savedAt: Date.now(), job: jobView(job) }, null, 2)}\n`);
    } catch { /* 记录只是顺手，不是依赖 */ }
  }

  function loadJobRecord() {
    const record = readJson(jobRecordPath());
    if (record === undefined || typeof record?.savedAt !== 'number') return undefined;
    if (Date.now() - record.savedAt > 24 * 60 * 60 * 1000) return undefined;
    const restored = record.job;
    if (restored === undefined || typeof restored !== 'object') return undefined;
    return {
      ...restored,
      // 读记录时还标着 running 的作业已经没有进程了：报成停止，别一直转圈。
      state: restored.state === 'running' ? 'failed' : restored.state,
      ...(restored.state === 'running' ? { error: 'the install was interrupted by a reload' } : {}),
      listeners: new Set(),
      child: undefined,
      timer: undefined,
    };
  }

  /**
   * 一键升级：像用户在 shell 里那样跑 `dsh plugin add <spec>`。
   * 这样清单锁、失败回滚、兼容性闸门都在同一个地方，而且不会出现
   * 「先卸载、装到一半失败」导致插件直接不存在的局面。
   */
  async function upgrade({ version: target } = {}) {
    if (state.job?.state === 'running') return { ok: false, reason: 'busy', job: jobView(state.job) };

    const resolved = channel();
    if (resolved.kind === 'local' || resolved.kind === 'git') {
      return {
        ok: false,
        reason: 'unchanneled',
        channel: resolved.kind,
        error: resolved.kind === 'local'
          ? 'this copy is a local checkout; install from a release (or set update.github) to upgrade in place'
          : 'this copy came from a git spec; set update.github to upgrade in place',
      };
    }

    let info = await check({ force: false });
    const requested = typeof target === 'string' && target !== '' ? target : undefined;
    // 缓存的答案可能早于用户刚发的那个 release：点升级就是「再看一眼」。
    if (requested === undefined && (info.latest === undefined || !isNewer(info.latest, info.current))) {
      info = await check({ force: true });
    }
    if (info.error !== undefined && info.hasUpdate !== true) {
      return { ok: false, reason: 'check-failed', error: info.error };
    }
    const to = requested ?? info.latest;
    if (typeof to !== 'string') return { ok: false, reason: 'no-version', check: info };
    if (!isNewer(to, info.current)) {
      return { ok: false, reason: 'up-to-date', check: info, current: info.current, latest: to };
    }

    const profileInfo = profile();
    if (profileInfo === undefined) return { ok: false, reason: 'no-profile' };
    const spec = installSpecFor(resolved, to, info);
    if (spec === undefined) return { ok: false, reason: 'unchanneled', channel: resolved.kind, error: 'this channel supplies no install target' };

    const cli = launcher();
    if (cli === undefined) return { ok: false, reason: 'no-launcher', error: 'cannot locate the dsh launcher to run the install' };

    const job = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      state: 'running',
      phase: 'install',
      from: info.current,
      to,
      spec,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      log: '',
      listeners: new Set(),
      child: undefined,
      timer: undefined,
    };
    state.job = job;
    append(job, 'system', `$ dsh plugin --profile ${profileInfo.name} add ${spec}\n`);

    let child;
    try {
      child = spawnProcess(process.execPath, [cli, 'plugin', '--profile', profileInfo.name, 'add', spec], {
        cwd: profileInfo.dir,
        env: { ...process.env, DSH_HOME: resolveDshHome() },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      job.state = 'failed';
      job.error = String(error?.message ?? error);
      job.finishedAt = Date.now();
      append(job, 'system', `${job.error}\n`);
      return { ok: false, reason: 'spawn-failed', error: job.error, job: jobView(job) };
    }
    job.child = child;

    const timeout = Number(updateConfig().upgradeTimeoutMs ?? UPGRADE_TIMEOUT_MS);
    job.timer = setTimeout(() => {
      append(job, 'system', `\n[timeout] install exceeded ${timeout}ms; stopping it\n`);
      try { child.kill(); } catch { /* 已经没了 */ }
    }, timeout);
    job.timer.unref?.();

    const finish = async (exitCode, signal) => {
      clearTimeout(job.timer);
      job.exitCode = exitCode;
      job.finishedAt = Date.now();
      if (signal !== undefined && exitCode === null) {
        job.state = 'failed';
        job.error = `install stopped (${signal})`;
        return;
      }
      if (exitCode !== 0) {
        job.state = 'failed';
        job.error = `dsh plugin add exited with ${exitCode}`;
        const diagnostics = /diagnostics: (.+)$/m.exec(job.log);
        if (diagnostics !== null) job.error += ` — log: ${diagnostics[1]}`;
        return;
      }
      // pnpm 的退出码不等于「装的就是我要求的版本」（供应链延迟策略会装旧版）。
      job.phase = 'verify';
      const installedManifest = readJson(join(profileInfo.dir, 'node_modules', updateConfig().packageName ?? PACKAGE_NAME, 'package.json'));
      job.installed = typeof installedManifest?.version === 'string' ? installedManifest.version : undefined;
      job.state = 'done';
      job.restartRequired = stale() || !hmr();
      if (job.installed !== undefined && job.installed !== to) job.error = `installed ${job.installed}, requested ${to}`;
      append(job, 'system', `\n[done] installed ${job.installed ?? 'unknown'}${job.restartRequired ? ' — restart required' : ''}\n`);
      state.check = undefined;
      state.profile = undefined;
    };

    child.stdout?.on('data', (chunk) => append(job, 'stdout', String(chunk)));
    child.stderr?.on('data', (chunk) => append(job, 'stderr', String(chunk)));
    child.on('error', (error) => {
      clearTimeout(job.timer);
      job.state = 'failed';
      job.error = String(error?.message ?? error);
      job.finishedAt = Date.now();
      append(job, 'system', `${job.error}\n`);
    });
    child.on('close', (code, signal) => {
      void finish(code, signal).finally(() => { saveJobRecord(job); });
    });

    return { ok: true, job: jobView(job) };
  }

  function subscribe(listener) {
    const job = state.job;
    if (job === undefined) return () => {};
    job.listeners.add(listener);
    return () => { job.listeners.delete(listener); };
  }

  /**
   * 重启宿主。
   * `respawn`（默认）起一个脱离的 helper，等本进程退出、端口释放后重跑同一命令行；
   * `exit` 留给有监督进程的宿主；`none` 只报告用户该做什么。
   */
  function restart() {
    const restartConfig = updateConfig().restart ?? {};
    const mode = typeof restartConfig.mode === 'string' ? restartConfig.mode : 'respawn';
    if (mode === 'none') return { ok: true, mode, restarted: false };
    if (mode === 'exit') {
      setTimeout(() => process.exit(0), 150);
      return { ok: true, mode, restarted: true };
    }
    const cli = launcher();
    if (cli === undefined) {
      setTimeout(() => process.exit(0), 150);
      return { ok: true, mode: 'exit', restarted: true, warning: 'launcher not found: exited without a respawn helper' };
    }
    const helper = join(HERE, 'respawn.cjs');
    if (!existsSync(helper)) {
      setTimeout(() => process.exit(0), 150);
      return { ok: true, mode: 'exit', restarted: true, warning: 'respawn.cjs missing from the package: exited without a helper' };
    }
    const payload = {
      pid: process.pid,
      argv: [process.execPath, cli, ...process.argv.slice(2)],
      cwd: process.cwd(),
      env: { ...process.env },
      port: resolvePort(process.argv) ?? Number(restartConfig.port ?? DEFAULT_WEB_PORT),
      log: restartConfig.logFile ?? join(resolveDshHome(), 'logs', `${basename(process.argv[1] ?? 'dsh').replace(/\.js$/, '')}-respawn.log`),
    };
    try {
      const child = spawnProcess(process.execPath, [helper, Buffer.from(JSON.stringify(payload)).toString('base64')], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        cwd: payload.cwd,
        env: process.env,
      });
      child.unref();
    } catch (error) {
      warn(`${PACKAGE_NAME}: respawn helper failed to start: ${String(error)}`);
      return { ok: false, mode: 'respawn', restarted: true, error: String(error?.message ?? error) };
    }
    // 留一点时间让响应写回浏览器，再退出。
    setTimeout(() => process.exit(0), 250);
    return { ok: true, mode: 'respawn', restarted: true, log: payload.log };
  }

  function dispose() {
    const job = state.job;
    if (job?.state === 'running') {
      clearTimeout(job.timer);
      try { job.child?.kill(); } catch { /* 已经没了 */ }
    }
    state.job?.listeners.clear();
  }

  return { version, check, upgrade, restart, subscribe, jobView: () => jobView(state.job), dispose, profile, channel };
}

/* ------------------------------------------------------------------ *
 * HTTP 端点
 * ------------------------------------------------------------------ */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function reply(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) req.destroy();
    });
    req.on('end', () => {
      if (body === '') return resolve({});
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * 升级相关的路由表，挂在一个前缀下（和搜索 API 同一个前缀）。
 * 返回的处理器不认识这条路径时返回 false，交给调用方继续分发。
 *
 * @returns {(req: any, res: any, pathname: string) => Promise<boolean>}
 */
export function createUpdateRoutes(updater, { prefix = '/plugin-api/dsh-fast-search' } = {}) {
  return async function handle(req, res, pathname) {
    if (typeof pathname !== 'string' || !pathname.startsWith(prefix)) return false;
    let route = pathname.slice(prefix.length);
    if (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1);
    if (route === '') route = '/';

    if (route === '/ping' && req.method === 'GET') {
      reply(res, 200, { ok: true, version: updater.version(), package: PACKAGE_NAME });
      return true;
    }
    if (route === '/update' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://x');
      reply(res, 200, await updater.check({ force: url.searchParams.get('force') === '1' }));
      return true;
    }
    if (route === '/update/job' && req.method === 'GET') {
      reply(res, 200, { ok: true, ...updater.jobView() });
      return true;
    }
    if (route === '/update/upgrade' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await updater.upgrade({ version: typeof body?.version === 'string' ? body.version : undefined });
      /* 200 而不是 4xx/202：请求本身被理解了，装不装得上由 `ok` + `reason` 说，
       * 免得客户端把「已经是最新版」当成网络错误。 */
      reply(res, 200, result);
      return true;
    }
    if (route === '/update/restart' && req.method === 'POST') {
      const result = updater.restart();
      reply(res, result.ok ? 200 : 500, result);
      return true;
    }
    return false;
  };
}
