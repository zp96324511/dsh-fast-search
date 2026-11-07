/**
 * 通用截图：裁一块并放大，用来看 UI 细节。
 *
 *   node bench/cdp-shot.mjs [port] [x,y,w,h] [scale] [out.png]
 * 坐标默认取左栏（侧栏 280×420）。
 */
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] ?? 9222);
const rect = (process.argv[3] ?? '0,0,280,420').split(',').map(Number);
const scale = Number(process.argv[4] ?? 2);
const out = process.argv[5] ?? '.tmp/shot.png';

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
  if (resolve) { pending.delete(msg.id); resolve(msg); }
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

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: rect[0], y: rect[1], width: rect[2], height: rect[3], scale },
});
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log(`${rect.join(',')} @${scale}× → ${out}`);
ws.close();
