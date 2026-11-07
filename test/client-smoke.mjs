/**
 * client.js 冒烟测试：不装宿主、不开浏览器，用最小 React 桩跑一遍
 * 「工厂 → apply → 注册槽 → 渲染面板」，把结构性错误挡在重启宿主之前。
 *
 * 桩必须诚实：只实现 client.js 真正用到的那几个 Hook，
 * useState 走固定槽位（重渲染时按同样顺序取值），effect 立即执行但忽略清理函数。
 */
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * React / react-dom 桩
 * ------------------------------------------------------------------ */
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat() };
}

let slotState = [];
let slotIndex = 0;
const effects = [];

const React = {
  createElement,
  useState(initial) {
    const i = slotIndex;
    slotIndex += 1;
    if (slotState[i] === undefined) slotState[i] = typeof initial === 'function' ? initial() : initial;
    const set = (next) => {
      slotState[i] = typeof next === 'function' ? next(slotState[i]) : next;
    };
    return [slotState[i], set];
  },
  useEffect(fn) {
    effects.push(fn);
    return undefined;
  },
  useMemo(fn) {
    return fn();
  },
  useCallback(fn) {
    return fn;
  },
  useRef(initial) {
    return { current: initial };
  },
};

/* ------------------------------------------------------------------ *
 * 浏览器环境桩
 * ------------------------------------------------------------------ */
const requests = [];
const FAKE_STATUS = {
  version: '0.1.0',
  sessionsDir: 'C:\\Users\\win10\\.dsh\\sessions',
  docs: 49163,
  sessions: 5408,
  files: 5408,
  dbBytes: 96935936,
  index: { phase: 'idle', done: 5408, total: 5408 },
};
const FAKE_SEARCH = {
  q: '插件',
  match: '"插 件"',
  took: 6.4,
  total: 834,
  truncated: true,
  groups: [
    {
      sessionId: 'session-abc',
      title: '插件会话级按需开启功能开发',
      cwd: 'C:\\data\\projects\\dsh-context-control',
      createdAt: Date.now() - 3_600_000,
      docs: [
        {
          seq: 16,
          kind: 'user/message',
          role: 'user',
          time: Date.now() - 7_200_000,
          snippet: [
            { text: '当前新会话是默认加载所有已开启', mark: false },
            { text: '插件', mark: true },
            { text: '的，可以按需开启', mark: false },
          ],
        },
        {
          seq: 20,
          kind: 'tool/result',
          role: 'tool',
          time: Date.now() - 7_100_000,
          snippet: [{ text: 'mcp server plugin ready', mark: false }],
        },
      ],
    },
  ],
};

/* 升级通道的假回答：面板每次挂载都会静默问一次，桩必须答得出来 */
const FAKE_UPDATE = {
  ok: true,
  current: '0.1.0',
  loaded: '0.1.0',
  latest: '0.2.0',
  hasUpdate: true,
  canUpgrade: true,
  channel: { kind: 'github', origin: 'spec', repo: 'zp96324511/dsh-fast-search' },
  installSpec: 'https://github.com/zp96324511/dsh-fast-search/releases/download/v0.2.0/dsh-fast-search.tgz',
  upgradeMemory: undefined,
  upgrading: false,
  checkedAt: Date.now(),
};

globalThis.fetch = async (url, init = {}) => {
  requests.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
  const path = String(url);
  const payload = path.includes('/search')
    ? FAKE_SEARCH
    : path.includes('/update')
      ? FAKE_UPDATE
      : path.includes('/ping')
        ? { ok: true }
        : FAKE_STATUS;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(payload),
  };
};
globalThis.document = { baseURI: 'http://127.0.0.1/study-win10/' };

let loadedSpec;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loadedSpec = spec;
    },
  },
};

/* ------------------------------------------------------------------ *
 * 加载插件
 * ------------------------------------------------------------------ */
await import('../client.js');
assert.ok(loadedSpec, 'client.js 没有调用 __ModuleLoader__.load');
assert.equal(loadedSpec.id, 'dsh-fast-search');

const plugin = loadedSpec.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});
assert.ok(Array.isArray(plugin.inject), 'inject 必须是数组');

/* ------------------------------------------------------------------ *
 * apply：槽注册
 * ------------------------------------------------------------------ */
const registered = new Map();
const ctx = {
  slots: {
    inject(name, fn) {
      return fn();
    },
    register(spec, component) {
      registered.set(`${spec.name}:${spec.id ?? spec.key}`, { spec, component });
      return () => registered.delete(`${spec.name}:${spec.id ?? spec.key}`);
    },
  },
  locale: {
    register() {},
    /* 桩里把变量也吐出来，断言才能看到真实的计数 */
    bind: () => (key, vars) => (vars === undefined ? key : `${key}${JSON.stringify(vars)}`),
  },
  get() {
    return undefined;
  },
  effect(fn) {
    fn();
    return () => {};
  },
};

