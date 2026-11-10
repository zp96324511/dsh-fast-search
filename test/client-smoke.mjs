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
  /* 语义索引：宿主已启用，处于空闲；面板的开关与进度都读这一段 */
  vectors: {
    enabled: true,
    model: 'bge-large',
    dim: 1024,
    chunks: 13219,
    docsCovered: 11890,
    docsTotal: 11890,
    progress: { phase: 'idle', chunks: 13219, chunksTotal: 13219, chars: 5610128, charsTotal: 5610128 },
  },
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
      lastTime: Date.now() - 7_000_000,
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
        {
          seq: 24,
          kind: 'assistant/message',
          role: 'assistant',
          time: Date.now() - 7_000_000,
          snippet: [{ text: '把向量落盘之后再合并', mark: false }],
          source: 'vec',
        },
      ],
    },
  ],
  semantic: { used: true, hits: 12, shown: 3, ms: 41, mode: 'auto', model: 'bge-large' },
};

/* 工作区下拉：真实接口按最近消息倒序返回 */
const FAKE_WORKSPACES = {
  workspaces: [
    { cwd: 'C:\\data\\projects\\dsh-context-control', sessions: 312, docs: 12_480, updatedAt: Date.now() - 60_000 },
    { cwd: 'C:\\data\\projects\\dsh-fast-search', sessions: 27, docs: 930, updatedAt: Date.now() - 3_600_000 },
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
    : path.includes('/workspaces')
      ? FAKE_WORKSPACES
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

/* 语义模式存在 localStorage 里；Node 26 有全局 localStorage 但需要 --localstorage-file，
 * 直接访问会抛。这里给它一个最小实现，既消掉实验性警告，也让「默认 auto」可被断言。 */
try {
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  });
} catch { /* 桩装不上就靠 client.js 自己的 try/catch 兜底 */ }

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
const registeredLocales = {};
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
    register(namespace, lang, dict) { registeredLocales[lang] = dict; },
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
assert.ok(registeredLocales.zh.hint.includes('&') && registeredLocales.zh.hint.includes('|'),
  '空态文案要提示 AND/OR 的符号写法');
assert.ok(registeredLocales.zh.emptySyntax.includes('A & B') && registeredLocales.zh.emptySyntax.includes('A | B'),
  '无结果文案要给出可照抄的语法样例');

/* ------------------------------------------------------------------ *
 * 渲染面板：有结果（按 Hook 顺序预置 state，跳过异步）
 * ------------------------------------------------------------------ */
/* SearchPanel 的 state 顺序：text, query, data, status, busy, error, active, update, upd, updError, sem,
 * 之后才是 workspace, range, workspaces（client-smoke 按槽位预置，顺序不能动） */
slotState = ['插件', '插件', FAKE_SEARCH, FAKE_STATUS, false, null, 0];
const withData = render(panel);
const rendered = collectText(withData);
assert.ok(rendered.includes('插件会话级按需开启功能开发'), '会话标题要渲染出来，实际：' + rendered.slice(0, 200));
assert.ok(rendered.includes('834'), '命中总数要渲染出来，实际：' + rendered.slice(0, 200));
assert.ok(rendered.includes('semanticUsed'), '语义补召之后要报出来，实际：' + rendered.slice(0, 300));
assert.ok(rendered.includes('semanticBadge'), '纯语义命中的条目要带来源徽标，实际：' + rendered.slice(0, 300));
assert.ok(rendered.includes('semanticAutoChoice'), '默认语义模式是「自动」，实际：' + rendered.slice(0, 300));
assert.ok(rendered.includes('workspaceLabel'), '筛选行要有工作区标签，实际：' + rendered.slice(0, 300));
assert.ok(rendered.includes('rangeDay') && rendered.includes('rangeWeek') && rendered.includes('rangeMonth'),
  '时间要提供 1 天 / 1 周 / 1 月 快捷档，实际：' + rendered.slice(0, 300));

