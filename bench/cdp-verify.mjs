/**
 * 端到端验证：用 CDP 驱动真实 GUI 标签页，确认
 * ① 插件 bundle 被加载、② 侧栏图标出现、③ 点开后能搜出结果、④ 没有控制台报错。
 *
 * 用法：node bench/cdp-verify.mjs [port] [query]
 */
const PORT = Number(process.argv[2] ?? 9222);
const QUERY = process.argv[3] ?? '插件';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /10550|10551|dsh/.test(t.url ?? ''));
if (!page) {
  console.error('没有可用的 GUI 标签页');
  process.exit(1);
}
console.log('tab:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined) {
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    logs.push(`[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + (msg.params.exceptionDetails?.exception?.description ?? 'unknown'));
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    logs.push('[log] ' + msg.params.entry.text);
  }
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const next = ++id;
  pending.set(next, resolve);
  ws.send(JSON.stringify({ id: next, method, params }));
});

const evaluate = async (expression) => {
  const msg = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (msg.result?.exceptionDetails) {
    throw new Error(msg.result.exceptionDetails.exception?.description ?? 'evaluate failed');
  }
  return msg.result?.result?.value;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });

/* 等页面主 bundle 起来（loader 就绪 + 插件工厂注册完） */
let booted = false;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try {
    booted = await evaluate(`Boolean(globalThis.__DSH_BOOT_READY__)`);
    if (booted) break;
  } catch { /* 导航期间 evaluate 会短暂失败 */ }
}
console.log('boot ready:', booted);
await sleep(2500);

const bundles = await evaluate(`JSON.stringify(
  performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => name.includes('fast-search'))
)`);
console.log('bundle 资源:', bundles);

const roster = await evaluate(`(() => {
  try {
    const raw = JSON.stringify(globalThis.__DSH_BOOT__ ?? {});
    return raw.includes('fast-search');
  } catch { return 'probe-failed'; }
})()`);
console.log('boot roster 含 fast-search:', roster);

const apiOk = await evaluate(`(async () => {
  try {
    const response = await fetch('/plugin-api/dsh-fast-search/status');
    const body = await response.json();
    return JSON.stringify({ status: response.status, docs: body.docs, sessions: body.sessions });
  } catch (error) { return 'ERR ' + error.message; }
})()`);
console.log('页面内 API:', apiOk);

/* 找侧栏图标并点开面板 */
const clicked = await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, a, [role="button"], span')];
  const hit = nodes.find((node) => {
    const label = (node.getAttribute('aria-label') ?? '') + ' ' + (node.getAttribute('title') ?? '');
    return label.includes('全文搜索') || label.includes('Full-text search');
  }) ?? nodes.find((node) => node.textContent.trim() === '🔍' && node.children.length === 0);
  if (!hit) return 'not-found';
  const target = hit.closest('button, a, [role="button"]') ?? hit;
  target.click();
  return 'clicked:' + target.tagName;
})()`);
console.log('侧栏图标:', clicked);
await sleep(1200);

const panelReady = await evaluate(`(() => {
  const input = document.querySelector('input[placeholder*="搜索所有会话"], input[placeholder*="Search every session"]');
  return input ? 'yes' : 'no';
})()`);
console.log('搜索面板出现:', panelReady);

if (panelReady === 'yes') {
  await evaluate(`(() => {
    const input = document.querySelector('input[placeholder*="搜索所有会话"], input[placeholder*="Search every session"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(QUERY)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  await sleep(2500);
  const results = await evaluate(`(() => {
    const marks = [...document.querySelectorAll('mark')].map((node) => node.textContent);
    const groups = document.querySelectorAll('button[title]').length;
    const text = document.body.innerText;
    const stat = (text.match(/\\d+\\s*条命中[^\\n]*/) ?? [''])[0];
    return JSON.stringify({ marks: marks.slice(0, 6), markCount: marks.length, hitButtons: groups, stat });
  })()`);
  console.log('搜索结果:', results);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile('.tmp/panel.png', Buffer.from(shot.result.data, 'base64'));
    console.log('截图: .tmp/panel.png');
  }
}

console.log('控制台异常:', logs.length === 0 ? '无' : logs.slice(0, 10));
ws.close();