await plugin.apply(ctx);
assert.deepEqual([...registered.keys()].sort(), ['main:fast-search', 'sidebar.panellist:fast-search']);

const icon = registered.get('sidebar.panellist:fast-search').component;
const iconTree = icon({ size: 18 });
assert.equal(iconTree.type, 'svg', '侧栏图标要是 svg 线条图，不是 emoji');
assert.equal(iconTree.props.width, 18, '图标要跟随 size');
assert.equal(iconTree.props.viewBox, '0 0 16 16', '与 shell 图标同一套坐标系');
assert.equal(iconTree.props.stroke, 'currentColor', '图标要继承文字颜色');
assert.equal(iconTree.props.strokeWidth, 1, '线条宽度对齐 shell（1px @16）');
assert.equal(iconTree.props.fill, 'none', '纯线条，不填充');
assert.equal(iconTree.children.length, 3, '图标要有镜片、把手和镜内横线三个图形片段');
assert.deepEqual(iconTree.children.map((c) => c.type), ['circle', 'path', 'path']);

/* ------------------------------------------------------------------ *
 * 渲染面板：空态
 * ------------------------------------------------------------------ */
const panel = registered.get('main:fast-search').component;

function render(component, props = {}) {
  slotIndex = 0;
  const tree = component(props);
  /* 跑一遍 effect（首次挂载语义），异常直接冒出来 */
  for (const fn of effects.splice(0)) {
    const cleanup = fn();
    if (typeof cleanup === 'function') cleanup();
  }
  return tree;
}

function* walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  yield node;
  if (node.children) yield* walk(node.children);
}

const collectText = (tree) => {
  const out = [];
  for (const node of walk(tree)) {
    for (const child of node.children ?? []) {
      if (typeof child === 'string' || typeof child === 'number') out.push(String(child));
    }
  }
  return out.join(' ');
};

const emptyTree = render(panel);
assert.equal(emptyTree.type, 'div');
assert.ok(!collectText(emptyTree).includes('条命中'), '空态不该出现结果统计');

/* ------------------------------------------------------------------ *
 * 渲染面板：有结果（按 Hook 顺序预置 state，跳过异步）
 * ------------------------------------------------------------------ */
/* SearchPanel 的 state 顺序：text, query, data, status, busy, error, active, update, upd, updError */
slotState = ['插件', '插件', FAKE_SEARCH, FAKE_STATUS, false, null, 0];
const withData = render(panel);
const rendered = collectText(withData);
assert.ok(rendered.includes('插件会话级按需开启功能开发'), '会话标题要渲染出来，实际：' + rendered.slice(0, 200));
assert.ok(rendered.includes('834'), '命中总数要渲染出来，实际：' + rendered.slice(0, 200));

/* 挂载即静默查一次更新：请求要真的发出去 */
await new Promise((resolve) => setTimeout(resolve, 20));
assert.ok(requests.some((r) => r.url.endsWith('/update')), '面板挂载后应检查更新，实际：' + requests.map((r) => r.url).join(', '));

/* 命中片段必须带上 mark 结构，而不是 HTML 字符串 */
const marks = [];
for (const node of walk(withData)) {
  if (node.type === 'mark') marks.push(node.children.join(''));
}
assert.deepEqual(marks, ['插件'], 'mark 节点应由 segments 生成');

/* ------------------------------------------------------------------ *
 * 渲染面板：有更新
 * ------------------------------------------------------------------ */
slotState = ['', '', null, FAKE_STATUS, false, null, 0, FAKE_UPDATE, 'available', null];
const updTree = render(panel);
const updText = collectText(updTree);
assert.ok(updText.includes('updateAvailable'), '有新版本时要讲出来，实际：' + updText.slice(0, 200));
assert.ok(updText.includes('updateNow'), '要给出升级入口');

const chips = [];
for (const node of walk(updTree)) {
  if (node.type === 'button' && String(node.children.join('')).startsWith('↑')) chips.push(node.children.join(''));
}
assert.deepEqual(chips, ['↑ v0.2.0'], '版本号本身要变成可升级的入口');

/* 升级完成、等重启：提示条要换成重启入口，而不是继续喊「有新版本」 */
slotState = ['', '', null, FAKE_STATUS, false, null, 0, { ...FAKE_UPDATE, hasUpdate: false }, 'upgraded', null];
const doneText = collectText(render(panel));
assert.ok(doneText.includes('updated'), '升级完要说清「需要重启」，实际：' + doneText.slice(0, 200));
assert.ok(doneText.includes('restart'), '要给出重启按钮');

console.log('client.js 冒烟通过：槽注册 2 个、图标尺寸、空态、结果树与高亮结构、升级提示');

console.log('请求记录：', requests.map((r) => `${r.method} ${r.url}`));
