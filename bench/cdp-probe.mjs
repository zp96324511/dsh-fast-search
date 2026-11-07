/**
 * 用 CDP 打开一个已登录的 GUI 标签页，读出它加载过的脚本 URL，
 * 用来确认插件 bundle 的真实路径前缀（源码里没找到，实测最快）。
 */
const PORT = Number(process.argv[2] ?? 9222);
const MATCH = process.argv[3] ?? '';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /dsh|10550|10551/.test(t.url ?? ''));
if (!page) {
  console.error('没有可用的 GUI 标签页');
  process.exit(1);
}
console.log('tab:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg);
  }
});

const send = (method, params = {}) => new Promise((resolve) => {
  const next = ++id;
  pending.set(next, resolve);
  ws.send(JSON.stringify({ id: next, method, params }));
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const expression = `JSON.stringify(performance.getEntriesByType('resource')
  .map((entry) => entry.name)
  .filter((name) => name.includes('.js') && name.includes(${JSON.stringify(MATCH)})))`;
const result = await send('Runtime.evaluate', { expression, returnByValue: true });
const names = JSON.parse(result.result?.result?.value ?? '[]');
console.log(`共 ${names.length} 条脚本资源`);
for (const name of names.slice(0, 40)) console.log(' -', name);
ws.close();
