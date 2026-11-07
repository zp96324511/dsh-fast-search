/**
 * 看一眼侧栏里官方图标长什么样（viewBox / stroke-width / fill），
 * 让自定义图标跟 shell 的线条风格对齐。
 *
 *   node bench/cdp-icon.mjs [port]
 */
const PORT = Number(process.argv[2] ?? 9222);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /10550|10551/.test(t.url ?? ''));
if (!page) throw new Error('找不到 GUI 标签页，先确认 Chrome 开着');

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

const dump = await evaluate(`(() => {
  const out = [];
  for (const svg of document.querySelectorAll('svg')) {
    const box = svg.getBoundingClientRect();
    if (box.width === 0) continue;
    const path = svg.querySelector('path');
    out.push({
      w: Math.round(box.width),
      viewBox: svg.getAttribute('viewBox'),
      strokeWidth: svg.getAttribute('stroke-width') ?? path?.getAttribute('stroke-width') ?? null,
      stroke: svg.getAttribute('stroke') ?? path?.getAttribute('stroke') ?? null,
      fill: svg.getAttribute('fill') ?? path?.getAttribute('fill') ?? null,
      linecap: svg.getAttribute('stroke-linecap') ?? path?.getAttribute('stroke-linecap') ?? null,
      d: (path?.getAttribute('d') ?? '').slice(0, 90),
    });
    if (out.length >= 8) break;
  }
  return JSON.stringify(out, null, 1);
})()`);
console.log(dump);
ws.close();
