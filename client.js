/**
 * dsh-fast-search — 浏览器半边。
 *
 * 一个独立的全屏搜索面板（`main` 槽，key = `fast-search`）+ 侧栏放大镜图标。
 * 输入即搜，结果按会话分组，点击任意一条跳进该会话。
 *
 * 为什么这样写（都已实测确认）：
 * - 浏览器 bundle 由 dsh-client-modules 发在 `/plugins/<entryId>/client.js`，
 *   所以宿主的 API 前缀不能选 `/plugins/` 下的路径（最长前缀会把 client.js 抢走）。
 *   这里用 `/plugin-api/dsh-fast-search`。
 * - 宿主可能挂在子路径下（本机就是 `https://dsh.zpzp.xyz/study-win10/`），
 *   根绝对路径是否可用取决于反向代理。所以启动时按候选前缀逐个探测 `/status`，
 *   记住能用的那个，之后所有请求复用它。
 * - 检索结果里的 `segments` 是「文本片段 + 是否命中」的结构，不是 HTML——
 *   高亮由 React 渲染，永远不会把日志正文当标记注入。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fast-search',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const PREFIX = '[dsh-fast-search]';
    const PANEL_ID = 'fast-search';
    const API_ROOT = '/plugin-api/dsh-fast-search';
    const DEBOUNCE_MS = 160;

    function log(...args) {
      try {
        console.warn(PREFIX, ...args);
      } catch { /* 日志绝不能弄坏界面 */ }
    }

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */
    const DICT = {
      zh: {
        title: '全文搜索',
        placeholder: '搜索所有会话的正文…',
        hint: '输入关键词，回车立即搜索。中文按字分词，可直接搜「插件」这样的双字词。',
        empty: '没有找到匹配的会话',
        emptyFor: '没有找到匹配「{q}」的会话',
        emptyHint: '试试更短的词，或去掉引号与符号。',
        searching: '搜索中…',
        results: '{total} 条命中 · {groups} 个会话 · {ms}ms',
        docsCount: '{n} 条',
        indexing: '正在建索引 {done}/{total}',
        indexingDocs: '{docs} 条消息',
        reindex: '重建索引',
        reindexing: '重建中…',
        reindexQueued: '已开始重建，进度见下方',
        failed: '搜索失败：{error}',
        unreachable: '无法连接宿主插件，检查 dsh-fast-search 是否已加载',
        untitled: '（未命名会话）',
        openHint: '回车打开第一条',
        loadMore: '显示更多',
        kindUser: '用户',
        kindAssistant: '助手',
        kindTool: '工具',
        kindResult: '结果',
        kindSystem: '系统',
        kindOther: '记录',
        version: 'v{v}',
        checking: '检查更新…',
        updateAvailable: '有新版本 v{latest}',
        updateNow: '升级',
        updating: '升级中…',
        updated: '已升级到 v{latest}，重启后生效',
        restarting: '重启中…',
        restart: '重启宿主',
        updateLocal: '本地安装，不提供在线升级',
        updateFailed: '升级失败：{error}',
        updateCheckFailed: '检查更新失败：{error}',
        updateUpToDate: '已是最新版本',
      },
      en: {
        title: 'Full-text search',
        placeholder: 'Search every session…',
        hint: 'Type keywords, press Enter to search now. CJK is indexed per character.',
        empty: 'No matching session',
        emptyFor: 'No session matches “{q}”',
        emptyHint: 'Try a shorter term, or drop quotes and punctuation.',
        searching: 'Searching…',
        results: '{total} hits · {groups} sessions · {ms}ms',
        docsCount: '{n} items',
        indexing: 'Indexing {done}/{total}',
        indexingDocs: '{docs} messages',
        reindex: 'Rebuild index',
        reindexing: 'Rebuilding…',
        reindexQueued: 'Rebuild started',
        failed: 'Search failed: {error}',
        unreachable: 'Host plugin unreachable — is dsh-fast-search loaded?',
        untitled: '(untitled session)',
        openHint: 'Enter opens the first hit',
        loadMore: 'Show more',
        kindUser: 'User',
        kindAssistant: 'Assistant',
        kindTool: 'Tool',
        kindResult: 'Result',
        kindSystem: 'System',
        kindOther: 'Event',
        version: 'v{v}',
        checking: 'Checking for updates…',
        updateAvailable: 'Version {latest} available',
        updateNow: 'Upgrade',
        updating: 'Upgrading…',
        updated: 'Upgraded to v{latest} — restart to apply',
        restarting: 'Restarting…',
        restart: 'Restart host',
        updateLocal: 'Local install: no online upgrade',
        updateFailed: 'Upgrade failed: {error}',
        updateCheckFailed: 'Update check failed: {error}',
        updateUpToDate: 'Up to date',
      },
    };

    let t = (key, vars) => {
      const raw = DICT.zh[key] ?? key;
      return vars === undefined ? raw : raw.replace(/\{(\w+)\}/g, (m, name) => (
        vars[name] === undefined ? m : String(vars[name])
      ));
    };

    /* ------------------------------------------------------------------ *
     * 宿主 API
     * ------------------------------------------------------------------ */
    /** 探到的可用前缀（`''` 表示根路径），`null` 表示还没探过。 */
    let apiBase = null;
    /** 子路径部署时的候选，如 `/study-win10`。 */
    const baseCandidates = () => {
      const list = [''];
      try {
        const path = new URL(document.baseURI).pathname.replace(/\/+$/, '');
        if (path && path !== '/') list.push(path);
      } catch { /* 拿不到 baseURI 就只试根路径 */ }
      return list;
    };

    async function rawRequest(base, path, init) {
      const response = await fetch(`${base}${API_ROOT}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
      });
      const text = await response.text();
      if (!response.ok) {
        let detail = text.slice(0, 200);
        try {
          const parsed = JSON.parse(text);
          if (parsed?.error) detail = String(parsed.error);
        } catch { /* 非 JSON 错误体就用原文 */ }
        const error = new Error(detail || `${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }
      return text === '' ? {} : JSON.parse(text);
    }

    /** 按已知前缀请求；前缀未知或失效时重新探测一次。 */
    async function request(path, init) {
      if (apiBase === null) await probeBase();
      try {
        return await rawRequest(apiBase ?? '', path, init);
      } catch (error) {
        /* 404/502 往往意味着前缀猜错了（换部署方式），重探一次再试。 */
        if (error.status === 404 || error.status === 502) {
          apiBase = null;
          await probeBase();
          return rawRequest(apiBase ?? '', path, init);
        }
        throw error;
      }
    }

    async function probeBase() {
      for (const base of baseCandidates()) {
        try {
          const status = await rawRequest(base, '/status', { method: 'GET' });
          if (status && typeof status === 'object' && 'docs' in status) {
            apiBase = base;
            return status;
          }
        } catch { /* 换下一个候选 */ }
      }
      apiBase = '';
      throw new Error('unreachable');
    }

    const searchApi = (q, limit) => request('/search', {
      method: 'POST',
      body: JSON.stringify({ q, limit }),
    });

    const statusApi = () => request('/status', { method: 'GET' });

    const reindexApi = () => request('/reindex', { method: 'POST', body: '{}' });

    /* 升级通道（宿主侧 update.js 提供）：检查 → 安装 → 重启，三步各自独立。
     * 检查失败在后台静默——一台离线机器不该在面板上顶着一条红字。 */
    const updateApi = (force) => request(`/update${force === true ? '?force=1' : ''}`, { method: 'GET' });
    const upgradeApi = () => request('/update/upgrade', { method: 'POST', body: '' });
    const updateJobApi = () => request('/update/job', { method: 'GET' });
    const restartApi = () => request('/update/restart', { method: 'POST', body: '' });
    const pingApi = () => request('/ping', { method: 'GET' });

    /* 跨挂载记忆：面板被卸载又装回来时，不能把「刚升级完、等重启」错认成「还有新版本」。 */
    const upgradeMemory = { to: '' };
    /* 升级作业轮询与重启探测的计时器。放模块级才不会随面板卸载一起消失。 */
    const timers = { job: null, restart: null };

    /* ------------------------------------------------------------------ *
     * 展示辅助
     * ------------------------------------------------------------------ */
    const KIND_LABEL = {
      'user/message': 'kindUser',
      'assistant/message': 'kindAssistant',
      'tool/call': 'kindTool',
      'tool/result': 'kindResult',
      'system/message': 'kindSystem',
    };

    function kindLabel(kind) {
      const key = KIND_LABEL[kind];
      return key === undefined ? t('kindOther') : t(key);
    }

    /** 相对时间：一周内说「x 分钟前」，更久给日期。 */
    function fmtTime(ms) {
      const time = Number(ms);
      if (!Number.isFinite(time) || time <= 0) return '';
      const diff = Date.now() - time;
      if (diff < 60_000) return '刚刚';
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
      if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
      const d = new Date(time);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    /** 数值千分位，长索引量在窄面板里也读得出来。 */
    function fmtNum(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '0';
      return n.toLocaleString('en-US');
    }

    /** 工作区路径只留最后两段，够辨认又不占宽。 */
    function cwdTail(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return '';
      const parts = cwd.split(/[\\/]+/).filter(Boolean);
      return parts.slice(-2).join('/');
    }

    function groupTitle(group) {
      const title = typeof group?.title === 'string' ? group.title.trim() : '';
      if (title !== '') return title;
      const first = group?.sessionId;
      return typeof first === 'string' ? first.slice(0, 18) : t('untitled');
    }

    /* ------------------------------------------------------------------ *
     * 样式：全部从 currentColor 派生，明暗主题自动跟随
     * ------------------------------------------------------------------ */
    const line = (percent) => `color-mix(in oklab, currentColor ${percent}%, transparent)`;

    const ST = {
      panel: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        color: 'inherit',
        font: 'inherit',
      },
      head: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '12px 16px 8px',
        flex: '0 0 auto',
      },
      input: {
        flex: '1 1 auto',
        minWidth: 0,
        padding: '9px 12px',
        borderRadius: 8,
        border: `1px solid ${line(18)}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        outline: 'none',
      },
      btn: {
        flex: '0 0 auto',
        padding: '8px 12px',
        borderRadius: 8,
        border: `1px solid ${line(18)}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        opacity: 0.85,
      },
      meta: {
        padding: '0 16px 8px',
        fontSize: 12,
        opacity: 0.62,
        display: 'flex',
        gap: 12,
        flexWrap: 'wrap',
        alignItems: 'center',
        flex: '0 0 auto',
      },
      /* 升级条：只在这一条真的要说点什么时才出现，常态下让位给结果列表 */
      updateBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        margin: '0 16px 8px',
        padding: '7px 10px',
        borderRadius: 8,
        border: `1px solid ${line(16)}`,
        background: line(6),
        fontSize: 12,
        flex: '0 0 auto',
      },
      updateWarn: {
        border: `1px solid ${line(30)}`,
        background: line(10),
      },
      updateText: {
        flex: '1 1 auto',
        minWidth: 0,
        opacity: 0.85,
        overflowWrap: 'anywhere',
      },
      chip: {
        padding: '2px 8px',
        borderRadius: 999,
        border: `1px solid ${line(16)}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 11,
        opacity: 0.55,
        cursor: 'pointer',
      },
      chipHot: {
        padding: '2px 8px',
        borderRadius: 999,
        border: `1px solid ${line(40)}`,
        background: line(10),
        color: 'inherit',
        font: 'inherit',
        fontSize: 11,
        opacity: 0.95,
        cursor: 'pointer',
      },
      tinyBtn: {
        flex: '0 0 auto',
        padding: '4px 10px',
        borderRadius: 6,
        border: `1px solid ${line(24)}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      list: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        padding: '0 10px 16px',
      },
      group: {
        margin: '6px 6px 12px',
        borderRadius: 10,
        border: `1px solid ${line(12)}`,
        overflow: 'hidden',
      },
      groupHead: {
        display: 'flex',
        gap: 8,
        alignItems: 'baseline',
        padding: '9px 12px',
        cursor: 'pointer',
        background: line(5),
      },
      groupTitle: {
        fontWeight: 600,
        fontSize: 13,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: '1 1 auto',
      },
      groupMeta: {
        flex: '0 0 auto',
        fontSize: 11,
        opacity: 0.55,
        whiteSpace: 'nowrap',
      },
      hit: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: 'none',
        borderTop: `1px solid ${line(8)}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        padding: '8px 12px',
        cursor: 'pointer',
      },
      hitActive: {
        background: line(10),
      },
      hitRow: {
        display: 'flex',
        gap: 8,
        alignItems: 'baseline',
        marginBottom: 3,
      },
      badge: {
        flex: '0 0 auto',
        fontSize: 11,
        opacity: 0.6,
        border: `1px solid ${line(16)}`,
        borderRadius: 5,
        padding: '0 5px',
        lineHeight: '16px',
      },
      snippet: {
        fontSize: 13,
        lineHeight: 1.5,
        opacity: 0.88,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: '3.2em',
        overflow: 'hidden',
      },
      mark: {
        background: 'color-mix(in oklab, #f5b301 34%, transparent)',
        color: 'inherit',
        borderRadius: 3,
        padding: '0 1px',
      },
      center: {
        padding: '40px 20px',
        textAlign: 'center',
        opacity: 0.6,
        fontSize: 13,
        lineHeight: 1.7,
      },
      error: {
        margin: '0 16px 8px',
        padding: '8px 12px',
        borderRadius: 8,
        background: 'color-mix(in oklab, #d9534f 16%, transparent)',
        fontSize: 12,
      },
    };

    /** 服务容器，`apply` 时赋值；面板里要靠它拿 `uiWorkspace`。 */
    let shellCtx = null;

    /**
     * 面板被结果点击抢走焦点后会被卸载（`main` 槽切到会话视图），
     * 再次打开时用它恢复上一次的查询并自动重跑，避免用户重新输入。
     */
    const memory = { text: '' };

    function openSessionById(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      try {
        shellCtx?.get?.('uiWorkspace')?.openSession?.(sessionId);
      } catch (err) {
        log('openSession failed', err);
      }
    }

    /* ------------------------------------------------------------------ *
     * 图标
     *
     * shell 自带的图标一律是 16×16、`fill="none"`、`stroke="currentColor"`、
     * `stroke-width="1"` 的纯线条（侧栏的「工作区」「插件」都是），
     * 所以这里也用同一套规格手绘，不引 emoji——emoji 是彩色的，和线条图标并排会很跳。
     * ------------------------------------------------------------------ */
    function SearchIcon(props) {
      const size = Number(props?.size ?? 18) || 18;
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        style: { display: 'block' },
      },
        /* 放大镜：镜筒偏左上留出把手，和 shell 图标的视觉重心一致 */
        h('circle', { cx: 6.6, cy: 6.6, r: 5 }),
        h('path', { d: 'M10.1 10.1 14.3 14.3' }),
        /* 镜片里两道横线：正文检索，比纯放大镜更贴「全文搜索」 */
        h('path', { d: 'M4.4 5.4h4.1M4.4 7.3h2.6' }),
      );
    }

    /* ------------------------------------------------------------------ *
     * 面板
     * ------------------------------------------------------------------ */
    function SearchPanel() {
      const [text, setText] = useState(memory.text);
      const [query, setQuery] = useState(memory.text.trim());
      const [data, setData] = useState(null);
      const [status, setStatus] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const [active, setActive] = useState(0);
      const [update, setUpdate] = useState(null);
      const [upd, setUpd] = useState('idle');
      const [updError, setUpdError] = useState(null);
      const inputRef = useRef(null);
      const abortRef = useRef(null);
      const timerRef = useRef(null);
      const seqRef = useRef(0);

      /* 升级/重启的计时器放进模块级对象：面板被卸载（去看了会话）也不能把重启轮询带走。 */
      function watchJob() {
        if (timers.job !== null) clearInterval(timers.job);
        timers.job = setInterval(() => {
          updateJobApi()
            .then((view) => {
              if (view?.state === 'running') return;
              clearInterval(timers.job);
              timers.job = null;
              if (view?.state === 'done') {
                upgradeMemory.to = typeof view.to === 'string' ? view.to : '';
                setUpdate((prev) => (prev === null ? prev : { ...prev, latest: view.to ?? prev.latest, hasUpdate: false, upgrading: false }));
                setUpd('upgraded');
              } else {
                setUpd('error');
                setUpdError(t('updateFailed', { error: String(view?.error ?? view?.state ?? '?') }));
              }
            })
            .catch(() => { /* 宿主正在被替换时连不上是常态，下一轮再试 */ });
        }, 1200);
      }

      /* 重启后等宿主回来：探测通了再刷新，用户看到的是一张新页面而不是一张坏页面。 */
      function watchRestart() {
        let tries = 0;
        apiBase = null;
        if (timers.restart !== null) clearInterval(timers.restart);
        timers.restart = setInterval(() => {
          tries += 1;
          pingApi()
            .then(() => {
              clearInterval(timers.restart);
              timers.restart = null;
              try {
                location.reload();
              } catch { /* 不能自动刷新就留一条提示 */ }
            })
            .catch(() => {
              if (tries < 90) return;
              clearInterval(timers.restart);
              timers.restart = null;
              setUpd('error');
              setUpdError(t('updateFailed', { error: 'the host did not come back' }));
            });
        }, 1000);
      }

      const checkUpdate = useCallback((force) => {
        setUpd((prev) => (prev === 'upgrading' || prev === 'restarting' ? prev : 'checking'));
        updateApi(force === true)
          .then((info) => {
            setUpdate(info);
            setUpdError(null);
            const kind = info?.channel?.kind;
            if (info?.upgrading === true) {
              setUpd('upgrading');
              watchJob();
              return;
            }
            /* 刚升级完但还没重启：宿主跑的还是旧版本，别又提示一次「有新版本」。 */
            if (typeof info?.latest === 'string' && upgradeMemory.to !== '' && info.latest === upgradeMemory.to) {
              setUpd('upgraded');
              return;
            }
            if (info?.hasUpdate === true) {
              setUpd('available');
              return;
            }
            if (kind === 'local' || kind === 'link' || kind === 'file' || kind === 'git') {
              setUpd(force === true ? 'local' : 'idle');
              return;
            }
            if (info?.ok !== true) {
              if (force !== true) {
                setUpd('idle');
                return;
              }
              setUpd('error');
              setUpdError(t('updateCheckFailed', { error: String(info?.error ?? '?') }));
              return;
            }
            setUpd(force === true ? 'current' : 'idle');
          })
          .catch((err) => {
            if (force !== true) {
              setUpd('idle');
              return;
            }
            setUpd('error');
            setUpdError(t('updateCheckFailed', { error: String(err?.message ?? err) }));
          });
      }, []);

      const onUpgrade = useCallback(() => {
        setUpdError(null);
        setUpd('upgrading');
        upgradeApi()
          .then((res) => {
            if (res?.ok !== true) {
              setUpd('error');
              setUpdError(t('updateFailed', { error: String(res?.error ?? res?.reason ?? '?') }));
              return;
            }
            watchJob();
          })
          .catch((err) => {
            setUpd('error');
            setUpdError(t('updateFailed', { error: String(err?.message ?? err) }));
          });
      }, []);

      const onRestart = useCallback(() => {
        setUpd('restarting');
        /* 宿主可能在回包之前就退出了：连接被掐断正是预期的成功形态。 */
        restartApi()
          .catch(() => {})
          .then(() => watchRestart());
      }, []);

      /* 打开面板即聚焦，用户不必再点一次输入框。 */
      useEffect(() => {
        const handle = setTimeout(() => {
          try {
            inputRef.current?.focus();
          } catch { /* 拿不到焦点不影响搜索 */ }
        }, 30);
        return () => clearTimeout(handle);
      }, []);

      /* 首次挂载探测宿主 + 取一次状态（顺便显示索引统计）。 */
      useEffect(() => {
        let alive = true;
        statusApi()
          .then((next) => { if (alive) setStatus(next); })
          .catch((err) => { if (alive) setError(t('unreachable') + (err?.message ? ` (${err.message})` : '')); });
        return () => { alive = false; };
      }, []);

      /* 建索引期间轮询进度。 */
      useEffect(() => {
        if (status?.phase !== 'syncing') return undefined;
        const handle = setTimeout(() => {
          statusApi().then(setStatus).catch(() => {});
        }, 1500);
        return () => clearTimeout(handle);
      }, [status]);

      /* 每次挂载静默查一次更新：后台失败不讲，点了版本号才把失败讲出来。 */
      useEffect(() => {
        checkUpdate(false);
      }, [checkUpdate]);

      const runSearch = useCallback((raw) => {
        const next = raw.trim();
        if (next === '') {
          abortRef.current?.abort?.();
          setData(null);
          setBusy(false);
          setError(null);
          setQuery('');
          memory.text = '';
          return;
        }
        abortRef.current?.abort?.();
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        abortRef.current = controller;
        const seq = ++seqRef.current;
        setBusy(true);
        setQuery(next);
        searchApi(next, 300)
          .then((result) => {
            if (seqRef.current !== seq) return;
            setData(result);
            setActive(0);
            setError(null);
            setBusy(false);
          })
          .catch((err) => {
            if (seqRef.current !== seq) return;
            if (err?.name === 'AbortError') return;
            setBusy(false);
            setData(null);
            setError(err?.message === 'unreachable' ? t('unreachable') : t('failed', { error: err?.message ?? String(err) }));
          });
      }, []);

      const onChange = useCallback((event) => {
        const value = event.target.value;
        setText(value);
        memory.text = value;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => runSearch(value), DEBOUNCE_MS);
      }, [runSearch]);

      useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        abortRef.current?.abort?.();
      }, []);

      /* 面板重新挂载（看完会话再回来）时重跑上次查询，结果与耗时都是新的。 */
      useEffect(() => {
        const initial = memory.text.trim();
        if (initial !== '') runSearch(initial);
      }, [runSearch]);

      const groups = Array.isArray(data?.groups) ? data.groups : [];
      /* 扁平的命中序列，键盘上下键按它移动。 */
      const flat = useMemo(() => {
        const out = [];
        for (const group of groups) {
          const docs = Array.isArray(group?.docs) ? group.docs : [];
          for (const doc of docs) out.push({ group, doc });
        }
        return out;
      }, [groups]);

      const openSession = useCallback((sessionId) => {
        openSessionById(sessionId);
      }, []);

      const onKeyDown = useCallback((event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (flat.length > 0) openSession(flat[Math.min(active, flat.length - 1)].group.sessionId);
          else runSearch(text);
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive((i) => Math.min(i + 1, Math.max(0, flat.length - 1)));
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((i) => Math.max(i - 1, 0));
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          if (text !== '') {
            setText('');
            runSearch('');
          } else {
            inputRef.current?.blur?.();
          }
        }
      }, [active, flat, openSession, runSearch, text]);

      const onReindex = useCallback(() => {
        setError(null);
        reindexApi()
          .then(() => statusApi())
          .then((next) => setStatus(next))
          .catch((err) => setError(String(err?.message ?? err)));
      }, []);

      const meta = [];
      if (data !== null && data.empty !== true) {
        meta.push(t('results', {
          total: fmtNum(data.total ?? 0),
          groups: fmtNum(data.groups?.length ?? 0),
          ms: Number(data.took ?? 0).toFixed(1),
        }));
      } else if (busy) {
        meta.push(t('searching'));
      }
      if (status !== null) {
        if (status.phase === 'syncing' && status.total > 0) {
          meta.push(t('indexing', { done: fmtNum(status.done ?? 0), total: fmtNum(status.total ?? 0) }));
        } else if (data === null) {
          meta.push(t('indexingDocs', { docs: fmtNum(status.docs ?? 0) }));
        }
      }

      /* 版本号本身就是「检查更新」的按钮：平时安静地显示版本，有新版本时变成一枚高亮提示。 */
      const currentVersion = update?.loaded ?? update?.current ?? status?.version ?? '';
      const versionChip = h('button', {
        key: 'version',
        type: 'button',
        style: upd === 'available' ? ST.chipHot : ST.chip,
        onClick: () => checkUpdate(true),
        title: upd === 'available'
          ? t('updateAvailable', { latest: update?.latest ?? '' })
          : t('version', { v: currentVersion }),
      }, upd === 'available' && typeof update?.latest === 'string'
        ? `↑ v${update.latest}`
        : `v${currentVersion === '' ? '?' : currentVersion}`);

      let updateBar = null;
      if (upd === 'available') {
        updateBar = h('div', { style: ST.updateBar },
          h('span', { style: ST.updateText }, t('updateAvailable', { latest: update?.latest ?? '' })),
          h('button', { type: 'button', style: ST.tinyBtn, onClick: onUpgrade }, t('updateNow')));
      } else if (upd === 'upgrading' || upd === 'restarting') {
        updateBar = h('div', { style: ST.updateBar },
          h('span', { style: ST.updateText }, upd === 'restarting' ? t('restarting') : t('updating')));
      } else if (upd === 'upgraded') {
        updateBar = h('div', { style: ST.updateBar },
          h('span', { style: ST.updateText }, t('updated', { latest: update?.latest ?? upgradeMemory.to })),
          h('button', { type: 'button', style: ST.tinyBtn, onClick: onRestart }, t('restart')));
      } else if (upd === 'error') {
        updateBar = h('div', { style: { ...ST.updateBar, ...ST.updateWarn } },
          h('span', { style: ST.updateText }, String(updError ?? '')));
      } else if (upd === 'local') {
        updateBar = h('div', { style: ST.updateBar },
          h('span', { style: ST.updateText }, t('updateLocal')));
      } else if (upd === 'current') {
        updateBar = h('div', { style: ST.updateBar },
          h('span', { style: ST.updateText }, t('updateUpToDate')));
      }

      const body = [];
      if (error !== null) body.push(h('div', { key: 'err', style: ST.error }, error));

      if (flat.length === 0 && error === null) {
        const message = text.trim() === ''
          ? t('hint')
          : (busy
            ? t('searching')
            : `${query === '' ? t('empty') : t('emptyFor', { q: query })} — ${t('emptyHint')}`);
        body.push(h('div', { key: 'center', style: ST.center }, message));
      } else {
        let index = 0;
        const nodes = groups.map((group) => {
          const docs = Array.isArray(group?.docs) ? group.docs : [];
          return h('div', { key: String(group.sessionId ?? index), style: ST.group },
            h('div', {
              style: ST.groupHead,
              onClick: () => openSession(group.sessionId),
              role: 'button',
              tabIndex: 0,
            },
              h('span', { style: ST.groupTitle }, groupTitle(group)),
              h('span', { style: ST.groupMeta },
                [cwdTail(group.cwd), fmtTime(group.createdAt), docs.length > 0 ? t('docsCount', { n: docs.length }) : '']
                  .filter(Boolean).join(' · ')),
            ),
            docs.map((doc) => {
              const isActive = index === active;
              const key = `${group.sessionId}:${doc.seq ?? index}`;
              index += 1;
              return h('button', {
                key,
                type: 'button',
                style: isActive ? { ...ST.hit, ...ST.hitActive } : ST.hit,
                onClick: () => openSession(group.sessionId),
                title: t('openHint'),
              },
                h('div', { style: ST.hitRow },
                  h('span', { style: ST.badge }, kindLabel(doc.kind)),
                  h('span', { style: ST.groupMeta }, fmtTime(doc.time)),
                ),
                h('div', { style: ST.snippet },
                  (Array.isArray(doc.snippet) ? doc.snippet : [{ text: String(doc.text ?? '') }])
                    .map((seg, i) => (seg?.mark === true
                      ? h('mark', { key: i, style: ST.mark }, String(seg.text ?? ''))
                      : h('span', { key: i }, String(seg.text ?? ''))))),
              );
            }),
          );
        });
        body.push(h('div', { key: 'list', style: ST.list }, nodes));
      }

      return h('div', { style: ST.panel },
        h('div', { style: ST.head },
          h('input', {
            ref: inputRef,
            style: ST.input,
            value: text,
            placeholder: t('placeholder'),
            onChange,
            onKeyDown,
            spellCheck: false,
            'aria-label': t('title'),
          }),
          h('button', {
            type: 'button',
            style: ST.btn,
            onClick: onReindex,
            title: t('reindex'),
            disabled: status?.phase === 'syncing',
          }, status?.phase === 'syncing' ? t('reindexing') : t('reindex')),
        ),
        h('div', { style: ST.meta },
          h('span', { key: 'meta' }, meta.join(' · ')),
          versionChip),
        ...(updateBar === null ? [] : [updateBar]),
        ...body,
      );
    }

    /* ------------------------------------------------------------------ *
     * 插件入口
     * ------------------------------------------------------------------ */
    return {
      inject: ['slots', 'locale'],
      async apply(ctx) {
        shellCtx = ctx;
        try {
          ctx.locale.register('fastSearch', 'zh', DICT.zh);
          ctx.locale.register('fastSearch', 'en', DICT.en);
          const bound = ctx.locale.bind('fastSearch');
          if (typeof bound === 'function') t = bound;
        } catch (err) {
          log('locale registration failed; using the embedded copy', err);
        }

        ctx.effect(() => {
          const disposers = [];
          try {
            disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 45,
              label: t('title'),
            }, SearchIcon)));
            disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
              name: 'main',
              key: PANEL_ID,
              label: t('title'),
            }, SearchPanel)));
          } catch (err) {
            log('panel registration failed', err);
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose?.();
              } catch { /* 卸载期异常不上抛 */ }
            }
          };
        });
      },
    };
  },
});
