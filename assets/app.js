/* PyFirst 私塾 · 前端主逻辑
 * 页面：home / catalog / lesson / playground / review / notes / progress
 * 数据：localStorage 双写 + 可选本地服务器（server.py）持久化到 records/state.json
 */
(function () {
  'use strict';

  const C = window.COURSE;
  const Q = window.QB;
  const KEY = 'pyfirst.state.v2';
  const API = { state: '/api/state', notes: '/api/notes/sync', report: '/api/report', mentor: '/api/mentor' };
  /* 集成层由 assets/config.js 提供；万一没加载，全部退回未改造版本的行为 */
  const I = () => window.Integrations || null;
  function apiBases() {
    const x = I();
    return (x && x.storage) ? x.storage.bases()
      : ['', 'http://127.0.0.1:8765', 'http://localhost:8765'];
  }
  function authHeaders() {
    const x = I();
    return (x && x.storage) ? x.storage.headers() : {};
  }
  function apiHeaders(extra) {
    return Object.assign({ 'Content-Type': 'application/json' }, authHeaders(), extra || {});
  }
  const NAV = [
    ['home', 'index.html', '今日'],
    ['catalog', 'catalog.html', '课程目录'],
    ['lesson', 'lesson.html', '这一节'],
    ['playground', 'playground.html', '编程实验室'],
    ['review', 'review.html', '错题册'],
    ['notes', 'notes.html', '笔记册'],
    ['progress', 'progress.html', '学习进度']
  ];

  const blankState = () => ({
    version: 2,
    updatedAt: new Date().toISOString(),
    profile: { name: '我', startDate: todayStr(), dailyMinutes: C.meta.dailyMinutes },
    settings: { skipIntro: false, showExpected: false, strictScope: true },
    progress: {},
    sessions: {},
    attempts: [],
    scopeFlags: {},
    wrongBook: [],
    notes: {},
    drafts: {},
    comments: [],
    snippets: [],
    activity: {},
    mentorSeen: 0
  });

  let state = blankState();
  let mentorReplies = [];
  let online = false;
  let currentLesson = null;
  let currentQuiz = null;
  let saveTimer = null;

  /* ---------------- 工具 ---------------- */
  function todayStr(d) {
    const x = d || new Date();
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }
  function fmt(ts, withTime) {
    if (!ts) return '—';
    const d = new Date(ts);
    const base = todayStr(d);
    return withTime ? base + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') : base;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function toast(msg) {
    document.querySelectorAll('.toast').forEach(n => n.remove());
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function lessonBy(id) { return C.lessons.find(l => l.id === id) || null; }
  function lessonByDay(n) { return C.lessons[Math.max(0, Math.min(C.lessons.length - 1, n - 1))] || C.lessons[0]; }
  function nextLesson() {
    return C.lessons.find(l => !state.progress[l.id] || state.progress[l.id].status !== 'done') || C.lessons[C.lessons.length - 1];
  }
  function sessionOf(id) {
    if (!state.sessions[id]) state.sessions[id] = { mcq: {}, lab: {}, feynmanSelf: null };
    return state.sessions[id];
  }
  function markActivity(kind, correct) {
    const d = todayStr();
    if (!state.activity[d]) state.activity[d] = { lessons: 0, attempts: 0, correct: 0 };
    const a = state.activity[d];
    if (kind === 'lesson') a.lessons += 1;
    else { a.attempts += 1; if (correct) a.correct += 1; }
  }
  function streakDays() {
    let n = 0;
    const d = new Date();
    for (let i = 0; i < 400; i++) {
      const key = todayStr(d);
      const a = state.activity[key];
      if (a && (a.attempts > 0 || a.lessons > 0)) n += 1;
      else if (i > 0 || !a) { if (i === 0) { d.setDate(d.getDate() - 1); continue; } break; }
      d.setDate(d.getDate() - 1);
    }
    return n;
  }
  function stats() {
    const done = Object.values(state.progress).filter(p => p.status === 'done').length;
    const counted = state.attempts.filter(a => !a.voided);
    const attempts = counted.length;
    const correct = counted.filter(a => a.correct).length;
    return { done, attempts, correct, rate: attempts ? Math.round(correct / attempts * 100) : 0, streak: streakDays() };
  }
  function baseIdOf(a) { return a.baseId || String(a.qid || '').split('@')[0]; }
  function seenCounts() {
    const m = {};
    state.attempts.forEach(a => {
      const k = baseIdOf(a);
      if (k) m[k] = (m[k] || 0) + 1;
    });
    return m;
  }
  function quizFor(lesson) {
    const cutoff = Date.now() - 3 * 86400 * 1000;
    const recent = state.attempts
      .filter(a => new Date(a.ts).getTime() >= cutoff)
      .map(baseIdOf);
    return Q.pickDaily(lesson, seenCounts(), {
      preview: !state.settings.strictScope,
      recent: recent,
      flagged: Object.keys(state.scopeFlags || {})
    });
  }
  function scopeRow(q) {
    if (!q || q.unlock === undefined) return '';
    const flagged = !!(state.scopeFlags || {})[q.id];
    return '<div class="scope-row"><span class="tiny muted">本题用到：' +
      esc(q.reqLabel || '本节内容') + ' · Day ' + q.unlock + ' 起可答' +
      (q.scaffold ? ' · 入门脚手架题，照着敲即可' : '') + '</span>' +
      '<button class="btn sm ghost" data-action="scope-flag" data-qid="' + esc(q.id) + '">' +
      (flagged ? '✓ 已标记没学过（点此取消）' : '这题没学过？') + '</button></div>';
  }

  /* 作废「历史上曾超纲」的错题。
   * 早期版本的组卷器会把尚未教到的知识点提前出成题（例如 Day 1 考 CPython / PEP 8）。
   * 这些题后来已被组卷硬约束剔除，但错题册里的旧记录仍在。此处按
   * 「题目解锁日 > 该次作答所在课程日」判定，幂等地把它们移出错题册并从正确率里排除；
   * 原始 attempts 记录保留，只是标记 voided，学习历史不丢失。 */
  let retiredCount = 0;
  const UNLOCK_BY_ID = (function () {
    const m = {};
    [].concat(Q.MCQ || [], Q.GEN || [], Q.LAB || [], Q.ENTRY_MCQ || [], Q.ENTRY_LAB || [])
      .forEach(q => { if (q && q.id && typeof q.unlock === 'number') m[q.id] = q.unlock; });
    return m;
  })();
  function retireOutOfScope(s) {
    const dayOf = {};
    (C.lessons || []).forEach(l => { dayOf[l.id] = l.day; });
    const retiredKeys = {};
    (s.wrongBook || []).forEach(w => {
      const day = dayOf[w.lessonId];
      const unlock = UNLOCK_BY_ID[w.baseId];
      if (day === undefined || unlock === undefined || unlock <= day) return;
      retiredKeys[w.baseId + '@' + w.lessonId] = true;
      if (!w.retired) {
        w.mastered = true;
        w.retired = true;
        w.note = '已作废：该题在 Day ' + day + ' 出现时超出教学范围（所需知识点 Day ' +
          unlock + ' 才学），导师复核后移出错题册。';
        retiredCount += 1;
      }
    });
    (s.attempts || []).forEach(a => {
      if (!a.voided && retiredKeys[baseIdOf(a) + '@' + a.lessonId]) a.voided = true;
    });
  }

  // 兼容旧存档：新增的 settings / scopeFlags 字段不能被旧对象整体覆盖掉
  function normalizeState(raw) {
    const base = blankState();
    const s = Object.assign(base, raw || {});
    s.settings = Object.assign(base.settings, s.settings || {});
    if (!s.scopeFlags || typeof s.scopeFlags !== 'object') s.scopeFlags = {};
    if (!s.drafts || typeof s.drafts !== 'object') s.drafts = {};
    if (!s.notes || typeof s.notes !== 'object') s.notes = {};
    if (!s.sessions || typeof s.sessions !== 'object') s.sessions = {};
    retireOutOfScope(s);
    return s;
  }

  /* ---------------- 状态存储（后端由 assets/config.js 的 StorageAdapter 决定） ---------------- */
  let apiBase = '';
  let dirty = false;
  let saving = false;
  let saveFailed = false;
  let lastSavedAt = '';

  function apiUrl(p) { return apiBase + p; }

  /* 空白页面刚创建时 updatedAt 是「现在」，只看时间戳会让它显得比服务器
     旧数据更新。所以冲突判定一律比「实质内容量」，时间戳只在相等时用。 */
  function richness(s) {
    if (!s) return 0;
    const textLen = o => Object.values(o || {}).reduce((a, v) => {
      if (v && typeof v === 'object') return a + textLen(v);
      return a + String(v == null ? '' : v).length;
    }, 0);
    return (s.attempts || []).length * 10 +
      Object.keys(s.progress || {}).length * 200 +
      (s.wrongBook || []).length * 3 +
      (s.comments || []).length * 10 +
      (s.snippets || []).length * 5 +
      textLen(s.notes) + textLen(s.drafts);
  }

  /* 页面可能从 http://127.0.0.1:8765 / 编辑器预览面板 / file:// 打开，
     三者的 localStorage 互不相通。逐个试 API 地址，找到真正持有
     records/state.json 的服务，所有入口就共享同一份进度。 */
  async function apiGet(p) {
    for (const base of apiBases()) {
      try {
        const res = await fetch(base + p, { cache: 'no-store', headers: authHeaders() });
        if (!res.ok) continue;
        const data = await res.json();
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          apiBase = base;
          return data;
        }
      } catch (e) { /* 换下一个来源 */ }
    }
    return null;
  }

  const Store = {
    async init() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) state = normalizeState(JSON.parse(raw));
      } catch (e) { console.warn('local state broken', e); }

      const remote = await apiGet(API.state);
      online = !!remote;
      if (remote) {
        const lw = richness(state), rw = richness(remote);
        if (rw > lw || (rw === lw && remote.updatedAt && state.updatedAt &&
                        remote.updatedAt > state.updatedAt)) {
          state = normalizeState(remote);
        }
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
        // 本地比服务器更完整（例如先前离线学过）：回推补齐，服务端会合并
        if (lw > rw) { dirty = true; await this.push(); }
      } else {
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
        if (richness(state) > 0) dirty = true;
      }
      this.pill();
      this.startAutoFlush();
    },
    pill() {
      const el = document.getElementById('sync-pill');
      if (!el) return;
      const x = I();
      const localOnly = !!(x && x.storage && x.storage.mode() === 'browser');
      const dot = localOnly ? 'on' : (!online ? 'off' : (saveFailed ? 'warn' : (saving || dirty ? 'busy' : 'on')));
      let text;
      if (localOnly) text = '已保存在本机浏览器';
      else if (!online) text = '离线暂存 · 等待服务';
      else if (saveFailed) text = '保存失败 · 自动重试中';
      else if (saving || dirty) text = '自动保存中…';
      else text = '已自动保存' + (lastSavedAt ? ' ' + lastSavedAt : '');
      el.innerHTML = '<span class="dot ' + dot + '"></span>' + text;
      el.title = localOnly
        ? '按「设置 → 进度存储 → 仅浏览器本地」运行：不发任何网络请求'
        : (online
          ? '每次操作实时写入 records/state.json，WorkBuddy 可直接读取；输入框里没点保存的内容也会同步'
          : '暂存浏览器；请双击桌面的「Python 私塾」快捷方式，它会启动服务并打开网站');
    },
    async push() {
      if (!online || saving) return;
      const snapshot = JSON.stringify(state);
      saving = true; dirty = false; this.pill();
      try {
        const res = await fetch(apiUrl(API.state), {
          method: 'POST', headers: apiHeaders(), body: snapshot
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        lastSavedAt = new Date().toTimeString().slice(0, 8);
        saveFailed = false;
      } catch (e) { dirty = true; saveFailed = true; }
      finally { saving = false; this.pill(); }
    },
    save(immediate) {
      state.updatedAt = new Date().toISOString();
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
      dirty = true;
      clearTimeout(saveTimer);
      this.pill();
      if (immediate && online) this.push();
      else if (online) saveTimer = setTimeout(() => this.push(), 250);
    },
    /* 仅用于「清空数据 / 导入备份」这类用户明确要求整体替换的场景 */
    async replace() {
      state.updatedAt = new Date().toISOString();
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
      if (!online) return;
      try {
        await fetch(apiUrl(API.state) + '?replace=1', {
          method: 'POST', headers: apiHeaders(),
          body: JSON.stringify(state)
        });
      } catch (e) { /* ignore */ }
      lastSavedAt = new Date().toTimeString().slice(0, 8);
      dirty = false; saveFailed = false; this.pill();
    },
    /* 另一个窗口刚学的进度，回到本页面时立刻追平 */
    async resync() {
      const remote = await apiGet(API.state);
      if (!remote) { online = false; this.pill(); return; }
      online = true;
      const ra = (remote.attempts || []).length, la = (state.attempts || []).length;
      const rp = Object.keys(remote.progress || {}).length;
      const lp = Object.keys(state.progress || {}).length;
      if (ra > la || rp > lp) {
        captureDrafts();
        const liveNotes = JSON.parse(JSON.stringify(state.notes || {}));
        const liveDrafts = JSON.parse(JSON.stringify(state.drafts || {}));
        state = normalizeState(remote);
        overlayText(state.notes, liveNotes);
        overlayText(state.drafts, liveDrafts);
        try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
        dirty = true;
        renderCurrent();
        toast('已同步到最新学习进度');
      }
      this.pill();
      if (dirty) this.push();
    },
    startAutoFlush() {
      setInterval(() => {
        if (!online) {
          apiGet(API.state).then(r => {
            if (r) { online = true; saveFailed = false; this.pill(); }
          });
          return;
        }
        if (dirty && !saving) this.push();
      }, 2500);
      const flush = () => {
        if (!online || !dirty) return;
        const payload = JSON.stringify(state);
        try {
          const needsAuth = !!(I() && I().storage && I().storage.needsAuth());
          if (navigator.sendBeacon && !needsAuth) {
            const blob = new Blob([payload], { type: 'text/plain;charset=UTF-8' });
            if (navigator.sendBeacon(apiUrl(API.state), blob)) dirty = false;
          } else {
            fetch(apiUrl(API.state), {
              method: 'POST', headers: apiHeaders(),
              body: payload, keepalive: true
            }).catch(() => {});
            dirty = false;
          }
        } catch (e) { /* 尽力而为；正常自动保存已经落盘 */ }
      };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush(); else this.resync();
      });
      window.addEventListener('pagehide', flush);
      window.addEventListener('beforeunload', flush);
    },
    async loadMentor() {
      const x = I();
      mentorReplies = (x && x.mentor)
        ? await x.mentor.load({ apiGet })
        : ((await apiGet(API.mentor)) || {}).replies || [];
    }
  };

  function draftKey(kind, lessonId) {
    return kind + '@' + (lessonId || (currentLesson && currentLesson.id) || '');
  }
  function overlayText(target, src) {
    Object.keys(src || {}).forEach(k => {
      const v = src[k];
      if (v && typeof v === 'object') {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        overlayText(target[k], v);
      } else if (String(v || '').trim()) target[k] = v;
    });
  }
  function renderCurrent() {
    const page = document.body.dataset.page || 'home';
    const params = new URLSearchParams(location.search);
    const views = { home: viewHome, catalog: viewCatalog, lesson: viewLesson,
      playground: viewPlayground, review: viewReview, notes: viewNotes, progress: viewProgress };
    (views[page] || viewHome)(params);
  }
  /* 重绘/关闭页面前，把页面上所有正在编辑但没点保存的文字收进 state */
  function captureDrafts() {
    if (!currentLesson) return;
    const id = currentLesson.id;
    const sess = sessionOf(id);
    document.querySelectorAll('.lab-item').forEach(it => {
      const ed = it.querySelector('.lab-editor');
      const q = (currentQuiz.lab || []).find(x => x.uid === it.dataset.q);
      if (ed && q) sess.lab[q.uid] = Object.assign({}, sess.lab[q.uid], { code: ed.value });
    });
    const map = { 'feynman-input': 'feynman', 'note-input': 'note', 'note-code': 'code' };
    const n = state.notes[id] || {};
    Object.keys(map).forEach(elId => {
      const el = document.getElementById(elId);
      if (el) n[map[elId]] = el.value;
    });
    state.notes[id] = n;
    const ci = document.getElementById('comment-input');
    if (ci) state.drafts[draftKey('comment', id)] = ci.value;
    const ck = document.getElementById('comment-kind');
    if (ck) state.drafts[draftKey('commentKind', id)] = ck.value;
    const pg = document.getElementById('pg-editor');
    if (pg) state.drafts.playground = pg.value;
  }

  /* ---------------- 记录 ---------------- */
  function recordAnswer(q, correct, payload) {
    const lesson = currentLesson;
    const item = {
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      ts: new Date().toISOString(), lessonId: lesson ? lesson.id : '',
      lessonTitle: lesson ? lesson.title : '', qid: q.uid, baseId: q.id,
      type: q.type, correct, level: q.level, tags: q.tags,
      stem: q.type === 'mcq' ? q.stem : q.title,
      answer: payload || '', code: payload && q.type === 'lab' ? payload : ''
    };
    state.attempts.push(item);
    markActivity('attempt', correct);
    if (!correct) {
      let w = state.wrongBook.find(x => x.baseId === q.id);
      if (!w) {
        w = { baseId: q.id, qid: q.uid, lessonId: item.lessonId, type: q.type,
          stem: item.stem, tags: q.tags, wrongCount: 0, lastWrong: item.ts, mastered: false, note: '' };
        state.wrongBook.push(w);
      }
      w.wrongCount += 1; w.lastWrong = item.ts; w.mastered = false;
    } else {
      const w = state.wrongBook.find(x => x.baseId === q.id && !x.mastered);
      if (w) w.mastered = true;
    }
    Store.save();
  }

  /* ---------------- 报告与笔记 ---------------- */
  function buildReport() {
    const s = stats();
    const lines = [
      '# Python 学习周报 · 给导师（WorkBuddy）',
      '',
      '- 生成时间：' + fmt(new Date().toISOString(), true),
      '- 课程来源：' + C.meta.sourceName + '（' + C.meta.source + '，免费）',
      '- 计划：' + C.meta.totalDays + ' 天 / 每天 ' + C.meta.dailyMinutes + ' 分钟 / 5 选择 + 3 编程',
      '',
      '## 一、总体进度',
      '',
      '| 指标 | 数值 |', '| --- | --- |',
      '| 已完成课程 | ' + s.done + ' / ' + C.meta.totalDays + ' |',
      '| 累计做题 | ' + s.attempts + ' |',
      '| 总正确率 | ' + s.rate + '% |',
      '| 连续学习天数 | ' + s.streak + ' |',
      '| 错题册（未掌握） | ' + state.wrongBook.filter(w => !w.mastered).length + ' |',
      '',
      '## 二、最近完成的课程',
      ''
    ];
    const done = C.lessons.filter(l => state.progress[l.id] && state.progress[l.id].status === 'done').slice(-10);
    if (!done.length) lines.push('（暂无）');
    done.forEach(l => {
      const p = state.progress[l.id];
      lines.push('- Day ' + l.day + ' · ' + l.title + '（' + fmt(p.completedAt) + '，得分 ' + p.score + ' 分）');
    });
    lines.push('', '## 三、未掌握的错题（按知识点）', '');
    const tags = {};
    state.wrongBook.filter(w => !w.mastered).forEach(w => (w.tags || []).forEach(t => { tags[t] = (tags[t] || 0) + 1; }));
    const topTags = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!topTags.length) lines.push('（暂无，很棒）');
    topTags.forEach(([t, n]) => lines.push('- `' + t + '`：' + n + ' 题'));
    lines.push('', '## 四、费曼复述（最近 5 条）', '');
    const notes = Object.entries(state.notes).filter(([, n]) => n.feynman).slice(-5);
    if (!notes.length) lines.push('（暂无）');
    notes.forEach(([id, n]) => {
      const l = lessonBy(id);
      lines.push('### Day ' + (l ? l.day : '?') + ' · ' + (l ? l.title : id), '', n.feynman, '');
    });
    lines.push('## 五、留给导师的问题', '');
    const pending = state.comments.filter(c => c.pending).slice(-20);
    if (!pending.length) lines.push('（暂无）');
    pending.forEach(c => {
      const l = lessonBy(c.lessonId);
      lines.push('- [' + (l ? 'Day ' + l.day : c.lessonId) + '] ' + c.text.replace(/\n/g, ' '));
    });
    lines.push('', '## 六、超纲反馈（我在题目上点过「没学过」）', '');
    const flags = Object.entries(state.scopeFlags || {});
    if (!flags.length) lines.push('（暂无。若某题出现没讲过的名词，请在学习页点「这题没学过」，导师会来核对解锁日。）');
    flags.forEach(([qid, f]) => lines.push('- `' + qid + '` · 第 ' + f.day + ' 天 · ' + fmt(f.ts, true) + ' → 请导师检查该题是否设早了'));
    lines.push('', '## 七、实时草稿（没点保存的内容也在这里）', '');
    const drafts = Object.entries(state.drafts || {}).filter(([, v]) => String(v || '').trim());
    if (!drafts.length) lines.push('（暂无）');
    drafts.forEach(([k, v]) => lines.push('- `' + k + '`：' + String(v).replace(/\n/g, ' ')));
    lines.push('', '---', '',
      '> 导师可直接读取 `records/state.json` 获取完整明细；未提交草稿另见 `records/drafts.md`；笔记册在 `notes/`。', '');
    return lines.join('\n');
  }

  function buildNoteMd(l) {
    const n = state.notes[l.id] || {};
    const sess = state.sessions[l.id] || {};
    const p = state.progress[l.id] || {};
    const lines = [
      '---',
      'day: ' + l.day,
      'title: "' + l.title.replace(/"/g, '') + '"',
      'chapter: "' + l.chapter + ' ' + l.chapterTitle + '"',
      'status: ' + (p.status || 'not-started'),
      'difficulty: ' + l.difficulty,
      'tags: [python, ' + l.group + ', ' + l.tags.slice(0, 3).join(', ') + ']',
      'source: ' + l.url,
      '---', '',
      '# Day ' + String(l.day).padStart(3, '0') + ' · ' + l.title, '',
      '> [!info] 原文', '> ' + l.url + '（廖雪峰官方网站 · 免费）', '',
      '## 第一性原理', '',
      '**本质问题**：' + l.why, '',
      '**最小事实**', ''
    ];
    l.points.forEach(x => lines.push('- ' + x));
    lines.push('', '**推导提问**：从上面这些最小事实出发，为什么「' + l.title + '」需要这样的设计？', '',
      '**边界 / 易错**：' + l.boundary, '',
      '## 费曼复述', '', (n.feynman || '（还没写，试着不看笔记讲一遍：' + l.feynman + '）'), '',
      '## 我的笔记', '', (n.note || '（待补充）'), '',
      '## 代码与实验', '', '```python', (n.code || l.example.code), '```', '',
      '预期输出：', '', '```text', l.example.output, '```', '',
      '## 规范卡', '', '- ' + l.norm, '',
      '## 做题记录', ''
    );
    const atts = state.attempts.filter(a => a.lessonId === l.id);
    if (!atts.length) lines.push('（暂无）');
    atts.forEach(a => lines.push('- ' + (a.correct ? '✅' : '❌') + ' ' + (a.type === 'mcq' ? '选择' : '编程') + ' · `' + esc(a.baseId) + '` · ' + fmt(a.ts, true)));
    lines.push('', '## 评论 / 提问', '');
    const cs = state.comments.filter(c => c.lessonId === l.id);
    if (!cs.length) lines.push('（暂无）');
    cs.forEach(c => lines.push('- [' + c.kind + '] ' + c.text.replace(/\n/g, ' ')));
    const replies = mentorReplies.filter(r => r.lessonId === l.id);
    if (replies.length) {
      lines.push('', '## 导师回信', '');
      replies.forEach(r => lines.push('> ' + r.text.replace(/\n/g, '\n> ')));
    }
    lines.push('', '---', '', '[[笔记册首页]] · [[错题册]] · [[' + (l.day > 1 ? 'Day-' + String(l.day - 1).padStart(3, '0') : '笔记册首页') + ']]', '');
    return lines.join('\n');
  }

  function buildIndexMd() {
    const s = stats();
    return [
      '---', 'tags: [python, 笔记册首页]', '---', '',
      '# Python 私塾 · 笔记册', '',
      '用 Obsidian 打开本文件夹即为知识库；每学完一节会生成一个 `Day-xxx.md`。', '',
      '- 原文：' + C.meta.sourceName + ' [' + C.meta.source + '](' + C.meta.source + ')（免费）',
      '- 进度：' + s.done + ' / ' + C.meta.totalDays + ' 天，正确率 ' + s.rate + '%',
      '- 方法：第一性原理 + 费曼学习法 + 间隔重复', '',
      '## 目录', ''
    ].concat(C.lessons.map(l => '- [[' + 'Day-' + String(l.day).padStart(3, '0') + ']] ' + l.num + ' ' + l.title +
      (state.progress[l.id] && state.progress[l.id].status === 'done' ? ' ✅' : '')))
      .concat(['', '## 常用', '', '- [[错题册]]', '- [[学习周报]]', '- [[导师答疑]]', '']).join('\n');
  }

  function buildWrongMd() {
    const lines = ['---', 'tags: [python, 错题册]', '---', '', '# 错题册', ''];
    if (!state.wrongBook.length) lines.push('（暂无错题，继续保持）');
    state.wrongBook.forEach(w => {
      const l = lessonBy(w.lessonId);
      lines.push('## ' + (w.mastered ? '✅' : '❌') + ' ' + w.stem, '',
        '- 来源：' + (l ? '[[Day-' + String(l.day).padStart(3, '0') + ']] ' + l.title : w.lessonId),
        '- 知识点：' + (w.tags || []).join(' / '),
        '- 错误次数：' + w.wrongCount + '，最近：' + fmt(w.lastWrong),
        '- 我的订正：' + (w.note || '（待写）'), '');
    });
    return lines.join('\n');
  }

  async function syncNotes() {
    const payload = { files: {} };
    payload.files['笔记册首页.md'] = buildIndexMd();
    payload.files['错题册.md'] = buildWrongMd();
    payload.files['学习周报.md'] = buildReport();
    payload.files['导师答疑.md'] = ['# 导师答疑', '']
      .concat(mentorReplies.length ? mentorReplies.map(r => '## ' + fmt(r.ts || r.date, true) + '\n\n' + r.text) : ['（导师还没有回信）']).join('\n');
    Object.keys(state.notes).forEach(id => {
      const l = lessonBy(id);
      if (l) payload.files['Day-' + String(l.day).padStart(3, '0') + '.md'] = buildNoteMd(l);
    });
    const x = I();
    if (!x || !x.notes) {
      // 没加载 config.js 时退回旧版行为
      if (!online) {
        let bundle = '';
        Object.entries(payload.files).forEach(([name, text]) => {
          bundle += '\n\n===== ' + name + ' =====\n\n' + text;
        });
        download('notes-obsidian-bundle.md', bundle, 'text/markdown;charset=utf-8');
        toast('已导出笔记合集');
        return;
      }
      const res = await fetch(apiUrl(API.notes), {
        method: 'POST', headers: apiHeaders(), body: JSON.stringify(payload)
      });
      toast(res.ok ? '已同步到 notes/' : '同步失败，请确认 server.py 正在运行');
      return;
    }
    const result = await x.notes.publish(payload.files, {
      online, apiUrl, download, headers: () => apiHeaders()
    });
    toast(result.message);
  }

  /* ---------------- 顶栏 ---------------- */
  function injectTopbar() {
    const page = document.body.dataset.page;
    const links = NAV.map(([k, url, label]) =>
      '<a href="' + url + (k === 'lesson' ? '?day=' + (currentLesson ? currentLesson.day : nextLesson().day) : '') + '" class="' + (k === page ? 'active' : '') + '">' + label + '</a>'
    ).join('');
    const el = document.getElementById('topbar');
    if (el) el.innerHTML =
      '<div class="topbar"><div class="topbar-inner">' +
      '<div class="brand"><span class="brand-mark">Py</span><span>Python 私塾</span></div>' +
      '<nav class="nav">' + links + '</nav>' +
      '<button class="btn ghost sm cfg-trigger" data-settings-open title="集成设置">设置</button>' +
      '<div class="sync-pill" id="sync-pill"><span class="dot busy"></span>连接中…</div>' +
      '</div></div>';
    // 页面重绘会重建顶栏，这里立刻把当前保存状态画回去
    Store.pill();
  }

  /* ---------------- 共用片段 ---------------- */
  function planOf(l) {
    const p = l && l.plan;
    return {
      mcq: p && Number.isInteger(p.mcq) ? p.mcq : 5,
      lab: p && Number.isInteger(p.lab) ? p.lab : 3,
      feynman: p && Number.isInteger(p.feynman) ? p.feynman : (l && l.feynman ? 1 : 0)
    };
  }
  function fullScore(l) { const p = planOf(l); return p.mcq + p.lab; }
  function paceSegments(l) {
    const p = planOf(l);
    return [
      { w: 3, label: '读原文' },
      { w: 3, label: '第一性原理' },
      { w: 2, label: '跑示例' },
      { w: p.mcq, label: p.mcq + ' 道选择' },
      { w: p.lab * 2, label: p.lab + ' 道编程' },
      { w: p.feynman ? 2 : 1, label: p.feynman ? '费曼复述' : '完成打卡' }
    ];
  }
  function paceBar(l) {
    const segs = paceSegments(l);
    const p = planOf(l);
    const total = segs.reduce((a, s) => a + s.w, 0);
    return '<div class="pace-bar">' + segs.map(s =>
      '<div class="pace-seg" style="flex:' + s.w + '">' + esc(s.label) + '</div>'
    ).join('') + '</div><div class="tiny muted">本节计划约 ' + total + ' 分钟：选择 ' + p.mcq +
      '′ · 编程 ' + (p.lab * 2) + '′' + (p.feynman ? ' · 费曼 2′' : '') + '；读、拆、跑各按原文节奏。</div>';
  }
  function mentorBlock() {
    if (!mentorReplies.length) return '';
    const unread = mentorReplies.slice(-2).reverse().map(r =>
      '<div class="mentor-msg"><strong>导师回信 · ' + fmt(r.ts || r.date, true) + '</strong><br>' + esc(r.text).replace(/\n/g, '<br>') + '</div>'
    ).join('');
    return '<div class="card"><div class="card-head"><h3>来自 WorkBuddy 的消息</h3><span class="badge purple">导师</span></div>' + unread + '</div>';
  }
  function diffStars(n) { return '<span class="stars">' + '★'.repeat(n) + '☆'.repeat(5 - n) + '</span>'; }

  /* ---------------- 首页 ---------------- */
  function viewHome() {
    const l = nextLesson();
    const s = stats();
    const pct = Math.round(s.done / C.meta.totalDays * 100);
    const wrong = state.wrongBook.filter(w => !w.mastered).slice(-3).reverse();
    const app = document.getElementById('app');
    const offlineTip = online ? '' :
      '<div class="callout warn">当前<strong>没连上本地服务</strong>，改动暂时只存在这个浏览器里（不会丢，但导师看不到）。' +
      '双击桌面上的 <span class="kbd">Python 私塾</span> 快捷方式，它会自动启动服务并打开网站，进度会自动合回来。</div>';
    app.innerHTML = offlineTip +
      '<div class="page-head"><h1>今天是 Day ' + l.day + ' · ' + esc(l.title) + '</h1>' +
      '<p>' + esc(l.chapter + ' ' + l.chapterTitle) + ' · 难度 ' + diffStars(l.difficulty) + ' · 约 ' + l.minutes + ' 分钟</p></div>' +
      '<div class="row"><div class="col-main">' +
      '<div class="card" style="border-left:4px solid var(--primary)">' +
      '<div class="card-head"><h2>今日任务</h2><span class="badge blue">' + (l.type === 'intro' ? '章导读' : '正课') + '</span></div>' +
      '<p class="muted small" style="margin-top:0">' + esc(l.why) + '</p>' + paceBar(l) +
      '<div class="divider"></div>' +
      '<div class="btn-row">' +
      '<a class="btn primary" href="lesson.html?day=' + l.day + '">开始这一节 →</a>' +
      '<a class="btn" href="' + esc(l.url) + '" target="_blank" rel="noopener">读原文（免费）</a>' +
      '<a class="btn" href="playground.html">打开编程实验室</a>' +
      '</div></div>' +

      '<div class="card"><div class="card-head"><h2>学习主线</h2><span class="badge">' + C.meta.method.join(' + ') + '</span></div>' +
      '<div class="grid grid-2">' +
      '<div><h3>第一性原理</h3><p class="small muted">每节先问：这个问题的本质是什么？不可再分的最小事实有哪些？从这些事实怎么推出语法？边界在哪？</p></div>' +
      '<div><h3>费曼学习法</h3><p class="small muted">学完必须用自己的话讲一遍，卡壳的地方回看原文；讲不清就是没学会。复述会存进笔记册。</p></div>' +
      '</div><div class="divider"></div>' +
      '<p class="small muted" style="margin:0">全站 ' + C.meta.totalChapters + ' 章 / ' + C.meta.totalDays + ' 节，按廖雪峰教程原顺序由易到难重排为一天一节；题量按当天难度安排：3~5 道选择题、1~3 道浏览器内可自动判分的编程题，费曼复述 0 或 1 题。</p>' +
      '</div>' +

      '<div class="card"><div class="card-head"><h3>今日规范提醒</h3><span class="badge orange">按进度解锁</span></div>' +
      '<ul class="points small" style="margin-bottom:0">' + C.meta.norms
        .filter(x => (x.day === undefined || x.day <= nextLesson().day))
        .slice(-3)
        .map(x => '<li>' + esc(x.text || x) + '</li>').join('') + '</ul>' +
      '<p class="tiny muted" style="margin:8px 0 0">只显示你已经学到的规范，其余会在对应章节解锁 —— 现在不用去搜。</p></div>' +
      mentorBlock() +
      '</div><div class="col-side">' +
      '<div class="grid grid-2" style="margin-bottom:16px">' +
      '<div class="stat"><div class="num">' + s.done + '</div><div class="label">已完成 / ' + C.meta.totalDays + ' 天</div></div>' +
      '<div class="stat"><div class="num">' + s.streak + '</div><div class="label">连续学习天数</div></div>' +
      '<div class="stat"><div class="num">' + s.attempts + '</div><div class="label">累计做题</div></div>' +
      '<div class="stat"><div class="num">' + s.rate + '%</div><div class="label">总正确率</div></div>' +
      '</div>' +
      '<div class="card"><div class="card-head"><h3>总进度</h3><span class="tiny muted">' + pct + '%</span></div>' +
      '<div class="progress"><i style="width:' + pct + '%"></i></div>' +
      '<p class="tiny muted" style="margin-bottom:0">按每天一节计算，约 ' + Math.ceil((C.meta.totalDays - s.done) / 7) + ' 周完成全教程。</p></div>' +
      '<div class="card"><div class="card-head"><h3>最近错题</h3><a class="tiny" href="review.html">全部 →</a></div>' +
      (wrong.length ? wrong.map(w => '<div class="list-item" style="padding:8px 10px;margin-bottom:8px"><div class="body small">' + esc(w.stem) + '<div class="tiny muted">' + esc((w.tags || []).slice(0, 3).join(' / ')) + '</div></div></div>').join('') : '<div class="empty" style="padding:16px">还没有错题 👍</div>') +
      '</div>' +
      '<div class="card"><h3>和导师联动</h3><p class="small muted">启动 <span class="kbd">start.bat</span> 后，做题记录会写入 <span class="kbd">records/state.json</span>，笔记写入 <span class="kbd">notes/</span>；WorkBuddy 可直接读取并回信。</p>' +
      '<div class="btn-row"><a class="btn sm" href="progress.html">导出周报</a><a class="btn sm" href="notes.html">笔记册</a></div></div>' +
      '</div></div>';
  }

  /* ---------------- 目录页 ---------------- */
  function viewCatalog() {
    const app = document.getElementById('app');
    const s = stats();
    app.innerHTML =
      '<div class="page-head"><h1>课程目录</h1><p>' + C.meta.sourceName + ' 全站 ' + C.meta.totalChapters + ' 章 / ' + C.meta.totalDays + ' 节 · 一天一节 · 由易到难 · 已完成 ' + s.done + ' 节</p></div>' +
      '<div class="filter-bar">' +
      '<input class="input" id="q" placeholder="搜索章节标题 / 编号…">' +
      '<select class="input" id="filter-state" style="width:150px"><option value="all">全部状态</option><option value="todo">未完成</option><option value="done">已完成</option></select>' +
      '<select class="input" id="filter-level" style="width:140px"><option value="0">全部难度</option><option value="1">★</option><option value="2">★★</option><option value="3">★★★</option><option value="4">★★★★</option><option value="5">★★★★★</option></select>' +
      '<select class="input" id="scope-mode" style="width:170px" title="控制题目能否提前出现">' +
      '<option value="strict"' + (state.settings.strictScope ? ' selected' : '') + '>严格不超纲</option>' +
      '<option value="preview"' + (!state.settings.strictScope ? ' selected' : '') + '>允许提前 1 节</option></select>' +
      '<label class="small" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="skip-intro"' + (state.settings.skipIntro ? ' checked' : '') + '> 折叠章导读</label>' +
      '</div>' +
      '<div id="catalog-list"></div>';
    renderCatalog();

    const on = () => renderCatalog();
    document.getElementById('q').addEventListener('input', on);
    document.getElementById('filter-state').addEventListener('change', on);
    document.getElementById('filter-level').addEventListener('change', on);
    document.getElementById('skip-intro').addEventListener('change', e => {
      state.settings.skipIntro = e.target.checked; Store.save(); renderCatalog();
    });
    document.getElementById('scope-mode').addEventListener('change', e => {
      state.settings.strictScope = e.target.value !== 'preview';
      Store.save();
      toast(state.settings.strictScope ? '已切换为严格不超纲' : '已允许提前 1 节预览');
    });
    document.getElementById('catalog-list').addEventListener('click', e => {
      const head = e.target.closest('.chapter-head');
      if (head) { head.parentElement.classList.toggle('closed'); renderCatalogBody(); }
    });
  }
  function renderCatalog() {
    const box = document.getElementById('catalog-list');
    if (!box) return;
    const chapters = C.chapters.map(ch => ({ ch, lessons: C.lessons.filter(l => l.chapter === ch.num) }));
    box.innerHTML = chapters.map(({ ch, lessons }) =>
      '<section class="chapter" data-ch="' + ch.num + '">' +
      '<div class="chapter-head"><div class="index">' + ch.num + '</div><div class="title">' + esc(ch.title) +
      '<div class="tiny muted" style="font-weight:400">' + esc(ch.essence) + '</div></div>' +
      '<span class="badge">' + lessons.filter(l => state.progress[l.id] && state.progress[l.id].status === 'done').length + '/' + lessons.length + '</span>' +
      '<span class="tiny muted">▾</span></div>' +
      '<div class="chapter-body"></div></section>'
    ).join('');
    renderCatalogBody();
  }
  function renderCatalogBody() {
    const q = (document.getElementById('q') || {}).value || '';
    const fs = (document.getElementById('filter-state') || {}).value || 'all';
    const fl = parseInt((document.getElementById('filter-level') || {}).value || '0', 10);
    const skip = state.settings.skipIntro;
    document.querySelectorAll('.chapter').forEach(sec => {
      const chNum = sec.dataset.ch;
      const body = sec.querySelector('.chapter-body');
      const collapsed = sec.classList.contains('closed');
      if (collapsed) { body.innerHTML = ''; return; }
      const rows = C.lessons.filter(l => l.chapter === chNum).filter(l => {
        if (skip && l.type === 'intro') return false;
        if (fl && l.difficulty !== fl) return false;
        const done = state.progress[l.id] && state.progress[l.id].status === 'done';
        if (fs === 'done' && !done) return false;
        if (fs === 'todo' && done) return false;
        if (q && !(l.title + l.num + l.chapterTitle).toLowerCase().includes(q.toLowerCase())) return false;
        return true;
      }).map(l => {
        const p = state.progress[l.id] || {};
        const cls = p.status === 'done' ? 'done' : (p.status === 'doing' || state.sessions[l.id] ? 'doing' : '');
        return '<div class="lesson-row"><span class="state-dot ' + cls + '"></span>' +
          '<span class="day">Day ' + l.day + '</span>' +
          '<span class="name"><a href="lesson.html?day=' + l.day + '">' + esc(l.num + ' ' + l.title) + '</a>' +
          '<div class="meta">' + esc(l.why) + '</div></span>' +
          '<span class="stars">' + diffStars(l.difficulty) + '</span>' +
          (l.type === 'intro' ? '<span class="badge">导读</span>' : '') +
          (l.env === 'local' ? '<span class="badge orange" title="浏览器沙箱受限，完整示例请在本机运行">本机</span>' : '') +
          (p.status === 'done' ? '<span class="badge green">' + p.score + ' 分</span>' : '') +
          '</div>';
      }).join('');
      body.innerHTML = rows || '<div class="empty" style="padding:12px">没有符合条件的课</div>';
    });
  }

  /* ---------------- 学习页 ---------------- */
  function viewLesson(params) {
    const day = parseInt(params.get('day') || '', 10);
    const id = params.get('id');
    const l = id ? lessonBy(id) : lessonByDay(day || nextLesson().day);
    currentLesson = l;
    currentQuiz = quizFor(l);
    const plan = planOf(l);
    injectTopbar();
    const app = document.getElementById('app');
    const sess = sessionOf(l.id);
    const p = state.progress[l.id] || {};
    const prev = l.day > 1 ? lessonByDay(l.day - 1) : null;
    const next = l.day < C.lessons.length ? lessonByDay(l.day + 1) : null;
    const note = state.notes[l.id] || {};
    const commentDraft = (state.drafts || {})[draftKey('comment', l.id)] || '';
    const commentKind = (state.drafts || {})[draftKey('commentKind', l.id)] || '疑问';
    const comments = state.comments.filter(c => c.lessonId === l.id);
    const replies = mentorReplies.filter(r => r.lessonId === l.id);

    app.innerHTML =
      '<div class="page-head"><h1>Day ' + l.day + ' · ' + esc(l.title) + '</h1>' +
      '<p>' + esc(l.num + ' / 第 ' + l.chapter + ' 章 ' + l.chapterTitle) + ' · ' + diffStars(l.difficulty) + ' · ' + l.minutes + ' 分钟 · ' +
      (p.status === 'done' ? '<span class="badge green">已完成 · 得分 ' + p.score + ' 分</span>' : '<span class="badge blue">进行中</span>') + '</p></div>' +
      '<div class="btn-row" style="margin-bottom:16px">' +
      '<a class="btn" href="' + esc(l.url) + '" target="_blank" rel="noopener">📖 原文（免费）</a>' +
      '<a class="btn" href="catalog.html">目录</a>' +
      (prev ? '<a class="btn ghost" href="lesson.html?day=' + prev.day + '">← 上一节</a>' : '') +
      (next ? '<a class="btn ghost" href="lesson.html?day=' + next.day + '">下一节 →</a>' : '') +
      '</div>' +
      (l.envHint ? '<div class="callout warn"><strong>环境边界</strong>：' + esc(l.envHint) + '</div>' : '') +
      (l.scopeNote ? '<div class="callout"><strong>入门期说明</strong>：' + esc(l.scopeNote) + '</div>' : '') +
      '<div class="callout purple"><strong>今天新解锁的知识点</strong>：' +
      (Q.conceptsOnDay(l.day).length ? esc(Q.conceptsOnDay(l.day).join('、')) : '本节不引入新语法，只做梳理与衔接') +
      '　·　下面的题只从「今天及之前讲过」的范围里出' +
      (state.settings.strictScope ? '（严格不超纲）' : '（预览模式：允许提前 1 节）') + '</div>' +

      '<div class="row"><div class="col-main">' +
      /* ① */ '<div class="card"><div class="step"><div class="step-num">1</div><div class="step-body">' +
      '<h2>读原文 · 3 分钟</h2>' +
      '<p class="small muted">先读 <a href="' + esc(l.url) + '" target="_blank" rel="noopener">廖雪峰教程 ' + esc(l.num + ' ' + l.title) + '</a>（免费）。带着三个问题读：</p>' +
      '<ul class="points small"><li>这一节想解决什么问题？</li><li>出现了哪些你第一次见到的名词？</li><li>示例代码里哪一行最关键？把它改一个数字会怎样？</li></ul>' +
      '<div class="callout">先猜、再验证。不要一上来就看本站的示例输出。</div>' +
      '</div></div></div>' +
      /* ② */ '<div class="card"><div class="step"><div class="step-num">2</div><div class="step-body">' +
      '<h2>第一性原理拆解 · 3 分钟</h2>' +
      '<div class="callout purple"><strong>本质问题</strong>：' + esc(l.why) + '</div>' +
      '<h3>不可再分的最小事实</h3><ul class="points">' + l.points.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' +
      '<div class="callout"><strong>推导提问</strong>：只根据上面这几条事实，为什么「' + esc(l.title) + '」会被设计成这样？如果去掉其中一条，会出什么问题？</div>' +
      '<div class="callout warn"><strong>边界 / 易错</strong>：' + esc(l.boundary) + '</div>' +
      '<p class="tiny muted">本章主线：' + esc(l.essence) + '</p>' +
      '</div></div></div>' +
      /* ③ */ '<div class="card"><div class="step"><div class="step-num">3</div><div class="step-body">' +
      '<h2>跑一段最小可运行示例 · 2 分钟</h2>' +
      '<div class="code-head"><span>example.py · 可独立运行</span><span>CPython ' + esc(C.meta.pyodide.cpython) + ' 浏览器运行时</span></div>' +
      '<pre class="code" style="border-radius:0 0 9px 9px;border-top:none">' + esc(l.example.code) + '</pre>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn sm primary" data-action="run-example">▶ 在实验室运行</button>' +
      '<button class="btn sm" data-action="toggle-expected">先自己预测，再对答案</button></div>' +
      '<div id="expected-box" class="hidden" style="margin-top:10px"><div class="tiny muted">预期输出</div><pre class="code" style="margin-top:5px">' + esc(l.example.output) + '</pre></div>' +
      '</div></div></div>' +
      /* ④ */ '<div class="card"><div class="step"><div class="step-num">4</div><div class="step-body">' +
      '<h2>' + plan.mcq + ' 道选择题 · ' + plan.mcq + ' 分钟</h2><p class="tiny muted">只用今天及之前讲过的内容；每题下方标出用到的知识点。选择后立即判分并给解析，答错自动进错题册。看到没学过的词，点「这题没学过」。</p>' +
      '<div id="mcq-list">' + currentQuiz.mcq.map((q, i) => mcqHtml(q, i, sess)).join('') + '</div>' +
      '</div></div></div>' +
      /* ⑤ */ '<div class="card"><div class="step"><div class="step-num">5</div><div class="step-body">' +
      '<h2>' + plan.lab + ' 道编程实操 · ' + (plan.lab * 2) + ' 分钟</h2><p class="tiny muted">入门期只需写语句、看输出（Day 18 起才要求自己定义函数）。先写、再跑、最后判题；提示分三级，参考解答请最后再看。</p>' +
      '<div id="lab-list">' + currentQuiz.lab.map((q, i) => labHtml(q, i, sess)).join('') + '</div>' +
      '<div class="callout" id="py-status" style="display:none"></div>' +
      '</div></div></div>' +
      /* ⑥ */ '<div class="card"><div class="step"><div class="step-num">6</div><div class="step-body">' +
      '<h2>费曼复述 + 打卡 · 2 分钟</h2>' +
      '<div class="callout purple"><strong>请用自己的话讲一遍</strong>：' + esc(l.feynman) + '</div>' +
      '<label class="field"><span>不看原文写下来（讲不清的地方，就是下一步要回看的点）</span>' +
      '<textarea class="input" id="feynman-input" rows="4" placeholder="例如：变量就像贴在东西上的标签……">' + esc(note.feynman || '') + '</textarea></label>' +
      '<p class="tiny muted" style="margin:0 0 8px">✍️ 输入即自动保存，不用点按钮；关掉页面、刷新、重开电脑都不会丢，WorkBuddy 也能直接读到。</p>' +
      '<div class="btn-row"><button class="btn sm" data-action="save-feynman">保存复述</button>' +
      '<button class="btn sm ghost" data-action="self-check" data-v="ok">能讲清楚</button>' +
      '<button class="btn sm ghost" data-action="self-check" data-v="half">有点卡壳</button>' +
      '<button class="btn sm ghost" data-action="self-check" data-v="no">完全讲不出</button></div>' +
      '<div class="divider"></div>' +
      '<div class="btn-row"><button class="btn success" data-action="finish">✓ 完成今日学习并打卡</button>' +
      '<span class="tiny muted" id="finish-hint">得分 = 选择题正确数 + 编程题通过数（满分 ' + fullScore(l) + '）</span></div>' +
      '</div></div></div>' +
      '</div><div class="col-side">' +
      '<div class="card"><h3>今日节奏</h3>' + paceBar(l) + '</div>' +
      '<div class="card"><h3>规范卡 · ' + esc(l.chapterTitle) + '</h3><p class="small">' + esc(l.norm) + '</p>' +
      '<details class="fold"><summary>查看目前已解锁的 Python 规范</summary>' +
      '<p class="tiny muted">只列出你已经学过的部分，其余会在对应章节解锁 —— 现在不用去搜。</p>' +
      '<ul class="points small">' + C.meta.norms
        .filter(x => (x.day === undefined || x.day <= l.day))
        .map(x => '<li>' + esc(x.text || x) + '</li>').join('') + '</ul>' +
      (C.meta.norms.filter(x => x.day !== undefined && x.day > l.day).length
        ? '<p class="tiny muted">还有 ' + C.meta.norms.filter(x => x.day !== undefined && x.day > l.day).length + ' 条规范将在后续章节解锁。</p>' : '') +
      '</details></div>' +
      '<div class="card"><h3>我的笔记</h3>' +
      '<label class="field"><span>课堂笔记</span><textarea class="input" id="note-input" rows="4" placeholder="记下你的理解、报错、类比…">' + esc(note.note || '') + '</textarea></label>' +
      '<label class="field"><span>我的代码草稿</span><textarea class="input mono" id="note-code" rows="4" placeholder="# 剪一段你改过的代码">' + esc(note.code || '') + '</textarea></label>' +
      '<button class="btn sm" data-action="save-note">保存笔记</button>' +
      '<p class="tiny muted" style="margin:8px 0 0">输入即自动保存。</p></div>' +
      '<div class="card"><div class="card-head"><h3>Comments · 提问 / 我的答案</h3><span class="badge">私人的</span></div>' +
      '<label class="field"><span>类型</span><select class="input" id="comment-kind">' +
      ['疑问', '我的答案', '想法 / 复盘'].map(v =>
        '<option value="' + v + '"' + (v === commentKind ? ' selected' : '') + '>' + v + '</option>').join('') +
      '</select></label>' +
      '<textarea class="input" id="comment-input" rows="3" placeholder="把想问导师的话写在这里，WorkBuddy 能看到">' + esc(commentDraft) + '</textarea>' +
      '<p class="tiny muted" style="margin:4px 0 0">没点「发布」的草稿也会实时保存，导师能看到。</p>' +
      '<button class="btn sm primary" style="margin-top:8px" data-action="add-comment">发布</button>' +
      '<div class="divider"></div><div id="comment-list">' +
      (comments.length ? comments.slice().reverse().map(c =>
        '<div class="list-item" style="padding:9px 10px;margin-bottom:8px"><div class="body small"><span class="badge">' + esc(c.kind) + '</span> ' + esc(c.text).replace(/\n/g, '<br>') +
        '<div class="tiny muted">' + fmt(c.ts, true) + (c.pending ? ' · 待导师回复' : '') + '</div></div></div>').join('') : '<div class="empty" style="padding:12px">还没有留言</div>') +
      '</div>' +
      (replies.length ? '<div class="divider"></div>' + replies.map(r => '<div class="mentor-msg"><strong>导师回信</strong><br>' + esc(r.text).replace(/\n/g, '<br>') + '</div>').join('') : '') +
      '</div>' +
      '<div class="card"><h3>前置依赖</h3><p class="small muted">' +
      (l.prereq.length ? l.prereq.map(id => { const q = lessonBy(id); return '<a href="lesson.html?day=' + q.day + '">Day ' + q.day + ' ' + esc(q.title) + '</a>'; }).join('<br>') : '这是起点，无需前置。') +
      '</p></div>' +
      '</div></div>';
  }

  function mcqHtml(q, i, sess) {
    const rec = sess.mcq[q.uid] || {};
    const picked = rec.picked;
    const answered = picked !== undefined;
    return '<div class="quiz-item ' + (answered ? (rec.correct ? 'correct' : 'wrong') : '') + '" data-q="' + esc(q.uid) + '">' +
      '<div class="quiz-title"><span class="qno">Q' + (i + 1) + '</span><span>' + esc(q.stem) + '</span></div>' +
      scopeRow(q) +
      '<div class="options">' + q.options.map((o, j) => {
        let cls = '';
        if (answered) {
          if (j === q.answer) cls = ' right';
          else if (j === picked) cls = ' wrongpick';
        } else if (j === picked) cls = ' picked';
        return '<button class="option' + cls + '" data-action="pick" data-i="' + j + '"' + (answered ? ' disabled' : '') + '>' +
          '<span class="letter">' + 'ABCD'[j] + '</span><span>' + esc(o) + '</span></button>';
      }).join('') + '</div>' +
      (answered ? '<div class="feedback ' + (rec.correct ? 'ok' : 'no') + '">' +
        (rec.correct ? '✓ 答对了。' : '✗ 再想想。') + ' ' + esc(q.explain) + '</div>' : '') +
      '</div>';
  }

  function labHtml(q, i, sess) {
    const rec = sess.lab[q.uid] || {};
    const code = rec.code !== undefined ? rec.code : q.starter;
    return '<div class="lab-item" data-q="' + esc(q.uid) + '">' +
      '<div class="quiz-title"><span class="qno">LAB' + (i + 1) + '</span><span>' + esc(q.title) +
      (rec.passed ? ' <span class="badge green">已通过</span>' : '') + '</span></div>' +
      '<p class="small" style="margin:0 0 8px">' + esc(q.brief) + '</p>' +
      scopeRow(q) +
      '<div class="code-head"><span>' +
      (q.mode === 'stdout' ? 'solution.py · 直接写代码，看屏幕输出' : 'solution.py · 实现 solve / 按题意定义') +
      '</span><span><span class="kbd">Ctrl+Enter</span> 运行</span></div>' +
      '<textarea class="editor lab-editor" rows="7" spellcheck="false">' + esc(code) + '</textarea>' +
      '<div class="lab-toolbar">' +
      '<button class="btn sm primary" data-action="judge">✓ 判题</button>' +
      '<button class="btn sm" data-action="lab-run">▶ 运行看输出</button>' +
      '<button class="btn sm ghost" data-action="hint">提示</button>' +
      '<button class="btn sm ghost" data-action="solution">参考解答</button>' +
      '<button class="btn sm ghost" data-action="save-code">存入笔记</button>' +
      '</div>' +
      '<div class="output-box lab-output" style="display:none"></div>' +
      '<div class="hint-box lab-hint hidden"></div>' +
      '<div class="lab-solution hidden" style="margin-top:9px"><div class="tiny muted">参考代码（看过之后，请合上再自己写一遍）</div><pre class="code" style="margin-top:5px">' + esc(q.solution || '（本题请在提示后自行实现）') + '</pre></div>' +
      '</div>';
  }

  /* ---------------- 实验室 ---------------- */
  function viewPlayground(params) {
    const app = document.getElementById('app');
    const initial = params.get('code') || (state.drafts || {}).playground || '';
    app.innerHTML =
      '<div class="page-head"><h1>编程实验室</h1><p>浏览器内真实运行 CPython（Pyodide ' + esc(C.meta.pyodide.version) + '），无需安装 Python · 首次加载需联网下载约 10~20 MB</p></div>' +
      '<div class="row"><div class="col-main">' +
      '<div class="card"><div class="card-head"><h2>代码编辑器</h2>' +
      '<select class="input" id="example-pick" style="width:280px"><option value="">— 载入本节示例 —</option>' +
      C.lessons.map(l => '<option value="' + l.id + '">Day ' + l.day + ' · ' + esc(l.title) + '</option>').join('') + '</select></div>' +
      '<div class="code-head"><span>scratch.py</span><span><span class="kbd">Ctrl+Enter</span> 运行</span></div>' +
      '<textarea class="editor" id="pg-editor" rows="16" spellcheck="false">' + esc(initial || '# 在这里写 Python，点「运行」看结果\nprint("Hello, Python!")\nprint([x * x for x in range(5)])') + '</textarea>' +
      '<div class="btn-row" style="margin-top:10px">' +
      '<button class="btn primary" data-action="pg-run">▶ 运行</button>' +
      '<button class="btn" data-action="pg-save">保存为片段</button>' +
      '<button class="btn ghost" data-action="pg-clear">清空</button>' +
      '<span class="tiny muted" id="pg-status" style="align-self:center"></span></div>' +
      '</div>' +
      '<div class="card"><div class="card-head"><h3>输出</h3><span class="tiny muted" id="pg-runtime">运行时：待加载</span></div>' +
      '<div class="output-box" id="pg-output">点「运行」后，stdout / stderr 会显示在这里。</div></div>' +
      '<div class="card"><h3>我的片段</h3><div id="pg-snippets"></div></div>' +
      '</div><div class="col-side">' +
      '<div class="card"><h3>环境边界</h3><ul class="points small">' +
      '<li>浏览器里是 <strong>CPython ' + esc(C.meta.pyodide.cpython) + '</strong>（Pyodide ' + esc(C.meta.pyodide.version) + '，核实于 ' + C.meta.pyodide.verifiedAt + '）</li>' +
      '<li>本机 Python：' + esc('3.13.x') + '，写代码时避免使用某个版本独有的新语法</li>' +
      '<li>不能运行：tkinter 图形窗口、真实 socket、fork 多进程、pip 装系统包、连接 MySQL</li>' +
      '<li>可以运行：纯 Python 语法、标准库大部分模块、sqlite3 内存库、asyncio</li>' +
      '<li>这些章节的编程题改成「纯逻辑模拟」，完整示例请在本机 venv 跑</li>' +
      '</ul></div>' +
      '<div class="card"><h3>规范提醒</h3><p class="small muted">保存成文件时记得：UTF-8、4 空格缩进、<span class="kbd">if __name__ == "__main__":</span> 入口、函数写 docstring。</p></div>' +
      '</div></div>';
    renderSnippets();
    const pick = document.getElementById('example-pick');
    pick.addEventListener('change', () => {
      const l = lessonBy(pick.value);
      if (!l) return;
      document.getElementById('pg-editor').value = l.example.code;
      toast('已载入 Day ' + l.day + ' 示例：先预测输出，再运行验证');
    });
    document.getElementById('pg-editor').addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); pgRun(); }
      if (e.key === 'Tab') {
        e.preventDefault();
        const t = e.target, s = t.selectionStart;
        t.value = t.value.slice(0, s) + '    ' + t.value.slice(t.selectionEnd);
        t.selectionStart = t.selectionEnd = s + 4;
      }
    });
    document.getElementById('pg-snippets').addEventListener('click', e => {
      const b = e.target.closest('[data-snip]');
      if (b) document.getElementById('pg-editor').value = state.snippets[parseInt(b.dataset.snip, 10)].code;
    });
  }
  function renderSnippets() {
    const box = document.getElementById('pg-snippets');
    if (!box) return;
    box.innerHTML = state.snippets.length ? state.snippets.slice().reverse().slice(0, 12).map((s, i) => {
      const idx = state.snippets.length - 1 - i;
      return '<div class="list-item" style="padding:8px 10px;margin-bottom:8px"><div class="body small">' + esc(s.title) +
        '<div class="tiny muted">' + fmt(s.ts, true) + '</div></div><button class="btn sm ghost" data-snip="' + idx + '">载入</button></div>';
    }).join('') : '<div class="empty" style="padding:14px">还没有保存片段</div>';
  }
  async function pgRun() {
    const code = document.getElementById('pg-editor').value;
    const out = document.getElementById('pg-output');
    const status = document.getElementById('pg-status');
    out.innerHTML = '<span class="muted">运行中…</span>';
    status.innerHTML = '<span class="spinner"></span> 加载/执行中';
    try {
      const res = await PyRun.run(code, {
        onProgress: m => { out.textContent = m; }
      });
      let html = '';
      if (res.stdout) html += esc(res.stdout);
      if (res.stderr) html += '\n<span class="err">' + esc(res.stderr) + '</span>';
      if (res.error) html += (html ? '\n' : '') + '<span class="err">' + esc(res.error) + '</span>';
      out.innerHTML = html || '<span class="ok">（运行完成，没有输出）</span>';
      document.getElementById('pg-runtime').textContent = '运行时：Pyodide ' + PyRun.version() + (PyRun.isInterruptible() ? ' · 超时保护开' : '');
      status.textContent = res.ok ? '✓ 完成' : '✗ 有异常';
    } catch (e) {
      out.innerHTML = '<span class="err">无法启动 Python 运行时：' + esc(e.message) + '\n请检查网络（首次需从 jsDelivr 下载），或改用本地 Python。</span>';
      status.textContent = '加载失败';
    }
  }

  /* ---------------- 错题册 ---------------- */
  function viewReview(params) {
    const tab = params.get('tab') || 'wrong';
    const app = document.getElementById('app');
    const s = stats();
    app.innerHTML =
      '<div class="page-head"><h1>错题册与做题历史</h1><p>错过的题自动收进来；再次答对会标记「已掌握」。共 ' + s.attempts + ' 次作答，未掌握 ' + state.wrongBook.filter(w => !w.mastered).length + ' 题</p></div>' +
      '<div class="btn-row" style="margin-bottom:16px">' +
      '<a class="btn ' + (tab === 'wrong' ? 'primary' : '') + '" href="review.html?tab=wrong">错题册</a>' +
      '<a class="btn ' + (tab === 'history' ? 'primary' : '') + '" href="review.html?tab=history">做题历史</a>' +
      '<a class="btn ' + (tab === 'tags' ? 'primary' : '') + '" href="review.html?tab=tags">知识点诊断</a>' +
      '<button class="btn ghost" data-action="export-history">导出 CSV</button>' +
      '</div><div id="review-body"></div>';
    const box = document.getElementById('review-body');
    if (tab === 'history') {
      const rows = state.attempts.slice().reverse().slice(0, 100);
      box.innerHTML = '<div class="card"><h3>最近 100 次作答</h3>' +
        (rows.length ? '<table class="tbl"><tr><th>时间</th><th>课程</th><th>类型</th><th>题目</th><th>结果</th></tr>' +
          rows.map(a => '<tr><td class="tiny">' + fmt(a.ts, true) + '</td><td class="small">' + esc(a.lessonTitle || '') + '</td>' +
            '<td class="small">' + (a.type === 'mcq' ? '选择' : '编程') + '</td><td class="small">' + esc(a.stem) + '</td>' +
            '<td>' + (a.correct ? '<span class="badge green">正确</span>' : '<span class="badge red">错误</span>') + '</td></tr>').join('') + '</table>'
          : '<div class="empty">还没有做题记录</div>') + '</div>';
    } else if (tab === 'tags') {
      const byTag = {};
      state.attempts.forEach(a => (a.tags || []).forEach(t => {
        if (!byTag[t]) byTag[t] = { n: 0, ok: 0 };
        byTag[t].n += 1; if (a.correct) byTag[t].ok += 1;
      }));
      const list = Object.entries(byTag).filter(([, v]) => v.n >= 2).sort((a, b) => (a[1].ok / a[1].n) - (b[1].ok / b[1].n)).slice(0, 20);
      box.innerHTML = '<div class="card"><h3>正确率最低的知识点（至少做过 2 次）</h3>' +
        (list.length ? list.map(([t, v]) => {
          const pct = Math.round(v.ok / v.n * 100);
          return '<div class="bar-row"><span class="name">' + esc(t) + '</span><div class="track"><i style="width:' + pct + '%;background:' + (pct < 60 ? 'var(--danger)' : 'var(--primary)') + '"></i></div><span class="val">' + pct + '% (' + v.n + ')</span></div>';
        }).join('') : '<div class="empty">数据还不够，多做几天再来看</div>') +
        '<div class="callout warn" style="margin-top:14px">把这张截图或周报发给 WorkBuddy，导师会针对低正确率的知识点给你加练。</div></div>';
    } else {
      box.innerHTML = '<div class="card"><div class="card-head"><h3>错题册</h3>' +
        '<select class="input" id="wrong-filter" style="width:170px"><option value="todo">未掌握</option><option value="all">全部</option><option value="mcq">仅选择题</option><option value="lab">仅编程题</option></select></div>' +
        '<div id="wrong-list"></div></div>';
      const render = () => {
        const f = document.getElementById('wrong-filter').value;
        const rows = state.wrongBook.slice().reverse().filter(w =>
          (f === 'all' || (f === 'todo' ? !w.mastered : w.type === f)));
        document.getElementById('wrong-list').innerHTML = rows.length ? rows.map(w => {
          const l = lessonBy(w.lessonId);
          const attempt = state.attempts.filter(a => a.baseId === w.baseId).slice(-1)[0];
          return '<div class="list-item"><div class="body">' +
            '<div class="strong small">' + (w.mastered ? '✅ ' : '❌ ') + esc(w.stem) + '</div>' +
            '<div class="tiny muted" style="margin:4px 0">Day ' + (l ? l.day : '?') + ' · ' + esc((w.tags || []).join(' / ')) + ' · 错 ' + w.wrongCount + ' 次 · ' + fmt(w.lastWrong) + '</div>' +
            (attempt && attempt.answer ? '<div class="small">我的答案：<span class="mono">' + esc(String(attempt.answer).slice(0, 160)) + '</span></div>' : '') +
            '<textarea class="input wrong-note" rows="2" data-wid="' + esc(w.baseId) + '" placeholder="写一句订正：我当时错在哪？" style="margin-top:8px">' + esc(w.note || '') + '</textarea>' +
            '</div><div style="display:grid;gap:6px">' +
            (l ? '<a class="btn sm" href="lesson.html?day=' + l.day + '">重做</a>' : '') +
            '<button class="btn sm ghost" data-action="master" data-wid="' + esc(w.baseId) + '">' + (w.mastered ? '取消掌握' : '标记掌握') + '</button>' +
            '</div></div>';
        }).join('') : '<div class="empty">这里空空的，很棒 👍</div>';
      };
      render();
      document.getElementById('wrong-filter').addEventListener('change', render);
      document.getElementById('wrong-list').addEventListener('change', e => {
        if (!e.target.classList.contains('wrong-note')) return;
        const w = state.wrongBook.find(x => x.baseId === e.target.dataset.wid);
        if (w) { w.note = e.target.value; Store.save(); toast('订正已保存'); }
      });
    }
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-action="master"]');
      if (!b) return;
      const w = state.wrongBook.find(x => x.baseId === b.dataset.wid);
      if (w) { w.mastered = !w.mastered; Store.save(); viewReview(new URLSearchParams('tab=wrong')); }
    });
  }

  /* ---------------- 笔记册 ---------------- */
  function viewNotes(params) {
    const app = document.getElementById('app');
    const ids = Object.keys(state.notes).filter(id => {
      const n = state.notes[id];
      return n.feynman || n.note || n.code;
    }).sort((a, b) => lessonBy(b).day - lessonBy(a).day);
    const activeId = params.get('id') || (ids[0] || nextLesson().id);
    const l = lessonBy(activeId) || nextLesson();
    const n = state.notes[l.id] || {};
    app.innerHTML =
      '<div class="page-head"><h1>笔记册</h1><p>支持导出 Markdown，Obsidian 直接打开 <span class="kbd">notes/</span> 文件夹即可；WorkBuddy 也能读写同一份笔记</p></div>' +
      '<div class="btn-row" style="margin-bottom:16px">' +
      '<button class="btn primary" data-action="sync-notes">同步到 Obsidian 文件夹</button>' +
      '<button class="btn" data-action="download-notes">导出当前笔记 .md</button>' +
      '<button class="btn" data-action="download-bundle">导出全部笔记合集</button>' +
      '<a class="btn ghost" href="progress.html">生成周报</a>' +
      '</div>' +
      '<div class="row"><div class="col-side" style="flex:0 0 280px">' +
      '<div class="card"><h3>按天笔记 (' + ids.length + ')</h3><div style="max-height:520px;overflow:auto">' +
      (ids.length ? ids.map(id => {
        const x = lessonBy(id);
        return '<a class="btn block ghost" style="justify-content:flex-start;margin-bottom:4px;' + (id === l.id ? 'background:var(--primary-soft);color:var(--primary)' : '') + '" href="notes.html?id=' + id + '">Day ' + x.day + ' · ' + esc(x.title) + '</a>';
      }).join('') : '<div class="empty" style="padding:14px">还没有笔记，去学习页写下费曼复述吧</div>') +
      '</div></div>' +
      '<div class="card"><h3>导师答疑</h3>' +
      (mentorReplies.length ? mentorReplies.slice().reverse().slice(0, 5).map(r => '<div class="mentor-msg small">' + esc(r.text).replace(/\n/g, '<br>') + '<div class="tiny muted">' + fmt(r.ts || r.date) + '</div></div>').join('') : '<p class="small muted">导师还没有回信。在学习页 Comments 里提问，或把周报发给 WorkBuddy。</p>') +
      '</div></div>' +
      '<div class="col-main"><div class="card"><div class="card-head"><h2>Day ' + l.day + ' · ' + esc(l.title) + '</h2>' +
      '<span class="badge blue">' + esc(l.chapterTitle) + '</span></div>' +
      '<p class="small muted">' + esc(l.feynman) + '</p>' +
      '<label class="field"><span>费曼复述</span><textarea class="input" id="n-feynman" rows="6">' + esc(n.feynman || '') + '</textarea></label>' +
      '<label class="field"><span>我的笔记</span><textarea class="input" id="n-note" rows="6">' + esc(n.note || '') + '</textarea></label>' +
      '<label class="field"><span>代码草稿</span><textarea class="input mono" id="n-code" rows="6">' + esc(n.code || '') + '</textarea></label>' +
      '<button class="btn primary" data-action="save-note-full" data-id="' + l.id + '">保存这一页</button></div>' +
      '<div class="card"><h3>Markdown 预览</h3><pre class="code" style="max-height:340px;overflow:auto;white-space:pre-wrap">' + esc(buildNoteMd(l)) + '</pre></div>' +
      '</div></div>';
  }

  /* ---------------- 进度页 ---------------- */
  function viewProgress() {
    const app = document.getElementById('app');
    const s = stats();
    const pct = Math.round(s.done / C.meta.totalDays * 100);
    // 最近 91 天热力图
    const cells = [];
    for (let i = 90; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = todayStr(d);
      const a = state.activity[key] || { attempts: 0, lessons: 0 };
      const v = a.attempts + a.lessons * 2;
      const lv = v === 0 ? '' : (v <= 2 ? 'l1' : v <= 5 ? 'l2' : v <= 8 ? 'l3' : 'l4');
      cells.push('<i class="' + lv + '" title="' + key + '：' + a.lessons + ' 节 / ' + a.attempts + ' 题"></i>');
    }
    const chapterBars = C.chapters.map(ch => {
      const ls = C.lessons.filter(l => l.chapter === ch.num);
      const done = ls.filter(l => state.progress[l.id] && state.progress[l.id].status === 'done').length;
      const p = Math.round(done / ls.length * 100);
      return '<div class="bar-row"><span class="name">' + esc(ch.num + '. ' + ch.title).slice(0, 16) + '</span>' +
        '<div class="track"><i style="width:' + p + '%"></i></div><span class="val">' + done + '/' + ls.length + '</span></div>';
    }).join('');
    app.innerHTML =
      '<div class="page-head"><h1>学习进度</h1><p>开始于 ' + fmt(state.profile.startDate) + ' · 目标 ' + C.meta.totalDays + ' 天 · 每天 ' + C.meta.dailyMinutes + ' 分钟</p></div>' +
      '<div class="grid grid-4" style="margin-bottom:16px">' +
      '<div class="stat"><div class="num">' + s.done + '<span class="tiny muted"> / ' + C.meta.totalDays + '</span></div><div class="label">完成课程</div></div>' +
      '<div class="stat"><div class="num">' + s.attempts + '</div><div class="label">累计做题</div></div>' +
      '<div class="stat"><div class="num">' + s.rate + '%</div><div class="label">总正确率</div></div>' +
      '<div class="stat"><div class="num">' + s.streak + '</div><div class="label">连续天数</div></div>' +
      '</div>' +
      '<div class="row"><div class="col-main">' +
      '<div class="card"><div class="card-head"><h2>总进度 ' + pct + '%</h2><span class="tiny muted">预计还需 ' + Math.ceil((C.meta.totalDays - s.done) / 7) + ' 周</span></div>' +
      '<div class="progress" style="height:12px"><i style="width:' + pct + '%"></i></div></div>' +
      '<div class="card"><div class="card-head"><h3>最近 13 周学习热力图</h3><div class="legend">少 <i style="width:10px;height:10px;background:#e8edf5;border-radius:2px"></i><i style="width:10px;height:10px;background:#c7dbff;border-radius:2px"></i><i style="width:10px;height:10px;background:#8db6ff;border-radius:2px"></i><i style="width:10px;height:10px;background:#4d8bff;border-radius:2px"></i><i style="width:10px;height:10px;background:#2563eb;border-radius:2px"></i> 多</div></div>' +
      '<div class="heat">' + cells.join('') + '</div></div>' +
      '<div class="card"><h3>各章完成度</h3>' + chapterBars + '</div>' +
      '<div class="card"><h3>给导师的周报（预览）</h3><pre class="code" style="max-height:300px;overflow:auto;white-space:pre-wrap">' + esc(buildReport()) + '</pre>' +
      '<div class="btn-row" style="margin-top:10px"><button class="btn primary" data-action="export-report">下载周报 .md</button>' +
      '<button class="btn" data-action="save-report">写入 records/ 供导师读取</button></div></div>' +
      '</div><div class="col-side">' +
      '<div class="card"><h3>阶段性里程碑</h3>' +
      [['Day 1–15', '能独立写 20 行内的小程序：变量、分支、循环'],
       ['Day 16–40', '能用函数与容器组织代码，读懂报错'],
       ['Day 41–70', '理解抽象：生成器、装饰器、类与对象'],
       ['Day 71–95', '工程化：异常、测试、文件、标准库'],
       ['Day 96–112', '并发 / 网络 / Web / 异步，收束成项目能力']].map(([a, b]) =>
        '<div class="list-item" style="padding:8px 10px;margin-bottom:8px"><div class="body"><div class="strong tiny">' + a + '</div><div class="tiny muted">' + b + '</div></div></div>').join('') +
      '</div>' +
      '<div class="card"><h3>数据管理</h3><div class="btn-row">' +
      '<button class="btn sm" data-action="export-json">导出全部数据</button>' +
      '<button class="btn sm" data-action="import-json">导入数据</button>' +
      '<button class="btn sm ghost" data-action="reset">清空记录</button></div>' +
      '<input type="file" id="import-file" accept="application/json" class="hidden">' +
      '<p class="tiny muted" style="margin-bottom:0">联动开启时数据会同时存到 <span class="kbd">records/state.json</span>；WorkBuddy 读它就能看到你每道题的对错与费曼复述。</p></div>' +
      '<div class="card"><h3>每日契约</h3><p class="small muted">一天一节：读 3′ → 拆 3′ → 跑 2′ → 选择题 → 编程实操 → 费曼复述或打卡。题量按当天难度安排（3~5 选择、1~3 编程、0~1 费曼）。宁可少而连续，不要一天补五天。</p></div>' +
      '</div></div>';
  }

  /* ---------------- 事件委托 ---------------- */
  document.addEventListener('click', async function (e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const act = btn.dataset.action;

    if (act === 'scope-flag') {
      const qid = btn.dataset.qid;
      state.scopeFlags = state.scopeFlags || {};
      if (state.scopeFlags[qid]) {
        delete state.scopeFlags[qid];
        toast('已取消标记');
      } else {
        state.scopeFlags[qid] = {
          lessonId: currentLesson ? currentLesson.id : '',
          day: currentLesson ? currentLesson.day : 0,
          ts: new Date().toISOString()
        };
        toast('记下了：这题以后不再出现，导师也会在 records 里看到');
      }
      // 重新组卷前保存尚未提交的编辑器与笔记内容
      captureDrafts();
      Store.save();
      viewLesson(new URLSearchParams(location.search));
      return;
    }
    if (act === 'toggle-expected') {
      document.getElementById('expected-box').classList.toggle('hidden');
    }
    if (act === 'run-example') {
      const l = currentLesson;
      location.href = 'playground.html?code=' + encodeURIComponent(l.example.code);
    }
    if (act === 'pick') {
      const item = btn.closest('.quiz-item');
      const q = currentQuiz.mcq.find(x => x.uid === item.dataset.q);
      const i = parseInt(btn.dataset.i, 10);
      const sess = sessionOf(currentLesson.id);
      if (sess.mcq[q.uid]) return;
      const correct = i === q.answer;
      sess.mcq[q.uid] = { picked: i, correct, ts: new Date().toISOString() };
      recordAnswer(q, correct, 'ABCD'[i]);
      item.outerHTML = mcqHtml(q, currentQuiz.mcq.indexOf(q), sess);
      toast(correct ? '答对了 ✓' : '答错了，已收进错题册，记得回头订正');
    }
    if (act === 'lab-run' || act === 'judge') {
      const item = btn.closest('.lab-item');
      const q = currentQuiz.lab.find(x => x.uid === item.dataset.q);
      const code = item.querySelector('.lab-editor').value;
      const out = item.querySelector('.lab-output');
      const sess = sessionOf(currentLesson.id);
      out.style.display = 'block';
      out.innerHTML = '<span class="muted">正在启动 Python…</span>';
      const onProgress = m => { out.textContent = m; };
      try {
        if (act === 'lab-run') {
          const res = await PyRun.run(code, { onProgress });
          out.innerHTML = (res.stdout ? esc(res.stdout) : '') +
            (res.stderr ? '\n<span class="err">' + esc(res.stderr) + '</span>' : '') +
            (res.error ? '<span class="err">' + esc(res.error) + '</span>' : '') || '<span class="ok">（无输出）</span>';
          sess.lab[q.uid] = Object.assign({}, sess.lab[q.uid], { code });
          Store.save();
        } else {
          const res = await PyRun.judge(q, code, { onProgress });
          const head = res.passed ? '<span class="ok">✓ 判题通过！</span>' : '<span class="err">✗ 未通过</span>';
          out.innerHTML = head + '\n' + (res.output ? esc(res.output) + '\n' : '') + esc(res.detail);
          const prev = sess.lab[q.uid] || {};
          sess.lab[q.uid] = Object.assign({}, prev, { code, passed: res.passed || prev.passed });
          if (!prev.passed) recordAnswer(q, res.passed, code);
          Store.save();
          if (res.passed) toast('判题通过 ✓ 记得用费曼法讲一遍思路');
          else toast('还没通过，先用「提示」逐级推进');
          const badge = item.querySelector('.quiz-title');
          if (res.passed && !badge.querySelector('.badge.green')) badge.insertAdjacentHTML('beforeend', ' <span class="badge green">已通过</span>');
        }
      } catch (err) {
        out.innerHTML = '<span class="err">运行时错误：' + esc(err.message) + '</span>';
      }
    }
    if (act === 'hint') {
      const item = btn.closest('.lab-item');
      const q = currentQuiz.lab.find(x => x.uid === item.dataset.q);
      const box = item.querySelector('.lab-hint');
      const sess = sessionOf(currentLesson.id);
      const rec = sess.lab[q.uid] || {};
      const level = (rec.hintLevel || 0) + 1;
      sess.lab[q.uid] = Object.assign({}, rec, { hintLevel: level });
      Store.save();
      box.classList.remove('hidden');
      box.innerHTML = '<strong>提示 ' + Math.min(level, q.hints.length) + '/' + q.hints.length + '</strong>：' +
        q.hints.slice(0, level).map((h, i) => '<div>' + (i + 1) + '. ' + esc(h) + '</div>').join('');
      if (level >= q.hints.length) toast('提示用完了，试着写完再看参考解答');
    }
    if (act === 'solution') {
      const item = btn.closest('.lab-item');
      const box = item.querySelector('.lab-solution');
      box.classList.toggle('hidden');
      if (!box.classList.contains('hidden')) toast('看过答案后，请合上再独立写一遍 —— 这是费曼法的关键');
    }
    if (act === 'save-code') {
      const item = btn.closest('.lab-item');
      const code = item.querySelector('.lab-editor').value;
      const n = state.notes[currentLesson.id] || {};
      n.code = code; state.notes[currentLesson.id] = n; Store.save();
      toast('代码已存入这一天笔记');
    }
    if (act === 'save-feynman' || act === 'save-note') {
      const n = state.notes[currentLesson.id] || {};
      const f = document.getElementById('feynman-input');
      const t = document.getElementById('note-input');
      const c = document.getElementById('note-code');
      if (f) n.feynman = f.value;
      if (t) n.note = t.value;
      if (c) n.code = c.value;
      state.notes[currentLesson.id] = n; Store.save(true);
      toast('已保存到笔记册，并实时同步给导师');
    }
    if (act === 'self-check') {
      const sess = sessionOf(currentLesson.id);
      sess.feynmanSelf = btn.dataset.v; Store.save();
      const msg = { ok: '很好，能讲清就是真的懂了', half: '卡壳处请回到第 2 步的最小事实', no: '建议重读原文，明天再复述一次' }[btn.dataset.v];
      toast(msg);
    }
    if (act === 'add-comment') {
      captureDrafts();
      const text = document.getElementById('comment-input').value.trim();
      if (!text) { toast('先写点什么吧'); return; }
      state.comments.push({
        id: 'c' + Date.now(), ts: new Date().toISOString(), lessonId: currentLesson.id,
        kind: document.getElementById('comment-kind').value, text, pending: true
      });
      delete state.drafts[draftKey('comment', currentLesson.id)];
      Store.save(true);
      const x = I();
      if (x && x.mentor) {
        // local 模式下导师读 records/；agent 模式额外把问题 POST 给自己的服务
        x.mentor.ask({
          day: currentLesson.day, lessonId: currentLesson.id,
          question: text, kind: document.getElementById('comment-kind').value,
          drafts: JSON.parse(JSON.stringify(state.drafts || {})),
          attempts: (state.attempts || []).slice(-20)
        }).catch(() => {});
      }
      toast('已发布，导师会在联动模式里看到');
      viewLesson(new URLSearchParams('day=' + currentLesson.day));
    }
    if (act === 'finish') {
      const sess = sessionOf(currentLesson.id);
      const mcqOk = currentQuiz.mcq.filter(q => sess.mcq[q.uid] && sess.mcq[q.uid].correct).length;
      const labOk = currentQuiz.lab.filter(q => sess.lab[q.uid] && sess.lab[q.uid].passed).length;
      const score = mcqOk + labOk;
      state.progress[currentLesson.id] = {
        status: 'done', completedAt: new Date().toISOString(), score,
        mcqOk, labOk, feynmanSelf: sess.feynmanSelf
      };
      markActivity('lesson', true);
      Store.save(true);
      toast('Day ' + currentLesson.day + ' 打卡完成！得分 ' + score + '/' + fullScore(currentLesson));
      const next = currentLesson.day < C.lessons.length ? lessonByDay(currentLesson.day + 1) : null;
      const hint = document.getElementById('finish-hint');
      if (hint) hint.innerHTML = '✓ 已完成 · 得分 ' + score + '/' + fullScore(currentLesson) + '　' +
        (next ? '<a href="lesson.html?day=' + next.day + '">进入 Day ' + next.day + ' →</a>' : '全部课程完成，去做项目吧！');
    }
    if (act === 'pg-run') pgRun();
    if (act === 'pg-clear') document.getElementById('pg-editor').value = '';
    if (act === 'pg-save') {
      const code = document.getElementById('pg-editor').value;
      if (!code.trim()) return;
      state.snippets.push({ ts: new Date().toISOString(), title: code.trim().split('\n')[0].slice(0, 60), code });
      Store.save(); renderSnippets(); toast('片段已保存');
    }
    if (act === 'export-history') {
      const rows = [['时间', '课程', '类型', '题目', '结果']].concat(state.attempts.map(a =>
        [fmt(a.ts, true), a.lessonTitle, a.type, (a.stem || '').replace(/[",\n]/g, ' '), a.correct ? '正确' : '错误']));
      download('做题历史.csv', '\ufeff' + rows.map(r => r.map(x => '"' + String(x).replace(/"/g, '""') + '"').join(',')).join('\n'), 'text/csv;charset=utf-8');
    }
    if (act === 'sync-notes') syncNotes();
    if (act === 'download-notes') {
      const p = new URLSearchParams(location.search);
      const l = lessonBy(p.get('id')) || nextLesson();
      download('Day-' + String(l.day).padStart(3, '0') + '.md', buildNoteMd(l), 'text/markdown;charset=utf-8');
    }
    if (act === 'download-bundle') {
      let all = buildIndexMd() + '\n\n' + buildWrongMd() + '\n\n' + buildReport();
      Object.keys(state.notes).forEach(id => { const l = lessonBy(id); if (l) all += '\n\n===== Day-' + String(l.day).padStart(3, '0') + '.md =====\n\n' + buildNoteMd(l); });
      download('笔记册合集.md', all, 'text/markdown;charset=utf-8');
    }
    if (act === 'save-note-full') {
      const id = btn.dataset.id;
      state.notes[id] = {
        feynman: document.getElementById('n-feynman').value,
        note: document.getElementById('n-note').value,
        code: document.getElementById('n-code').value,
        updatedAt: new Date().toISOString()
      };
      Store.save(true); toast('已保存，可同步到 Obsidian');
    }
    if (act === 'export-report') {
      download('学习周报-' + todayStr() + '.md', buildReport(), 'text/markdown;charset=utf-8');
    }
    if (act === 'save-report') {
      const x = I();
      const result = (x && x.report)
        ? await x.report.write(buildReport(), {
            online, apiUrl, download, headers: () => apiHeaders()
          })
        : { ok: false, message: '请先启动 start.bat 开启联动' };
      toast(result.message);
    }
    if (act === 'export-json') download('pyfirst-backup-' + todayStr() + '.json', JSON.stringify(state, null, 2), 'application/json');
    if (act === 'import-json') document.getElementById('import-file').click();
    if (act === 'reset') {
      if (!confirm('这会清空所有做题记录、笔记与进度，且不可恢复。确定吗？')) return;
      if (!confirm('再确认一次：真的要清空吗？建议先导出备份。')) return;
      state = blankState(); await Store.replace(); location.reload();
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target.id !== 'import-file') return;
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        state = normalizeState(JSON.parse(reader.result));
        await Store.replace(); toast('导入成功'); setTimeout(() => location.reload(), 600);
      } catch (err) { toast('文件格式不对：' + err.message); }
    };
    reader.readAsText(file);
  });

  /* ---------------- 草稿实时自动保存 ----------------
   * 每敲一个字都写进 state → localStorage → records/state.json。
   * 页面重绘、刷新、关掉浏览器都不会把没点「保存」的内容弄丢。
   */
  function autosaveInput(e) {
    const t = e.target;
    if (!t) return;
    const id = t.id;
    const NOTE_FIELD = { 'feynman-input': 'feynman', 'note-input': 'note', 'note-code': 'code' };
    if (NOTE_FIELD[id]) {
      if (!currentLesson) return;
      const n = state.notes[currentLesson.id] || {};
      n[NOTE_FIELD[id]] = t.value;
      state.notes[currentLesson.id] = n;
      Store.save();
    } else if (id === 'comment-input' || id === 'comment-kind') {
      if (!currentLesson) return;
      state.drafts[draftKey(id === 'comment-input' ? 'comment' : 'commentKind',
                            currentLesson.id)] = t.value;
      Store.save();
    } else if (id === 'pg-editor') {
      state.drafts.playground = t.value;
      Store.save();
    } else if (t.classList && t.classList.contains('lab-editor')) {
      const item = t.closest('.lab-item');
      const q = item && (currentQuiz.lab || []).find(x => x.uid === item.dataset.q);
      if (q && currentLesson) {
        const sess = sessionOf(currentLesson.id);
        sess.lab[q.uid] = Object.assign({}, sess.lab[q.uid], { code: t.value });
        Store.save();
      }
    }
  }
  document.addEventListener('input', autosaveInput);
  document.addEventListener('change', autosaveInput);

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target.classList.contains('lab-editor')) {
      const item = e.target.closest('.lab-item');
      const b = item.querySelector('[data-action="judge"]');
      if (b) b.click();
    }
  });

  /* ---------------- 启动 ---------------- */
  async function init() {
    injectTopbar();
    await Store.init();
    if (retiredCount) Store.save();
    await Store.loadMentor();
    const page = document.body.dataset.page || 'home';
    const params = new URLSearchParams(location.search);
    const views = { home: viewHome, catalog: viewCatalog, lesson: viewLesson, playground: viewPlayground,
      review: viewReview, notes: viewNotes, progress: viewProgress };
    (views[page] || viewHome)(params);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
