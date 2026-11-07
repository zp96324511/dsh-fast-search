/**
 * 交互验证：点结果 → 是否真的跳进那个会话；再验证键盘与空查询。
 * 用法：node bench/cdp-click.mjs [port]
 */
const PORT = Number(process.argv[2] ?? 9222);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /10550|10551|dsh/.test(t.url ?? ''));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const errors = [];

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
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails?.exception?.description ?? 'exception');
  }
});

const send = (method, params = {}) => new Promise((resolve) => {
  const next = ++id;
  pending.set(next, resolve);
  ws.send(JSON.stringify({ id: next, method, params }));
});

const evaluate = async (expression) => {
  const msg = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? 'failed');
  return msg.result?.result?.value;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
await send('Runtime.enable');

/* 打开面板并搜一次 */
await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="button"], span')];
  const hit = nodes.find((n) => ((n.getAttribute('aria-label') ?? '') + (n.getAttribute('title') ?? '')).includes('全文搜索'))
    ?? nodes.find((n) => n.textContent.trim() === '🔍');
  (hit?.closest('button, [role="button"]') ?? hit)?.click();
  return 'ok';
})()`);
await sleep(800);

await evaluate(`(() => {
  const input = document.querySelector('input[placeholder*="搜索所有会话"]');
  if (!input) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '调音台');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
await sleep(2000);

const before = await evaluate(`JSON.stringify({
  url: location.href,
  groups: document.querySelectorAll('div[role="button"]').length,
  firstTitle: (document.querySelector('div[role="button"] span')?.textContent ?? '').slice(0, 40),
})`);
console.log('点击前:', before);

/* 点第一个会话分组头 */
const clicked = await evaluate(`(() => {
  const heads = [...document.querySelectorAll('div[role="button"]')].filter((n) => n.textContent.includes('·'));
  const head = heads[0];
  if (!head) return 'no-head';
  head.click();
  return 'clicked:' + head.textContent.slice(0, 30);
})()`);
console.log('点击:', clicked);
await sleep(2000);

const after = await evaluate(`JSON.stringify({
  url: location.href,
  panelVisible: Boolean(document.querySelector('input[placeholder*="搜索所有会话"]')),
  bodyHead: document.body.innerText.slice(0, 120).replace(/\\n+/g, ' | '),
})`);
console.log('点击后:', after);
console.log('异常:', errors.length === 0 ? '无' : errors.slice(0, 5));

/* 再打开面板：上一次的查询与结果应当恢复 */
await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('button, [role="button"], span')];
  const hit = nodes.find((n) => ((n.getAttribute('aria-label') ?? '') + (n.getAttribute('title') ?? '')).includes('全文搜索'));
  (hit?.closest('button, [role="button"]') ?? hit)?.click();
  return 'ok';
})()`);
await sleep(1500);

const restored = await evaluate(`JSON.stringify({
  inputValue: document.querySelector('input[placeholder*="搜索所有会话"]')?.value ?? null,
  stat: [...document.querySelectorAll('div')].map((n) => n.firstChild?.textContent ?? '').find((s) => s.includes('条命中')) ?? null,
  marks: document.querySelectorAll('mark').length,
})`);
console.log('重新打开:', restored);
ws.close();