const selects = [];
for (const node of walk(withData)) if (node.type === 'select') selects.push(node);
assert.equal(selects.length, 2, '工作区与语义各一个下拉');
const workspaceSelect = selects.find((node) => node.props['aria-label'] === 'workspaceLabel');
const semSelect = selects.find((node) => node.props['aria-label'] === 'semanticLabel');
assert.ok(workspaceSelect && semSelect, '两个下拉都要有可访问名称');
assert.equal(workspaceSelect.props.value, '', '默认是「全部工作区」');
assert.equal(workspaceSelect.children.filter((child) => child?.type === 'option').length, 1,
  '/workspaces 还没回来时只显示「全部」');
assert.equal(semSelect.props.value, 'auto', '语义默认是「自动」');
assert.equal(semSelect.props.disabled, false, '宿主启用向量时下拉可操作');
assert.equal(semSelect.children.filter((child) => child?.type === 'option').length, 3,
  '语义下拉要有 关 / 自动 / 开 三档');

/* 控件行必须在搜索框上方：过滤组件与语义下拉统一前置 */
const panelChildren = withData.children;
const controlsIndex = panelChildren.findIndex((node) => node?.props?.['data-role'] === 'controls');
const searchIndex = panelChildren.findIndex((node) => node?.props?.['data-role'] === 'search');
assert.ok(controlsIndex >= 0 && searchIndex >= 0 && controlsIndex < searchIndex,
  '筛选与语义控件应位于搜索框上方');

/* 搜索框后面要真的有搜索按钮；输入本身不再触发检索 */
const searchRow = panelChildren[searchIndex];
assert.equal(searchRow.children[1].type, 'button', '搜索框后面要有按钮');
assert.ok(collectText(searchRow).includes('search'), '搜索按钮要有文案，实际：' + collectText(searchRow));
assert.equal(searchRow.children[1].props.disabled, false, '有输入内容时搜索按钮可点');

/* 输入只更新草稿：改词后等过旧的 160ms 防抖窗口，也不该自己发 /search */
const searchInput = searchRow.children[0];
const searchCalls = () => requests.filter((request) => request.url.includes('/search')).length;
const beforeTyping = searchCalls();
searchInput.props.onChange({ target: { value: '新词' } });
await new Promise((resolve) => setTimeout(resolve, 220));
assert.equal(searchCalls(), beforeTyping, '输入过程中不应自动触发搜索');
searchInput.props.onChange({ target: { value: '' } }); /* 复位草稿，避免影响后续渲染 */

/* 只输入、未检索：空态提示下一步动作，而不是误报「没有找到」 */
slotState = ['新词', '', null, FAKE_STATUS, false, null, 0];
const typedTree = render(panel);
const typedText = collectText(typedTree);
assert.ok(typedText.includes('pressSearch'), '只输入未检索时应提示按 Enter/搜索，实际：' + typedText.slice(0, 200));
assert.ok(!typedText.includes('emptyFor'), '未检索时不应报「没有找到」');

/* 词改过再按 Enter：先检索新词，不能打开旧结果的第一条 */
slotState = ['新词', '插件', FAKE_SEARCH, FAKE_STATUS, false, null, 0];
const dirtyTree = render(panel);
const dirtyRow = dirtyTree.children.find((node) => node?.props?.['data-role'] === 'search');
dirtyRow.children[0].props.onKeyDown({ key: 'Enter', preventDefault() {} });
await new Promise((resolve) => setTimeout(resolve, 20));
const dirtyRequest = [...requests].reverse().find((request) => request.url.includes('/search'));
assert.ok(dirtyRequest, '回车应发出搜索请求');
assert.equal(JSON.parse(dirtyRequest.body).q, '新词', '回车应检索输入框里的新词');
dirtyRow.children[0].props.onChange({ target: { value: '' } }); /* 复位 memory.text */

/* 自定义时间段：两个原生日期框，选完立即生效 */
const dateInputs = [...walk(withData)].filter((node) => node.type === 'input' && node.props.type === 'date');
assert.equal(dateInputs.length, 2, '开始/结束各一个日期框');
assert.equal(dateInputs[0].props.value, '', '未选择时开始日期为空');
assert.equal(dateInputs[1].props.value, '', '未选择时结束日期为空');

