/**
 * dsh-fast-search — 浏览器半边。
 *
 * 一个独立的全屏搜索面板（`main` 槽，key = `fast-search`）+ 侧栏放大镜图标。
 * 点「搜索」或回车触发检索（输入过程中不发请求），结果按会话分组，点击任意一条跳进该会话。
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
        hint: '输入关键词搜索所有会话正文。\n空格 = 同时包含（A B）；AND / & 也是「且」；OR / | 是「或」；括号可分组：插件 AND (缓存 OR 预热)。\n用引号搜短语："node sqlite"；词尾 * 做前缀：mmap*。中文按字索引，可直接搜「插件」。',
        emptyFor: '没有找到匹配「{q}」的会话',
        pressSearch: '按 Enter 或点右侧「搜索」开始检索。',
        emptyHint: '可试试更短的词、去掉部分筛选，或用 AND / OR / & / | 重新组合。',
        emptySyntax: '语法：A B（同时包含）· A AND B / A & B · A OR B / A | B · (A OR B) C · "短语" · 前缀*',
        searching: '搜索中…',
        results: '{total} 条命中 · {groups} 个会话 · {ms}ms',
        docsCount: '{n} 条',
        indexing: '正在建索引 {done}/{total}',
        indexingDocs: '{docs} 条消息',
        reindex: '重建索引',
        reindexing: '重建中…',
        reindexQueued: '已开始重建，进度见下方',
        reindexHint: '增量对账：只重解大小或修改时间变化的会话文件，不删库',
        search: '搜索',
        searchHint: '立即搜索（词没改时 Enter 打开第一条结果）',
        customRange: '自定义',
        fromDate: '开始日期',
        toDate: '结束日期',
        rangeInvalid: '开始日期不能晚于结束日期',
        filterCustom: '时间 {range}',
        customFrom: '{date} 起',
        customTo: '截至 {date}',
        customSpan: '{from} ~ {to}',
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
        updated: '已升级到 v{latest}，请手动重启 dsh web 后生效',
        restartNeeded: '磁盘上已是 v{latest}，宿主仍运行 v{loaded}；请手动重启 dsh web',
        updateLocal: '本地安装，不提供在线升级',
        updateFailed: '升级失败：{error}',
        updateCheckFailed: '检查更新失败：{error}',
        updateUpToDate: '已是最新版本',
        semanticLabel: '语义',
        semanticOff: '语义 关',
        semanticAuto: '语义 自动',
        semanticOn: '语义 开',
        semanticOffChoice: '关（纯全文）',
        semanticAutoChoice: '自动（稀疏时补召回）',
        semanticOnChoice: '开（每次融合）',
        semanticHint: '语义检索：关（纯全文）/ 自动（全文命中少时补一轮向量召回）/ 开（每次都融合）',
        semanticUnavailable: '宿主未启用语义索引（vectors.url 为空）',
        semanticUsed: '语义补召 {n} 块 · {ms}ms',
        semanticResults: '语义 {n} 条命中 · {groups} 个会话 · {ms}ms',
        semanticFailed: '语义召回失败，已退回纯全文',
        semanticIndexing: '语义索引 {done}/{total}',
        semanticIndex: '语义索引 {done}/{total}',
        semanticBadge: '语义',
        allWorkspaces: '全部工作区',
        workspaceLabel: '工作区',
        rangeLabel: '时间',
        rangeAll: '全部',
        rangeDay: '1 天',
        rangeWeek: '1 周',
        rangeMonth: '1 月',
        filterHint: '按工作区或时间范围缩小结果',
        filterNote: '筛选：{filters}',
        filterWorkspace: '工作区 {name}',
        filterRange: '近 {label}',
        workspaceMissing: '（不在索引中）',
        emptyFiltered: '筛选条件可能过窄',
        syntaxError: '语法提示：{detail}，已按全部关键词同时命中处理',
        syntaxUnbalanced: '括号不匹配',
        syntaxEmptyGroup: '空括号',
        syntaxMissingOperand: '运算符缺少关键词',
        syntaxUnexpectedClose: '多余的右括号',
        syntaxUnexpectedToken: '无法识别的符号',
      },
      en: {
        title: 'Full-text search',
        placeholder: 'Search every session…',
        hint: 'Search every session. Space means AND (A B); AND / & also work; OR / | mean OR; group with parentheses: plugins AND (cache OR warmup).\nQuote a phrase: "node sqlite"; trailing * for prefix: mmap*. CJK is indexed per character.',
        emptyFor: 'No session matches “{q}”',
        pressSearch: 'Press Enter or click Search to run the query.',
        emptyHint: 'Try shorter terms, loosen filters, or combine them with AND / OR / & / |.',
        emptySyntax: 'Syntax: A B (both) · A AND B / A & B · A OR B / A | B · (A OR B) C · "phrase" · prefix*',
        searching: 'Searching…',
        results: '{total} hits · {groups} sessions · {ms}ms',
        docsCount: '{n} items',
        indexing: 'Indexing {done}/{total}',
        indexingDocs: '{docs} messages',
        reindex: 'Rebuild index',
        reindexing: 'Rebuilding…',
        reindexQueued: 'Rebuild started',
        reindexHint: 'Incremental reconcile: re-read only files whose size or mtime changed',
        search: 'Search',
        searchHint: 'Search now (Enter opens the first hit when the text is unchanged)',
        customRange: 'Custom',
        fromDate: 'Start date',
        toDate: 'End date',
        rangeInvalid: 'Start date cannot be after end date',
        filterCustom: 'time {range}',
        customFrom: 'from {date}',
        customTo: 'until {date}',
        customSpan: '{from} ~ {to}',
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
        updated: 'Upgraded to v{latest} — restart dsh web manually to apply',
        restartNeeded: 'Disk has v{latest}, but the host is still running v{loaded}; restart dsh web manually',
        updateLocal: 'Local install: no online upgrade',
        updateFailed: 'Upgrade failed: {error}',
        updateCheckFailed: 'Update check failed: {error}',
        updateUpToDate: 'Up to date',
        semanticLabel: 'Semantic',
        semanticOff: 'Semantic off',
        semanticAuto: 'Semantic auto',
        semanticOn: 'Semantic on',
        semanticOffChoice: 'Off (FTS only)',
        semanticAutoChoice: 'Auto (recall when sparse)',
        semanticOnChoice: 'On (always fuse)',
        semanticHint: 'Semantic: off (FTS only) / auto (recall when FTS is sparse) / on (always fuse)',
        semanticUnavailable: 'Semantic index is not enabled on the host (vectors.url is empty)',
        semanticUsed: 'semantic +{n} chunks · {ms}ms',
        semanticResults: 'semantic {n} hits · {groups} sessions · {ms}ms',
        semanticFailed: 'Semantic recall failed, fell back to FTS',
        semanticIndexing: 'semantic index {done}/{total}',
        semanticIndex: 'semantic index {done}/{total}',
        semanticBadge: 'semantic',
        allWorkspaces: 'All workspaces',
        workspaceLabel: 'Workspace',
        rangeLabel: 'Time',
        rangeAll: 'Any time',
        rangeDay: '1 day',
        rangeWeek: '1 week',
        rangeMonth: '1 month',
        filterHint: 'Narrow results by workspace or time range',
        filterNote: 'Filter: {filters}',
        filterWorkspace: 'workspace {name}',
        filterRange: 'last {label}',
        workspaceMissing: ' (not indexed)',
        emptyFiltered: 'the filters may be too narrow',
        syntaxError: 'Query syntax: {detail}; searched all terms instead',
        syntaxUnbalanced: 'unbalanced parentheses',
        syntaxEmptyGroup: 'empty parentheses',
        syntaxMissingOperand: 'operator without a term',
        syntaxUnexpectedClose: 'extra closing parenthesis',
        syntaxUnexpectedToken: 'unrecognized symbol',
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

    const searchApi = (payload) => request('/search', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const workspaceApi = () => request('/workspaces', { method: 'GET' });

    const statusApi = () => request('/status', { method: 'GET' });

    const reindexApi = () => request('/reindex', { method: 'POST', body: '{}' });

    /* 升级通道（宿主侧 update.js 提供）：检查 → 安装。重启由用户手动完成，
     * 插件不接管宿主进程——启动参数、端口、环境变量都可能由外部编排决定。
     * 检查失败在后台静默——一台离线机器不该在面板上顶着一条红字。 */
    const updateApi = (force) => request(`/update${force === true ? '?force=1' : ''}`, { method: 'GET' });
    const upgradeApi = () => request('/update/upgrade', { method: 'POST', body: '' });
    const updateJobApi = () => request('/update/job', { method: 'GET' });

    /* 跨挂载记忆：面板被卸载又装回来时，不能把「刚升级完、等重启」错认成「还有新版本」。 */
    const upgradeMemory = { to: '' };
    /* 升级作业轮询的计时器。放模块级才不会随面板卸载一起消失。 */
    const timers = { job: null };

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

    /** 语义建库是否在跑（扫描与嵌入两个阶段都算「正在建」）。 */
    function vecEmbedding(progress) {
      if (progress === null || progress === undefined) return false;
      return progress.phase === 'embedding' || progress.phase === 'scanning';
    }

    /** 全文对账是否在跑：宿主把进度放在 `status.index` 里，阶段是 scanning/indexing。 */
    function indexRunning(status) {
      const phase = status?.index?.phase;
      return phase === 'scanning' || phase === 'indexing';
    }

    /** 工作区路径只留最后两段，够辨认又不占宽。 */
    function cwdTail(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return '';
      const parts = cwd.split(/[\\/]+/).filter(Boolean);
      return parts.slice(-2).join('/');
    }

    /* 宿主返回的语法错误码 → 文案 key；未知码原样显示，方便定位新错误。 */
    const SYNTAX_KEYS = {
      'unbalanced-paren': 'syntaxUnbalanced',
      'empty-group': 'syntaxEmptyGroup',
      'missing-operand': 'syntaxMissingOperand',
      'unexpected-close': 'syntaxUnexpectedClose',
      'unexpected-token': 'syntaxUnexpectedToken',
    };
    function syntaxDetail(code) {
      const key = SYNTAX_KEYS[code];
      return key === undefined ? String(code) : t(key);
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

    /**
     * 原生下拉/日期弹层由浏览器绘制，`background: transparent` 管不到它；
     * 深色主题下宿主没有给控件声明 `color-scheme` 时，弹层会白底白字。
     * 这里按当前文字亮度判断主题，给控件显式 `color-scheme`，让原生弹层跟随。
     */
    function nativeScheme() {
      try {
        /* DSH 的主题插件会把 active.colorScheme 写到根元素；优先信它 */
        const declared = getComputedStyle(document.documentElement).colorScheme;
        if (declared === 'dark' || declared === 'light') return declared;
        const raw = getComputedStyle(document.body).color;
        const parts = raw.match(/\d+(?:\.\d+)?/g);
        if (!parts || parts.length < 3) return 'light dark';
        const [r, g, b] = parts.map(Number);
        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        return luminance > 0.55 ? 'dark' : 'light';
      } catch {
        return 'light dark';
      }
    }

    const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
    function validDate(value) {
      if (typeof value !== 'string') return false;
      const match = DATE_RE.exec(value);
      if (!match) return false;
      const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const date = new Date(year, month - 1, day);
      return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
    }
    function dayStart(value) {
      if (!validDate(value)) return 0;
      const [year, month, day] = value.split('-').map(Number);
      return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
    }
    function dayEnd(value) {
      if (!validDate(value)) return 0;
      const [year, month, day] = value.split('-').map(Number);
      return new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
    }

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
        padding: '8px 16px',
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
      /* 搜索框上方：工作区 + 时间快捷档 + 语义下拉。原生 select 在深浅主题下都可读，不自己造弹层。 */
      controls: {
        display: 'flex',
        gap: 6,
        rowGap: 6,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '12px 16px 0',
        flex: '0 0 auto',
        fontSize: 12,
      },
      statusRow: {
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '0 16px 8px',
        flex: '0 0 auto',
        fontSize: 12,
      },
      statusText: {
        minWidth: 0,
        opacity: 0.55,
      },
      filterLabel: {
        opacity: 0.5,
        marginLeft: 2,
      },
      select: {
        maxWidth: 240,
        padding: '4px 7px',
        borderRadius: 7,
        border: `1px solid ${line(18)}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        outline: 'none',
        cursor: 'pointer',
      },
      /* 原生 option 在 Windows/Chromium 上由系统绘制，显式给实色才能压住白底白字 */
      optionDark: {
        backgroundColor: '#1f1f1f',
        color: '#ececec',
      },
      optionLight: {
        backgroundColor: '#ffffff',
        color: '#111111',
      },
      date: {
        padding: '3px 6px',
        borderRadius: 7,
        border: `1px solid ${line(18)}`,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12,
        outline: 'none',
        maxWidth: 138,
      },
      searchBtn: {
        flex: '0 0 auto',
        padding: '8px 16px',
        borderRadius: 8,
        border: `1px solid ${line(24)}`,
        background: line(8),
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        cursor: 'pointer',
      },
      searchBtnBusy: {
        opacity: 0.45,
        cursor: 'default',
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
      /* 语义命中的来源标记：告诉用户这条不是字面命中，别去正文里找那个词 */
      semBadge: {
        flex: '0 0 auto',
        fontSize: 10,
        opacity: 0.72,
        border: `1px dashed ${line(28)}`,
        borderRadius: 999,
        padding: '0 6px',
        lineHeight: '15px',
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
        whiteSpace: 'pre-line',
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
    const memory = { text: '', workspace: '', range: 'all', from: '', to: '' };

    /* 语义模式是**用户的选择**，不是面板的临时状态：记在 localStorage，刷新与重开都保持。
     * 默认 auto——只在全文稀疏时才补向量，日常查询不受语义索引的延迟影响。 */
    const SEM_KEY = 'dsh-fast-search:semantic';
    const SEM_MODES = ['off', 'auto', 'on'];
    function loadSemantic() {
      try {
        const saved = localStorage.getItem(SEM_KEY);
        if (SEM_MODES.includes(saved)) return saved;
      } catch { /* 隐私模式下 localStorage 可能直接抛，退回默认值 */ }
      return 'auto';
    }
    function saveSemantic(value) {
      try {
        localStorage.setItem(SEM_KEY, value);
      } catch { /* 存不下就只活这一次 */ }
    }

    /* 筛选也是用户的选择：关掉面板再打开、刷新页面都应保持。
     * 工作区存 cwd 原值；时间只存快捷档位，真正的 since 由宿主按「现在」换算——
     * 否则「近 1 天」会在第二天变成「近 2 天」。 */
    const FILTER_KEY = 'dsh-fast-search:filters';
    const RANGE_OPTIONS = [
      { value: 'all', key: 'rangeAll' },
      { value: '1d', key: 'rangeDay' },
      { value: '1w', key: 'rangeWeek' },
      { value: '1m', key: 'rangeMonth' },
    ];
    const RANGE_VALUES = new Set([...RANGE_OPTIONS.map((option) => option.value), 'custom']);
    function loadFilters() {
      try {
        const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null');
        let from = validDate(saved?.from) ? saved.from : '';
        let to = validDate(saved?.to) ? saved.to : '';
        let range = RANGE_VALUES.has(saved?.range) ? saved.range : 'all';
        if (range === 'custom' && from === '' && to === '') range = 'all';
        if (from !== '' && to !== '' && from > to) {
          from = '';
          to = '';
          range = 'all';
        }
        return {
          workspace: typeof saved?.workspace === 'string' ? saved.workspace : '',
          range,
          from: range === 'custom' ? from : '',
          to: range === 'custom' ? to : '',
        };
      } catch {
        return { workspace: '', range: 'all', from: '', to: '' };
      }
    }
    function saveFilters() {
      try {
        localStorage.setItem(FILTER_KEY, JSON.stringify({
          workspace: memory.workspace,
          range: memory.range,
          from: memory.from,
          to: memory.to,
        }));
      } catch { /* 存不下就只活这一次 */ }
    }
    const savedFilters = loadFilters();
    memory.workspace = savedFilters.workspace;
    memory.range = savedFilters.range;
    memory.from = savedFilters.from;
    memory.to = savedFilters.to;

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
      const [sem, setSem] = useState(loadSemantic);
      const semRef = useRef('auto');
      semRef.current = sem;
      /* 新增 hook 一律排在旧 hook 之后：client-smoke 的 React 桩按下标预置状态 */
      const [workspace, setWorkspace] = useState(memory.workspace);
      const [range, setRange] = useState(memory.range);
      const [workspaces, setWorkspaces] = useState([]);
      const [from, setFrom] = useState(memory.from);
      const [to, setTo] = useState(memory.to);
      const filterRef = useRef({
        workspace: memory.workspace,
        range: memory.range,
        from: memory.from,
        to: memory.to,
      });
      const inputRef = useRef(null);
      const abortRef = useRef(null);
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

      const checkUpdate = useCallback((force) => {
        setUpd((prev) => (prev === 'upgrading' ? prev : 'checking'));
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
            /* 磁盘上的文件已经换过（手动拷贝/本地安装），但宿主还抱着旧模块：
             * 线上升级帮不上忙，只能提示用户手动重启。 */
            if (info?.stale === true) {
              setUpd('stale');
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

      /* 工作区列表：一次拉全，选择与计数都在本地完成，切换筛选不再请求。 */
      useEffect(() => {
        let alive = true;
        workspaceApi()
          .then((next) => {
            if (alive) setWorkspaces(Array.isArray(next?.workspaces) ? next.workspaces : []);
          })
          .catch(() => { /* 列表拿不到不影响搜索；手输的 cwd 仍可通过 API 使用 */ });
        return () => { alive = false; };
      }, []);

      /* 建索引期间轮询进度（全文对账或语义建库都算）。 */
      useEffect(() => {
        const indexing = indexRunning(status);
        const embedding = status?.vectors?.progress?.phase === 'embedding';
        if (!indexing && !embedding) return undefined;
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
        const filter = filterRef.current;
        const payload = { q: next, limit: 300, semantic: semRef.current };
        if (filter.workspace !== '') payload.workspace = filter.workspace;
        if (filter.range === 'custom') {
          /* 自定义日期是绝对区间：按本地日界换算成毫秒，空的一端保持开区间 */
          const since = dayStart(filter.from);
          const until = dayEnd(filter.to);
          if (since > 0) payload.since = since;
          if (until > 0) payload.until = until;
        } else if (filter.range !== 'all') {
          payload.range = filter.range;
        }
        searchApi(payload)
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

      /* 输入只写草稿（text + memory），不发请求：检索只由「搜索」按钮或回车触发。 */
      const onChange = useCallback((event) => {
        const value = event.target.value;
        setText(value);
        memory.text = value;
      }, []);

      /* 筛选变化立即重跑：下拉和档位点击都是一次性动作，不需要再点「搜索」。 */
      const applyFilter = useCallback((patch) => {
        const next = { ...filterRef.current, ...patch };
        filterRef.current = next;
        memory.workspace = next.workspace;
        memory.range = next.range;
        memory.from = next.from ?? '';
        memory.to = next.to ?? '';
        saveFilters();
        setWorkspace(next.workspace);
        setRange(next.range);
        setFrom(memory.from);
        setTo(memory.to);
        setError(null);
        if (memory.text.trim() !== '') runSearch(memory.text);
      }, [runSearch]);

      /* 日期输入即生效：只选一端就是开区间；两端倒置时先报错、不拿坏区间去搜。 */
      const applyDates = useCallback((nextFrom, nextTo) => {
        applyFilter({
          range: nextFrom !== '' || nextTo !== '' ? 'custom' : 'all',
          from: nextFrom,
          to: nextTo,
        });
      }, [applyFilter]);
      const onFromChange = useCallback((event) => {
        const next = event.target.value;
        setFrom(next);
        if (next !== '' && to !== '' && next > to) {
          setError(t('rangeInvalid'));
          return;
        }
        applyDates(next, to);
      }, [applyDates, to]);
      const onToChange = useCallback((event) => {
        const next = event.target.value;
        setTo(next);
        if (from !== '' && next !== '' && from > next) {
          setError(t('rangeInvalid'));
          return;
        }
        applyDates(from, next);
      }, [applyDates, from]);

      useEffect(() => () => {
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
          /* 输入框里的词还没搜过（或已改过）：回车先检索，而不是打开旧结果的第一条。 */
          if (text.trim() !== query) {
            runSearch(text);
            return;
          }
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
      }, [active, flat, openSession, query, runSearch, text]);

      const onReindex = useCallback(() => {
        setError(null);
        reindexApi()
          .then(() => Promise.all([statusApi(), workspaceApi()]))
          .then(([next, list]) => {
            setStatus(next);
            if (Array.isArray(list?.workspaces)) setWorkspaces(list.workspaces);
          })
          .catch((err) => setError(String(err?.message ?? err)));
      }, []);

      /* 语义模式下拉。切换后立刻重跑当前查询，让用户当场看到差别。 */
      const onSemChange = useCallback((event) => {
        const next = event.target.value;
        if (!SEM_MODES.includes(next)) return;
        setSem(next);
        semRef.current = next;
        saveSemantic(next);
        if (text.trim() !== '') runSearch(text);
      }, [runSearch, text]);

      const meta = [];
      if (data !== null && data.empty !== true) {
        /* 纯语义召回时 FTS 的 total 会是 0，直接照抄会显示「0 条命中」——
         * 改成报语义条数，用户看到的才与实际列表一致。 */
        const semanticOnly = data.semantic?.used === true && Number(data.total ?? 0) === 0;
        meta.push(semanticOnly
          ? t('semanticResults', {
            n: fmtNum(flat.length),
            groups: fmtNum(data.groups?.length ?? 0),
            ms: Number(data.took ?? 0).toFixed(1),
          })
          : t('results', {
            total: fmtNum(data.total ?? 0),
            groups: fmtNum(data.groups?.length ?? 0),
            ms: Number(data.took ?? 0).toFixed(1),
          }));
      } else if (busy) {
        meta.push(t('searching'));
      }
      const semantic = data?.semantic;
      if (semantic?.used === true) {
        meta.push(t('semanticUsed', { n: fmtNum(semantic.hits ?? 0), ms: Number(semantic.ms ?? 0).toFixed(0) }));
      } else if (semantic?.reason === 'error') {
        meta.push(t('semanticFailed'));
      }

      /* 筛选回显：让用户一眼看出「为什么结果这么少」，而不是怀疑搜索坏了。 */
      const activeFilters = [];
      if (workspace !== '') activeFilters.push(t('filterWorkspace', { name: cwdTail(workspace) }));
      if (range === 'custom' && (from !== '' || to !== '')) {
        const label = from !== '' && to !== ''
          ? t('customSpan', { from, to })
          : (from !== '' ? t('customFrom', { date: from }) : t('customTo', { date: to }));
        activeFilters.push(t('filterCustom', { range: label }));
      } else if (range !== 'all') {
        const option = RANGE_OPTIONS.find((item) => item.value === range);
        activeFilters.push(t('filterRange', { label: t(option?.key ?? 'rangeAll') }));
      }
      if (activeFilters.length > 0) meta.push(t('filterNote', { filters: activeFilters.join(' · ') }));
      if (typeof data?.parseError === 'string' && data.parseError !== '') {
        meta.push(t('syntaxError', { detail: syntaxDetail(data.parseError) }));
      }

      /* 版本号本身就是「检查更新」的按钮：平时安静地显示版本，有新版本时变成一枚高亮提示。 */
      const currentVersion = update?.loaded ?? update?.current ?? status?.version ?? '';

      /* 语义下拉：宿主没配 vectors.url 时禁用，并如实显示「关」而不是一个能点却无效的控件。 */
      const semAvailable = status?.vectors?.enabled === true;
      const semValue = semAvailable ? sem : 'off';
      const versionChip = h('button', {
        key: 'version',
        type: 'button',
        style: { ...(upd === 'available' ? ST.chipHot : ST.chip), flex: '0 0 auto' },
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
      } else if (upd === 'upgrading') {
        updateBar = h('div', { style: ST.updateBar },
          h('span', { style: ST.updateText }, t('updating')));
      } else if (upd === 'upgraded') {
        updateBar = h('div', { style: ST.updateBar },
          h('span', { style: ST.updateText }, t('updated', { latest: update?.latest ?? upgradeMemory.to })));
      } else if (upd === 'stale') {
        updateBar = h('div', { style: ST.updateBar },
          h('span', { style: ST.updateText }, t('restartNeeded', {
            latest: update?.current ?? '?',
            loaded: update?.loaded ?? '?',
          })));
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

      /* 选中的工作区可能已被重建索引删除：仍要显示它，否则 select 会静默跳回「全部」 */
      const knownWorkspaces = new Set(workspaces.map((item) => item.cwd));
      const workspaceOptions = workspace !== '' && !knownWorkspaces.has(workspace)
        ? [{ cwd: workspace, sessions: 0, missing: true }, ...workspaces]
        : workspaces;
      const workspaceName = (item) => {
        const base = cwdTail(item.cwd) || item.cwd;
        const count = Number(item.sessions) > 0 ? ` · ${fmtNum(item.sessions)}` : '';
        return `${base}${count}${item.missing === true ? t('workspaceMissing') : ''}`;
      };
      const semChoice = {
        off: 'semanticOffChoice',
        auto: 'semanticAutoChoice',
        on: 'semanticOnChoice',
      };
      /* 筛选与语义开关统一放在搜索框上方，搜索框本身只负责输入。 */
      const scheme = nativeScheme();
      const optionStyle = scheme === 'dark' ? ST.optionDark : ST.optionLight;
      const controlsRow = h('div', { style: ST.controls, 'data-role': 'controls' },
        h('span', { style: ST.filterLabel }, t('workspaceLabel')),
        h('select', {
          style: { ...ST.select, colorScheme: scheme },
          value: workspace,
          title: t('filterHint'),
          'aria-label': t('workspaceLabel'),
          onChange: (event) => applyFilter({ workspace: event.target.value }),
        },
          h('option', { value: '', style: optionStyle }, t('allWorkspaces')),
          workspaceOptions.map((item) => h('option', {
            key: item.cwd,
            value: item.cwd,
            title: item.cwd,
            style: optionStyle,
          }, workspaceName(item)))),
        h('span', { style: { ...ST.filterLabel, marginLeft: 6 } }, t('rangeLabel')),
        RANGE_OPTIONS.map((option) => h('button', {
          key: option.value,
          type: 'button',
          style: range === option.value ? ST.chipHot : ST.chip,
          title: t('filterHint'),
          onClick: () => applyFilter({ range: option.value, from: '', to: '' }),
        }, t(option.key))),
        /* 快捷档只负责「近 N 天」；精确区间用两个原生日期框，选完立即生效。 */
        h('span', { style: { ...ST.filterLabel, marginLeft: 6 } }, t('customRange')),
        h('input', {
          type: 'date',
          style: { ...ST.date, colorScheme: scheme },
          value: from,
          max: to !== '' ? to : undefined,
          onChange: onFromChange,
          'aria-label': t('fromDate'),
          title: t('fromDate'),
        }),
        h('span', { style: { opacity: 0.35 } }, '~'),
        h('input', {
          type: 'date',
          style: { ...ST.date, colorScheme: scheme },
          value: to,
          min: from !== '' ? from : undefined,
          onChange: onToChange,
          'aria-label': t('toDate'),
          title: t('toDate'),
        }),
        h('span', { style: { ...ST.filterLabel, marginLeft: 6 } }, t('semanticLabel')),
        h('select', {
          style: { ...ST.select, colorScheme: scheme },
          value: semValue,
          disabled: !semAvailable,
          title: semAvailable ? t('semanticHint') : t('semanticUnavailable'),
          'aria-label': t('semanticLabel'),
          onChange: onSemChange,
        }, SEM_MODES.map((mode) => h('option', { key: mode, value: mode, style: optionStyle }, t(semChoice[mode])))),
      );

      /* 索引状态单独一行：重建按钮跟在「x 条消息 · 语义索引 x/x」之后，
       * 用户点之前先知道自己在对账什么。 */
      const statusBits = [];
      if (status !== null) {
        statusBits.push(t('docsCount', { n: fmtNum(status.docs ?? 0) }));
        const idx = status.index ?? {};
        if (indexRunning(status) && Number(idx.total) > 0) {
          statusBits.push(t('indexing', { done: fmtNum(idx.done ?? 0), total: fmtNum(idx.total ?? 0) }));
        }
        const vec = status.vectors;
        if (vec?.enabled === true) {
          const progress = vec.progress;
          if (vecEmbedding(progress)) {
            statusBits.push(t('semanticIndexing', {
              done: fmtNum(progress.chunks ?? 0),
              total: fmtNum(progress.chunksTotal ?? 0),
            }));
          } else {
            statusBits.push(t('semanticIndex', {
              done: fmtNum(vec.chunks ?? 0),
              total: fmtNum(progress?.chunksTotal ?? vec.chunks ?? 0),
            }));
          }
        }
      }
      const statusRow = h('div', { style: ST.statusRow, 'data-role': 'status' },
        h('span', { style: ST.statusText }, statusBits.join(' · ')),
        status === null ? null : h('button', {
          type: 'button',
          style: indexRunning(status) ? { ...ST.tinyBtn, opacity: 0.45, cursor: 'default' } : ST.tinyBtn,
          onClick: onReindex,
          title: t('reindexHint'),
          disabled: indexRunning(status),
        }, indexRunning(status) ? t('reindexing') : t('reindex')),
        /* 版本号留在状态行末尾：不抢搜索框的位置，也不被状态文字推到最右边 */
        versionChip,
      );

      const body = [];
      if (error !== null) body.push(h('div', { key: 'err', style: ST.error }, error));

      if (flat.length === 0 && error === null) {
        const narrowed = activeFilters.length > 0 ? ` ${t('emptyFiltered')}` : '';
        /* 只打了字还没点「搜索」：给出下一步动作，而不是假装「没有找到」。 */
        const message = text.trim() === ''
          ? t('hint')
          : (busy
            ? t('searching')
            : (query === ''
              ? t('pressSearch')
              : `${t('emptyFor', { q: query })} — ${t('emptyHint')}${narrowed}\n${t('emptySyntax')}`));
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
                [
                  cwdTail(group.cwd),
                  fmtTime(range !== 'all' && Number(group.lastTime) > 0 ? group.lastTime : group.createdAt),
                  docs.length > 0 ? t('docsCount', { n: docs.length }) : '',
                ]
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
                  doc.source === 'vec' ? h('span', { style: ST.semBadge }, t('semanticBadge')) : null,
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
        controlsRow,
        h('div', { style: ST.head, 'data-role': 'search' },
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
            style: busy || text.trim() === ''
              ? { ...ST.searchBtn, ...ST.searchBtnBusy }
              : ST.searchBtn,
            onClick: () => runSearch(text),
            title: t('searchHint'),
            disabled: busy || text.trim() === '',
          }, t('search')),
        ),
        statusRow,
        ...(meta.length === 0 ? [] : [h('div', { style: ST.meta },
          h('span', { key: 'meta' }, meta.join(' · ')))]),
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
