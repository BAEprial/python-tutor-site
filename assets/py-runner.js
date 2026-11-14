/* Pyodide 运行时封装：浏览器内执行 Python、捕获输出、自动判题。
 * 版本与 CDN 来自 window.COURSE.meta.pyodide（核实于 2026-11-14）。
 */
window.PyRun = (function () {
  'use strict';

  let pyodide = null;
  let loading = null;
  let stdout = [];
  let stderr = [];
  let interruptView = null;

  function cfg() {
    return (window.COURSE && window.COURSE.meta.pyodide) || {
      cdn: 'https://cdn.jsdelivr.net/pyodide/v314.0.8/full/',
      version: '314.0.8'
    };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error('无法加载 Pyodide 脚本：' + src));
      document.head.appendChild(el);
    });
  }

  async function ensure(onProgress) {
    if (pyodide) return pyodide;
    if (loading) return loading;
    const info = cfg();
    loading = (async () => {
      if (onProgress) onProgress('正在下载 Python 运行时（首次约 10~20 MB，之后浏览器会缓存）…');
      if (typeof window.loadPyodide !== 'function') {
        await loadScript(info.cdn + 'pyodide.js');
      }
      if (onProgress) onProgress('正在启动 CPython WebAssembly…');
      pyodide = await window.loadPyodide({ indexURL: info.cdn });
      pyodide.setStdout({ batched: (s) => stdout.push(s) });
      pyodide.setStderr({ batched: (s) => stderr.push(s) });

      // 跨源隔离环境下可用 SharedArrayBuffer 中断死循环
      if (window.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') {
        try {
          const buf = new SharedArrayBuffer(1);
          interruptView = new Int32Array(buf);
          pyodide.setInterruptBuffer(buf);
        } catch (_) { interruptView = null; }
      }
      if (onProgress) onProgress('Python 已就绪');
      return pyodide;
    })();
    try {
      return await loading;
    } catch (err) {
      loading = null;
      throw err;
    }
  }

  function buildCompareScript(q) {
    const j = q.judge;
    const tuples = j.cases.map(args => {
      if (!args.length) return '()';
      return '(' + args.join(', ') + (args.length === 1 ? ',' : '') + ')';
    }).join(', ');
    const lines = [
      j.ref,
      '',
      '# ---- 你的代码 ----',
      '{{USER_CODE}}',
      '',
      '__CASES__ = [' + tuples + ']'
    ];
    if (j.refCall === true) {
      lines.push('__XS__ = [0, 1, 2, 5, -3, 10]');
      lines.push('for __args in __CASES__:');
      lines.push('    __uf, __rf = solve(*__args), __ref__(*__args)');
      lines.push('    for __x in __XS__:');
      lines.push('        __got, __exp = __uf(__x), __rf(__x)');
      lines.push('        assert __got == __exp, f"输入 {__args} 再传 {__x} → 得到 {__got!r}，期望 {__exp!r}"');
    } else if (j.refCall === 'list') {
      lines.push('for __args in __CASES__:');
      lines.push('    __got, __exp = list(solve(*__args)), __ref__(*__args)');
      lines.push('    assert __got == __exp, f"输入 {__args} → 得到 {__got!r}，期望 {__exp!r}"');
    } else {
      lines.push('for __args in __CASES__:');
      lines.push('    __got, __exp = solve(*__args), __ref__(*__args)');
      lines.push('    assert __got == __exp, f"输入 {__args} → 得到 {__got!r}，期望 {__exp!r}"');
    }
    lines.push('print("' + q.token + '")');
    return lines.join('\n');
  }

  // 入门期「直接写代码 → 看输出」判题：把 stdout 捕获后再逐条比对。
  // 用户代码用 JSON 字符串传入，避免引号 / 换行 / 中文破坏 Python 字面量。
  function pyLit(s) { return JSON.stringify(String(s == null ? '' : s)); }

  // 中文输入法常把「，。！」这类全角标点带进代码；屏幕上看与半角几乎一样，
  // 但字符串内容不同，判题就会失败。这里把差异直接说清楚，而不是只报「输出不匹配」。
  const FULLWIDTH_RE = /[，。：；！？（）［］｛｝＂＇、＝＋－＊／％＜＞]/;
  function normPunct(s) {
    return String(s == null ? '' : s)
      .replace(/，/g, ',').replace(/。/g, '.').replace(/：/g, ':')
      .replace(/；/g, ';').replace(/！/g, '!').replace(/？/g, '?')
      .replace(/（/g, '(').replace(/）/g, ')')
      .replace(/＂/g, '"').replace(/＇/g, "'")
      .replace(/\s+/g, ' ').trim();
  }
  function normLoose(s) { return normPunct(s).replace(/\s/g, ''); }
  function punctuationHint(q, userCode, output) {
    const j = q.judge || {};
    const expect = j.expectLines ? j.expectLines.join('\n') : j.expect;
    const tips = [];
    if (FULLWIDTH_RE.test(userCode)) {
      tips.push('⚠️ 引号里面混进了中文全角标点。先分清两件事：引号（\' 或 "）只是包裹文字的外壳，两种引号完全等价；真正要比对的是引号「里面」的字符。请把「，」换成英文半角「,」，切到英文输入法再敲一次。');
    }
    if (expect !== undefined && output && normLoose(output) === normLoose(expect) && output !== expect) {
      tips.push('💡 只差空格或标点：期望 ' + JSON.stringify(expect) + '，实际 ' +
        JSON.stringify(output) + (j.looseSpace
          ? '。本题忽略空格差异（逗号后空不空格都算对），所以请检查引号里面的标点。'
          : '。请对照检查引号里面的文字，而不是引号本身。'));
    }
    return tips.length ? '\n' + tips.join('\n') : '';
  }
  function buildStdoutScript(q, userCode) {
    const j = q.judge || {};
    const lines = [
      'import io, contextlib, re',
      '__SRC__ = ' + pyLit(userCode),
      '__BUF__ = io.StringIO()',
      'with contextlib.redirect_stdout(__BUF__):',
      '    exec(compile(__SRC__, "<solution.py>", "exec"), {"__name__": "__main__"})',
      '__GOT__ = __BUF__.getvalue().strip()',
      'print(__GOT__)'
    ];
    if (j.nonEmpty) {
      lines.push('assert __GOT__, "屏幕上没有输出，请确认写了 print()"');
    }
    // looseSpace：入门期「照着敲一句文字」的题，逗号后那个空格只是英文书写习惯，
    // 不该成为会不会 print 的判据。逐题开启；计算结果 / 容器输出题仍逐字符严格比对。
    if (j.expect !== undefined) {
      const got = j.looseSpace ? 're.sub(r"\\s+", "", __GOT__)' : '__GOT__';
      const exp = j.looseSpace ? pyLit(String(j.expect).replace(/\s/g, '')) : pyLit(j.expect);
      lines.push('assert ' + got + ' == ' + exp +
        ', "输出应为 " + ' + pyLit(j.expect) + ' + "，实际是 " + __GOT__' +
        (j.looseSpace ? ' + "（本题忽略空格差异）"' : ''));
    }
    if (j.expectLines) {
      const got = j.looseSpace
        ? '[re.sub(r"\\s+", "", x) for x in __GOT__.splitlines()]'
        : '__GOT__.splitlines()';
      const exp = j.looseSpace
        ? j.expectLines.map(x => String(x).replace(/\s/g, ''))
        : j.expectLines;
      lines.push('assert ' + got + ' == ' + JSON.stringify(exp) +
        ', "每行输出要和题目要求一致，实际是 " + __GOT__');
    }
    if (j.contains) {
      lines.push('for __s in ' + JSON.stringify(j.contains) + ':');
      lines.push('    assert __s in __GOT__, "输出里应该包含「" + __s + "」，实际是 " + __GOT__');
    }
    if (j.pattern) {
      lines.push('assert re.search(' + pyLit(j.pattern) + ', __GOT__), "输出格式还不对，实际是 " + __GOT__');
    }
    if (j.codeMust) {
      lines.push('for __s in ' + JSON.stringify(j.codeMust) + ':');
      lines.push('    assert __s in __SRC__, "代码里需要用到 " + __s');
    }
    if (j.codeBan) {
      lines.push('for __s in ' + JSON.stringify(j.codeBan) + ':');
      lines.push('    assert __s not in __SRC__, "本题不需要 " + __s');
    }
    lines.push('print("' + q.token + '")');
    return lines.join('\n');
  }

  function buildScript(q, userCode) {
    if (q.judge.mode === 'stdout') return buildStdoutScript(q, userCode);
    if (q.judge.mode === 'custom') {
      return '# ---- 你的代码 ----\n' + userCode + '\n\n# ---- 判题检查 ----\n' + q.judge.code;
    }
    return buildCompareScript(q).replace('{{USER_CODE}}', userCode);
  }

  async function execPython(code, timeoutMs, onProgress) {
    await ensure(onProgress);
    stdout = [];
    stderr = [];
    const timer = { id: null };
    if (interruptView) {
      interruptView[0] = 0;
      timer.id = setTimeout(() => { interruptView[0] = 2; }, timeoutMs || 8000);
    }
    let error = '';
    let value;
    try {
      value = await pyodide.runPythonAsync(code);
    } catch (err) {
      error = (err && err.message) ? err.message : String(err);
    } finally {
      if (timer.id) { clearTimeout(timer.id); }
      if (interruptView) interruptView[0] = 0;
    }
    return {
      ok: !error,
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      error,
      value: value === undefined ? null : String(value)
    };
  }

  async function run(code, opts) {
    opts = opts || {};
    return execPython(code, opts.timeoutMs || 8000, opts.onProgress);
  }

  async function judge(q, userCode, opts) {
    opts = opts || {};
    const script = buildScript(q, userCode);
    const res = await execPython(script, opts.timeoutMs || 8000, opts.onProgress);
    const passed = res.stdout.split('\n').some(line => line.trim() === q.token);
    // 判题脚本里混入的用户 print 不应污染展示
    const clean = res.stdout.split('\n').filter(l => l.trim() !== q.token).join('\n');
    let detail = '';
    if (!passed) {
      if (/KeyboardInterrupt|interrupted/i.test(res.error)) {
        detail = '运行超时：代码里可能有死循环。检查 while 条件是否永远为真。';
      } else if (/AssertionError/.test(res.error)) {
        const last = res.error.split('\n').filter(Boolean).pop() || res.error;
        detail = '没通过：' + last.replace(/^.*?AssertionError:\s*/, '');
      } else if (res.error) {
        detail = '运行出错：' + res.error.split('\n').slice(-4).join('\n');
      } else {
        detail = '测试未通过：请对照题目要求检查边界情况（空列表、0、负数等）。';
      }
      detail += punctuationHint(q, userCode, clean);
    }
    return { passed, output: clean, stderr: res.stderr, detail, script };
  }

  return {
    ensure,
    run,
    judge,
    buildScript,
    isReady: () => !!pyodide,
    isInterruptible: () => !!interruptView,
    version: () => cfg().version + ' / CPython ' + (cfg().cpython || '3.14')
  };
})();