/* 选中工作区 + 近 1 周：筛选项要回显，且 select 保留选中值 */
slotState = [
  '插件', '插件', FAKE_SEARCH, FAKE_STATUS, false, null, 0,
  null, 'idle', null, 'auto',
  'C:\\data\\projects\\dsh-context-control', '1w', FAKE_WORKSPACES.workspaces,
];
const filteredTree = render(panel);
const filteredText = collectText(filteredTree);
assert.ok(filteredText.includes('filterNote'), '要回显当前筛选，实际：' + filteredText.slice(0, 400));
assert.ok(filteredText.includes('filterWorkspace'), '回显里要有工作区，实际：' + filteredText.slice(0, 400));
assert.ok(filteredText.includes('filterRange'), '回显里要有时间窗，实际：' + filteredText.slice(0, 400));
const filteredSelect = [...walk(filteredTree)].find((node) => node.type === 'select' && node.props['aria-label'] === 'workspaceLabel');
assert.equal(filteredSelect.props.value, 'C:\\data\\projects\\dsh-context-control');
assert.equal(filteredSelect.children.filter((child) => child?.type === 'option').length, 3,
  '两个工作区 + 「全部」');

/* 宿主没配向量服务时：下拉禁用并显示「关」，不假装可切换 */
slotState = ['', '', null, { ...FAKE_STATUS, vectors: { enabled: false } }, false, null, 0];
const noVecTree = render(panel);
const noVecText = collectText(noVecTree);
assert.ok(noVecText.includes('semanticOffChoice'), '没有向量服务时下拉应显示「关」，实际：' + noVecText.slice(0, 300));
const noVecSem = [...walk(noVecTree)].find((node) => node.type === 'select' && node.props['aria-label'] === 'semanticLabel');
assert.equal(noVecSem.props.disabled, true, '没有向量服务时语义下拉要禁用');
assert.equal(noVecSem.props.value, 'off', '没有向量服务时语义值归一为「关」');

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

/* 全文对账进行中：按钮要禁用并显示进度，而不是看起来毫无反应 */
slotState = ['插件', '插件', FAKE_SEARCH, {
  ...FAKE_STATUS,
  index: { phase: 'indexing', done: 10, total: 148 },
}, false, null, 0];
const indexingTree = render(panel);
const indexingText = collectText(indexingTree);
assert.ok(indexingText.includes('indexing'), '要显示对账进度，实际：' + indexingText.slice(0, 300));
const reindexButtons = [];
for (const node of walk(indexingTree)) {
  if (node.type === 'button' && String(node.children.join('')) === 'reindexing') reindexButtons.push(node);
}
assert.equal(reindexButtons.length, 1, '对账期间按钮文案要变成「重建中…」');
assert.equal(reindexButtons[0].props.disabled, true, '对账期间按钮要禁用');
const statusRow = [...walk(indexingTree)].find((node) => node?.props?.['data-role'] === 'status');
assert.ok(statusRow, '要有独立的状态行');
assert.equal(statusRow.children[0].type, 'span', '状态提示在前');
assert.equal(statusRow.children[1], reindexButtons[0], '重建按钮紧跟在状态提示之后');
assert.equal(statusRow.children[2].type, 'button', '版本号排在重建按钮后面');
assert.ok(String(statusRow.children[2].children.join('')).startsWith('v'), '版本号仍是版本号入口');
assert.notEqual(statusRow.children[0].props.style.flex, '1 1 auto',
  '状态文字不能把重建按钮推到最右边');

/* 自定义时间段：状态回显绝对日期，日期框保留选中的值 */
slotState = [
  '插件', '插件', null, FAKE_STATUS, false, null, 0,
  null, 'idle', null, 'auto',
  '', 'custom', FAKE_WORKSPACES.workspaces, '2026-01-01', '2026-01-31',
];
const customTree = render(panel);
const customText = collectText(customTree);
assert.ok(customText.includes('filterCustom'), '要回显自定义时间，实际：' + customText.slice(0, 400));
assert.ok(customText.includes('2026-01-01') && customText.includes('2026-01-31'),
  '回显要带绝对日期，实际：' + customText.slice(0, 400));
