/**
 * 放大看侧栏图标：刷新页面 → 找到「全文搜索」那一行 → 裁一块 4× 截图。
 *
 *   node bench/cdp-icon-shot.mjs [port] [out.png]
 */
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] ?? 9222);
const OUT = process.argv[3] ?? '.tmp/icon.png';
const SCALE = 4;

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /10550|10551/.test(t.url ?? ''));
if (!page) throw new Error('找不到 GUI 标签页');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id === undefined) return;
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const send = (method, params = {}) => new Promise((resolve) => {
  const next = ++id;
  pending.set(next, resolve);
  ws.send(JSON.stringify({ id: next, method, params }));
});
const evaluate = async (expression) => {
  const msg = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? 'failed');
  return msg.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(6000);

/* 刷新后插件要等 bundle 加载完才注册槽，轮询等它出现 */
let box = null;
for (let i = 0; i < 20 && box === null; i++) {
  const raw = await evaluate(`(() => {
    const node = [...document.querySelectorAll('button, [role="button"], a')]
      .find((n) => n.textContent.trim() === '全文搜索' && n.querySelector('svg'));
    if (!node) return 'null';
    const r = node.getBoundingClientRect();
    if (r.width === 0) return 'null';
    return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
  })()`);
  box = JSON.parse(raw);
  if (box === null) await sleep(500);
}
if (box === null) throw new Error('侧栏里没有「全文搜索」条目，插件没加载？');

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: Math.max(0, box.x - 4), y: Math.max(0, box.y - 4), width: box.width + 8, height: box.height + 8, scale: SCALE },
});
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log(`图标区域 ${JSON.stringify(box)} → ${OUT}（${SCALE}×）`);
ws.close();
