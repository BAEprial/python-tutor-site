/* PyFirst 私塾 · 集成配置层（公开版）
 *
 * 把「进度存到哪 / 笔记怎么导出 / 导师是谁」拆成三个可替换适配器。
 * 默认值与未改造版本完全一致：自动探测本地服务、笔记写 notes/、导师读 records/。
 *
 * 隐私约定：全部配置（含 API token）只存当前浏览器的 localStorage，
 * 不写进 state.json、不写进 records/、不进仓库，也不会随学习进度同步到任何服务端。
 * 换一台设备或换一个浏览器，配置不会跟着走，这是有意为之。
 */
(function () {
  'use strict';

  var CFG_KEY = 'pyfirst.integrations.v1';
  var SEC_KEY = 'pyfirst.secrets.v1';

  var DEFAULTS = {
    storage: { mode: 'auto', endpoint: '' },
    notes: { mode: 'obsidian', endpoint: '' },
    mentor: { mode: 'local', endpoint: '' }
  };

  var MODES = {
    storage: [
      ['auto', '自动（默认）', '优先探测本机服务，没运行就退回浏览器本地'],
      ['browser', '仅浏览器本地', '不发任何网络请求，进度只存这台设备'],
      ['cloud', '自建云端 API', '填 endpoint，需自行实现 /api/state 等接口']
    ],
    notes: [
      ['off', '关闭', '完全不导出笔记，也不生成 notes/'],
      ['download', '下载 Markdown', '打包成 .md 下载，不依赖 Obsidian'],
      ['obsidian', '写入 notes/（默认）', '由本地服务生成 Markdown 笔记库'],
      ['webhook', '推送到 endpoint', '把 { files } POST 给你自己的服务']
    ],
    mentor: [
      ['off', '关闭', '不显示导师回信'],
      ['local', '本地文件（默认）', '站点读 /api/mentor，WorkBuddy 读 records/'],
      ['agent', '自有 AI Agent', '填 endpoint，按下方协议收发']
    ]
  };

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function write(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* quota */ }
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeUrl(u) {
    var s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s.replace(/\/+$/, '') : '';
  }

  function get() {
    var cfg = clone(DEFAULTS);
    var saved = read(CFG_KEY);
    ['storage', 'notes', 'mentor'].forEach(function (k) {
      if (!saved[k] || typeof saved[k] !== 'object') return;
      Object.keys(saved[k]).forEach(function (f) {
        if (f !== 'token' && saved[k][f] !== undefined) cfg[k][f] = saved[k][f];
      });
    });
    var sec = read(SEC_KEY);
    cfg.storage.token = sec.storageToken || '';
    cfg.notes.token = sec.notesToken || '';
    cfg.mentor.token = sec.mentorToken || '';
    return cfg;
  }

  function set(next) {
    /* 非敏感配置与密钥分开存：即便有人导出 state.json 也拿不到 token */
    write(CFG_KEY, {
      storage: { mode: next.storage.mode, endpoint: next.storage.endpoint },
      notes: { mode: next.notes.mode, endpoint: next.notes.endpoint },
      mentor: { mode: next.mentor.mode, endpoint: next.mentor.endpoint }
    });
    write(SEC_KEY, {
      storageToken: next.storage.token || '',
      notesToken: next.notes.token || '',
      mentorToken: next.mentor.token || ''
    });
  }

  function reset() {
    try { localStorage.removeItem(CFG_KEY); localStorage.removeItem(SEC_KEY); }
    catch (e) { /* ignore */ }
  }

  /* ---------------- 适配器 1：进度存到哪 ---------------- */
  var StorageAdapter = {
    mode: function () { return get().storage.mode; },
    bases: function () {
      var c = get();
      if (c.storage.mode === 'browser') return [];
      if (c.storage.mode === 'cloud') {
        var u = safeUrl(c.storage.endpoint);
        return u ? [u] : [];
      }
      return ['', 'http://127.0.0.1:8765', 'http://localhost:8765'];
    },
    headers: function () {
      var c = get();
      return (c.storage.mode === 'cloud' && c.storage.token)
        ? { Authorization: 'Bearer ' + c.storage.token } : {};
    },
    needsAuth: function () {
      var c = get();
      return c.storage.mode === 'cloud' && !!c.storage.token;
    },
    label: function () {
      var m = get().storage.mode;
      return m === 'browser' ? '仅本机浏览器' : (m === 'cloud' ? '自建云端' : '本地服务');
    }
  };

  /* ---------------- 适配器 2：笔记怎么导出 ---------------- */
  var NotesAdapter = {
    publish: async function (files, ctx) {
      var c = get();
      var mode = c.notes.mode;
      if (mode === 'off') return { ok: true, message: '笔记导出已关闭，可在「设置」里改' };
      if (mode === 'download' || (mode === 'obsidian' && !ctx.online)) {
        var bundle = '';
        Object.keys(files).forEach(function (name) {
          bundle += '\n\n===== ' + name + ' =====\n\n' + files[name];
        });
        ctx.download('notes-bundle.md', bundle, 'text/markdown;charset=utf-8');
        return { ok: true, message: mode === 'download'
          ? '已下载 Markdown 笔记合集' : '本地服务未运行，已改为下载笔记合集' };
      }
      if (mode === 'obsidian') {
        try {
          var res = await fetch(ctx.apiUrl('/api/notes/sync'), {
            method: 'POST', headers: ctx.headers(), body: JSON.stringify({ files: files })
          });
          if (!res.ok) return { ok: false, message: '同步失败（HTTP ' + res.status + '）' };
          var j = await res.json();
          return { ok: true, message: '已同步 ' + j.written + ' 个 Markdown 文件到 notes/' };
        } catch (e) { return { ok: false, message: '同步失败：' + e.message }; }
      }
      if (mode === 'webhook') {
        var u = safeUrl(c.notes.endpoint);
        if (!u) return { ok: false, message: '请先在「设置」里填笔记 endpoint' };
        try {
          var h = { 'Content-Type': 'application/json' };
          if (c.notes.token) h.Authorization = 'Bearer ' + c.notes.token;
          var r = await fetch(u, {
            method: 'POST', headers: h, body: JSON.stringify({ files: files })
          });
          return r.ok ? { ok: true, message: '已推送到你的笔记服务' }
            : { ok: false, message: '推送失败（HTTP ' + r.status + '）' };
        } catch (e) { return { ok: false, message: '推送失败：' + e.message + '（检查 CORS）' }; }
      }
      return { ok: false, message: '未知笔记模式' };
    }
  };

  /* ---------------- 适配器 3：导师是谁 ----------------
   * 自有 Agent 的最小协议：
   *   GET  endpoint            -> { replies: [{ text, ts }] } 或 { reply: "..." }
   *   POST endpoint            <- { day, lessonId, question, kind, drafts, attempts }
   * 浏览器直连第三方服务需对方允许 CORS；不通时可在设置里关掉，改用复制/粘贴。
   */
  var MentorAdapter = {
    load: async function (ctx) {
      var c = get();
      if (c.mentor.mode === 'off') return [];
      if (c.mentor.mode === 'agent') {
        var u = safeUrl(c.mentor.endpoint);
        if (!u) return [];
        try {
          var h = {};
          if (c.mentor.token) h.Authorization = 'Bearer ' + c.mentor.token;
          var r = await fetch(u, { method: 'GET', headers: h, cache: 'no-store' });
          if (!r.ok) return [];
          var j = await r.json();
          if (Array.isArray(j.replies)) return j.replies;
          if (j.reply) return [{ text: String(j.reply), ts: new Date().toISOString() }];
          return [];
        } catch (e) { return []; }
      }
      var data = await ctx.apiGet('/api/mentor');
      return (data && Array.isArray(data.replies)) ? data.replies : [];
    },
    ask: async function (payload) {
      var c = get();
      if (c.mentor.mode !== 'agent') return { ok: true, message: 'local' };
      var u = safeUrl(c.mentor.endpoint);
      if (!u) return { ok: false, message: '未配置导师 endpoint' };
      try {
        var h = { 'Content-Type': 'application/json' };
        if (c.mentor.token) h.Authorization = 'Bearer ' + c.mentor.token;
        var r = await fetch(u, { method: 'POST', headers: h, body: JSON.stringify(payload) });
        return { ok: r.ok, message: r.ok ? '已发给你的 AI 导师' : '发送失败（HTTP ' + r.status + '）' };
      } catch (e) { return { ok: false, message: '发送失败，检查 CORS 或改用复制/粘贴' }; }
    }
  };

  var ReportAdapter = {
    write: async function (markdown, ctx) {
      if (!ctx.online) {
        ctx.download('学习周报.md', markdown, 'text/markdown;charset=utf-8');
        return { ok: true, message: '本地服务未运行，已改为下载周报 Markdown' };
      }
      try {
        var r = await fetch(ctx.apiUrl('/api/report'), {
          method: 'POST', headers: ctx.headers(), body: JSON.stringify({ markdown: markdown })
        });
        return r.ok ? { ok: true, message: '周报已写入 records/mentor-brief.md' }
          : { ok: false, message: '写入失败（HTTP ' + r.status + '）' };
      } catch (e) { return { ok: false, message: '写入失败：' + e.message }; }
    }
  };

  /* ---------------- 设置面板 ---------------- */
  var panel = null;

  function selectHtml(group, cfg) {
    return '<select class="cfg-input" data-cfg="' + group + '-mode">' +
      MODES[group].map(function (m) {
        return '<option value="' + m[0] + '"' + (cfg[group].mode === m[0] ? ' selected' : '') +
          '>' + esc(m[1]) + '</option>';
      }).join('') + '</select>';
  }

  function groupHtml(group, title, cfg) {
    return '<div class="cfg-group">' +
      '<div class="cfg-row"><label class="cfg-label">' + title + '</label>' + selectHtml(group, cfg) + '</div>' +
      '<div class="cfg-row"><label class="cfg-label">Endpoint</label>' +
      '<input class="cfg-input" type="url" data-cfg="' + group + '-endpoint" placeholder="https://…"' +
      ' value="' + esc(cfg[group].endpoint) + '"></div>' +
      '<div class="cfg-row"><label class="cfg-label">Token（可选）</label>' +
      '<input class="cfg-input" type="password" data-cfg="' + group + '-token" placeholder="只存本机"' +
      ' value="' + esc(cfg[group].token) + '"></div>' +
      '<p class="cfg-hint">' + MODES[group].map(function (m) {
        return esc(m[0]) + '：' + esc(m[2]);
      }).join('　·　') + '</p></div>';
  }

  function build() {
    panel = document.createElement('div');
    panel.className = 'cfg-mask';
    panel.setAttribute('data-settings-close', '');
    panel.innerHTML =
      '<div class="cfg-panel" role="dialog" aria-label="集成设置">' +
      '<div class="cfg-head"><h3>集成设置</h3>' +
      '<button class="btn ghost sm" data-settings-close>关闭</button></div>' +
      '<p class="cfg-hint">默认值开箱即用，每一项都能改。配置只存在这台设备的浏览器里，' +
      '不会写进 state.json、records/ 或仓库；换设备不会跟着走。</p>' +
      '<div id="cfg-body"></div>' +
      '<div class="cfg-actions">' +
      '<button class="btn sm" data-settings-reset>恢复默认</button>' +
      '<span class="cfg-status" id="cfg-status"></span>' +
      '<button class="btn sm primary" data-settings-save>保存</button>' +
      '</div></div>';
    document.body.appendChild(panel);
  }

  function fill() {
    var cfg = get();
    document.getElementById('cfg-body').innerHTML =
      groupHtml('storage', '进度存储', cfg) +
      groupHtml('notes', '笔记导出', cfg) +
      groupHtml('mentor', '导师', cfg) +
      '<div class="cfg-group"><p class="cfg-hint">' +
      '自有 AI Agent 协议：GET endpoint 返回 <code>{ replies: [{ text, ts }] }</code>；' +
      '发布提问时 POST <code>{ day, lessonId, question, kind, drafts, attempts }</code>。' +
      '浏览器直连第三方服务需对方允许 CORS，不通时请把导师设为「关闭」或「本地文件」。' +
      '</p></div>';
    var s = document.getElementById('cfg-status');
    if (s) s.textContent = '';
  }

  function open() {
    if (!panel) build();
    fill();
    panel.classList.add('open');
  }
  function close() { if (panel) panel.classList.remove('open'); }

  function save() {
    var cfg = get();
    ['storage', 'notes', 'mentor'].forEach(function (g) {
      ['mode', 'endpoint', 'token'].forEach(function (f) {
        var el = document.querySelector('[data-cfg="' + g + '-' + f + '"]');
        if (el) cfg[g][f] = el.value.trim();
      });
    });
    if (cfg.storage.mode === 'cloud' && !safeUrl(cfg.storage.endpoint)) {
      document.getElementById('cfg-status').textContent = '云端模式需要 http(s) endpoint';
      return;
    }
    if (cfg.notes.mode === 'webhook' && !safeUrl(cfg.notes.endpoint)) {
      document.getElementById('cfg-status').textContent = '推送模式需要 http(s) endpoint';
      return;
    }
    if (cfg.mentor.mode === 'agent' && !safeUrl(cfg.mentor.endpoint)) {
      document.getElementById('cfg-status').textContent = 'Agent 模式需要 http(s) endpoint';
      return;
    }
    set(cfg);
    document.getElementById('cfg-status').textContent =
      '已保存。存储模式改动刷新页面后生效 →';
  }

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-settings-open]')) { open(); return; }
    if (e.target.closest('[data-settings-save]')) { save(); return; }
    if (e.target.closest('[data-settings-reset]')) {
      reset(); fill();
      document.getElementById('cfg-status').textContent = '已恢复默认，点「保存」确认';
      return;
    }
    if (e.target.hasAttribute && e.target.hasAttribute('data-settings-close')) close();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });

  window.TUTOR_DEFAULTS = DEFAULTS;
  window.Integrations = {
    get: get, set: set, reset: reset,
    storage: StorageAdapter,
    notes: NotesAdapter,
    mentor: MentorAdapter,
    report: ReportAdapter,
    ui: { open: open, close: close }
  };
})();