const customDates = [...walk(customTree)].filter((node) => node.type === 'input' && node.props.type === 'date');
assert.deepEqual(customDates.map((node) => node.props.value), ['2026-01-01', '2026-01-31'],
  '日期框要保留选中的起止日期');

/* 深色主题：原生下拉/日期框要声明 dark，option 也要有深底浅字，不能只靠透明背景 */
const originalComputedStyle = globalThis.getComputedStyle;
globalThis.getComputedStyle = () => ({ colorScheme: 'dark', color: 'rgb(230, 230, 230)' });
const darkTree = render(panel);
globalThis.getComputedStyle = originalComputedStyle;
const darkSelects = [...walk(darkTree)].filter((node) => node.type === 'select');
assert.ok(darkSelects.length === 2 && darkSelects.every((node) => node.props.style.colorScheme === 'dark'),
  '深色主题下下拉要显式 color-scheme: dark');
const darkOptions = [...walk(darkTree)].filter((node) => node.type === 'option');
assert.ok(darkOptions.length >= 4 && darkOptions.every((node) => node.props.style.backgroundColor === '#1f1f1f'),
  '深色主题下 option 要有深色底，避免白底白字');

/* 日期变化后点搜索：请求必须带毫秒 since/until，而不是原样发 range:"custom" */
customDates[0].props.onChange({ target: { value: '2025-12-01' } });
const customSearchBtn = [...walk(customTree)].find((node) => node.type === 'button' && String(node.children.join('')) === 'search');
assert.ok(customSearchBtn, '自定义日期状态也要有搜索按钮');
customSearchBtn.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
const dateRequest = [...requests].reverse().find((request) => request.url.includes('/search'));
assert.ok(dateRequest?.body, '日期变化后要发出搜索请求');
const dateBody = JSON.parse(dateRequest.body);
assert.equal(dateBody.since, new Date(2025, 11, 1, 0, 0, 0, 0).getTime(), '开始日期按本地零点换算');
assert.equal(dateBody.until, new Date(2026, 0, 31, 23, 59, 59, 999).getTime(), '结束日期按本地日终换算');
assert.equal(dateBody.range, undefined, '自定义区间不再发 range 快捷值');

/* 升级完成、等重启：只提示，不提供任何宿主重启入口 */
slotState = ['', '', null, FAKE_STATUS, false, null, 0, { ...FAKE_UPDATE, hasUpdate: false }, 'upgraded', null];
const doneTree = render(panel);
const doneText = collectText(doneTree);
assert.ok(doneText.includes('updated'), '升级完要说清「需要重启」，实际：' + doneText.slice(0, 200));
assert.ok(![...walk(doneTree)].some((node) => node.type === 'button' && String(node.children.join('')) === 'restart'),
  '升级后不该再给重启按钮');

/* 磁盘已换、宿主还没重启：讲清版本差异并提示手动重启，但不由插件操作宿主 */
slotState = ['', '', null, FAKE_STATUS, false, null, 0, {
  ...FAKE_UPDATE,
  current: '0.4.0',
  loaded: '0.3.0',
  latest: '0.2.1',
  hasUpdate: false,
  restartRequired: true,
  stale: true,
}, 'stale', null];
const staleTree = render(panel);
const staleText = collectText(staleTree);
assert.ok(staleText.includes('0.4.0') && staleText.includes('0.3.0'), '要讲清磁盘版本与运行版本，实际：' + staleText.slice(0, 240));
assert.ok(staleText.includes('restartNeeded'), '要提示需要手动重启');
assert.ok(![...walk(staleTree)].some((node) => node.type === 'button' && String(node.children.join('')) === 'restart'),
  'stale 状态也不该给重启按钮');

console.log('client.js 冒烟通过：槽注册 2 个、图标尺寸、空态语法提示、控件前置、搜索按钮、输入不自动搜索、回车检索新词、日期区间、语义下拉、结果树与高亮结构、升级提示');

console.log('请求记录：', requests.map((r) => `${r.method} ${r.url}`));
