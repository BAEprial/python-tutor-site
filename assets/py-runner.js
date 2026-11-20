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
  // 浏览器里不允许 input() 回退到原生 prompt()：那是模态框，会卡住判题、无法自动继续。
  // 用受控 stdin 队列代替；默认空行（题目若需模拟输入，用 setInputs 注入）。
  let stdinQueue = [];

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
      // 受控 stdin：input() 从队列取一行，队列空则返回空串。
      // 浏览器里绝不让 input() 弹原生 prompt()——会阻塞判题，用户以为「不填就不判」。
      try {
        if (typeof pyodide.setStdin === 'function') {
          pyodide.setStdin({ stdin: () => (stdinQueue.length ? stdinQueue.shift() : '') });
        }
      } catch (_) { /* 版本不支持时忽略，仍不会比 prompt() 更差 */ }

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
  // 注释里的中文标点不该被当作代码错误：先把 # 注释行去掉再判断。
  function codeWithoutComments(src) {
    return String(src == null ? '' : src).split('\n').map(l => l.replace(/#.*$/, '')).join('\n');
  }
  // 提示必须依据「实际错误类型」，而不是扫到任意全角字符就套话术：
  // 脚手架注释里常有中文逗号，之前会误报成「引号里混进全角标点」，掩盖真正的语法错误。
  function punctuationHint(q, userCode, output, error) {
    const j = q.judge || {};
    const expect = j.expectLines ? j.expectLines.join('\n') : j.expect;
    const tips = [];
    const err = error || '';
    if (/\bSyntaxError\b/i.test(err) && /comma|invalid syntax/i.test(err)) {
      // print(7//2 7/2) 这类：两个表达式之间少了逗号。
      tips.push('💡 这是语法错误：print() 里要同时显示多个值时，值与值之间要用英文逗号隔开。例如 print(7 // 2, 7 / 2)。请检查相邻两个表达式之间有没有逗号。');
    } else if (/\bSyntaxError\b/i.test(err) && FULLWIDTH_RE.test(codeWithoutComments(userCode))) {
      // 确实是代码正文（非注释）里混进全角标点导致的语法错误。
      tips.push('💡 代码正文里混进了中文全角标点，例如（ ） ， ：。括号、逗号、冒号都要用英文半角，切到英文输入法再敲一次。');
    } else if (expect !== undefined && output && normLoose(output) === normLoose(expect) && output !== expect) {
      // 只有「输出内容只差空格或标点」时才谈引号内部的字符。
      tips.push('💡 输出只差空格或标点：期望 ' + JSON.stringify(expect) + '，实际 ' +
        JSON.stringify(output) + (j.looseSpace
          ? '。本题忽略空格差异（逗号后空不空格都算对），所以请检查引号里面的标点。'
          : '。请对照检查引号里面的文字，而不是引号本身。'));
    }
    return tips.length ? '\n' + tips.join('\n') : '';
  }
  function buildStdoutScript(q, userCode) {
    const j = q.judge || {};
    // 用交互式内核执行：表达式回显与 print 一样计入 stdout。
    // 这样学员写 len("中文")（不套 print）也能得到「2」并通过判题，
    // 与代码文件式运行器的行为一致；老写法 print(len("中文")) 照常通过。
    // 按 AST 拆顶层语句：表达式用 single（回显），块用 exec（保证 for/if/def 完整）。
    const lines = [
      'import io, contextlib, re, ast as _ast',
      '__SRC__ = ' + pyLit(userCode),
      '__BUF__ = io.StringIO()',
      '__ERRBUF__ = io.StringIO()',
      'with contextlib.redirect_stdout(__BUF__), contextlib.redirect_stderr(__ERRBUF__):',
      '    __NS__ = {"__name__": "__main__"}',
      '    __TREE__ = _ast.parse(__SRC__)',
      '    for __N__ in __TREE__.body:',
      '        if isinstance(__N__, _ast.Expr):',
      '            exec(compile(_ast.Interactive(body=[__N__]), "<solution.py>", "single"), __NS__)',
      '        else:',
      '            __M__ = _ast.Module(body=[__N__], type_ignores=[])',
      '            _ast.fix_missing_locations(__M__)',
      '            exec(compile(__M__, "<solution.py>", "exec"), __NS__)',
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
    stdinQueue = [];   // 每次运行重置，避免上一题的输入串到下一题
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

  /* 代码文件式运行：写完整的多行代码，一次执行，表达式自动回显。
   * 按 AST 拆成顶层语句：表达式语句用 compile(..., 'single') 触发 displayhook 回显，
   * 其余语句（for/if/def/try 等块）用 'exec' 编译，保证块结构完整。
   * 这就是 Jupyter/IDLE 单元格的行为——既保留「写代码文件」的完整感，
   * 又保留学员要求的「直接 len("中文") 就显示 2、不用套 print」。
   * 每次调用用全新命名空间，等价于重新跑一遍完整脚本。
   */
  const CELL_BOOTSTRAP = [
    'import io as _wb_io, json as _wb_json, contextlib as _wb_ctx, ast as _wb_ast',
    'def _wb_run_cell(src, ns=None):',
    '    ns = ns if ns is not None else {"__name__": "__cell__"}',
    '    out, err = _wb_io.StringIO(), _wb_io.StringIO()',
    '    with _wb_ctx.redirect_stdout(out), _wb_ctx.redirect_stderr(err):',
    '        tree = _wb_ast.parse(src)',
    '        for __n__ in tree.body:',
    '            if isinstance(__n__, _wb_ast.Expr):',
    '                exec(compile(_wb_ast.Interactive(body=[__n__]), "<cell>", "single"), ns)',
    '            else:',
    '                __m__ = _wb_ast.Module(body=[__n__], type_ignores=[])',
    '                _wb_ast.fix_missing_locations(__m__)',
    '                exec(compile(__m__, "<cell>", "exec"), ns)',
    '    return _wb_json.dumps({"out": out.getvalue(), "err": err.getvalue()})'
  ].join('\n');
  let cellBoot = null;

  async function ensureCell() {
    await ensure();
    if (cellBoot) return;
    await pyodide.runPythonAsync(CELL_BOOTSTRAP);
    cellBoot = true;
  }

  async function runCell(code, opts) {
    opts = opts || {};
    if (opts.onProgress) opts.onProgress('正在运行…');
    await ensureCell();
    stdout = [];
    stderr = [];
    const src = JSON.stringify(String(code == null ? '' : code));
    try {
      const raw = await pyodide.runPythonAsync('_wb_run_cell(' + src + ')');
      return JSON.parse(String(raw));
    } catch (e) {
      return { out: '', err: (e && e.message) ? e.message : String(e) };
    }
  }

  /* 交互式解释器：用 Pyodide 官方 pyodide.console.PyodideConsole（314 版）。
   * 官方 Console 负责 sys.displayhook 回显、stdout/stderr 重定向、多行缓冲与
   * syntax_check（incomplete / syntax-error / complete），比手写 InteractiveConsole 稳。
   * 按 sid 隔离命名空间：课程每道编程题一个会话，互不串变量。
   */
  const REPL_BOOTSTRAP = [
    'import json as _wb_json',
    'from pyodide.console import PyodideConsole as _WBConsole',
    '_wb_consoles = {}',
    '_wb_bufs = {}',
    'def _wb_console(sid):',
    '    c = _wb_consoles.get(sid)',
    '    if c is None:',
    '        def _so(s, _k=sid):',
    '            _wb_bufs.setdefault(_k, {"out": [], "err": []})["out"].append(s)',
    '        def _se(s, _k=sid):',
    '            _wb_bufs.setdefault(_k, {"out": [], "err": []})["err"].append(s)',
    '        c = _WBConsole(globals={"__name__": "__console__"}, stdout_callback=_so, stderr_callback=_se, stdin_callback=lambda n: "")',
    '        _wb_consoles[sid] = c',
    '    return c',
    'async def _wb_repl_feed(sid, line):',
    '    c = _wb_console(sid)',
    '    _wb_bufs[sid] = {"out": [], "err": []}',
    '    fut = c.push(line)',
    '    check = fut.syntax_check',
    '    ex = None',
    '    if check != "incomplete":',
    '        try:',
    '            await fut',
    '        except BaseException as _e:',
    '            ex = _e',
    '    b = _wb_bufs[sid]',
    '    out = "".join(b["out"])',
    '    err = "".join(b["err"])',
    '    if check == "syntax-error" and getattr(fut, "formatted_error", None):',
    '        err = fut.formatted_error',
    '    elif not err and ex is not None:',
    '        err = str(ex)',
    '    try:',
    '        val = fut.result()',
    '    except BaseException:',
    '        val = None',
    '    # 官方 Console 不把表达式结果写 stdout，值在 future 里；按 REPL 惯例回显 repr',
    '    return _wb_json.dumps({"more": check == "incomplete", "check": check, "out": out, "err": err, "val": None if val is None else repr(val)})',
    'def _wb_repl_reset(sid):',
    '    _wb_consoles.pop(sid, None)',
    '    _wb_bufs.pop(sid, None)'
  ].join('\n');
  let replBoot = null;

  async function ensureRepl() {
    await ensure();
    if (replBoot) return;
    await pyodide.runPythonAsync(REPL_BOOTSTRAP);
    replBoot = true;
  }

  async function replFeed(line, sid) {
    await ensureRepl();
    const id = sid || 'pg';
    const src = 'await _wb_repl_feed(' + JSON.stringify(id) + ', ' + JSON.stringify(String(line)) + ')';
    const raw = await pyodide.runPythonAsync(src);
    return JSON.parse(String(raw));
  }

  async function replReset(sid) {
    await ensureRepl();
    await pyodide.runPythonAsync('_wb_repl_reset(' + JSON.stringify(sid || 'pg') + ')');
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
      detail += punctuationHint(q, userCode, clean, res.error);
    }
    return { passed, output: clean, stderr: res.stderr, detail, script };
  }

  return {
    ensure,
    run,
    runCell,
    judge,
    buildScript,
    replFeed,
    replReset,
    setInputs: (lines) => { stdinQueue = (Array.isArray(lines) ? lines : [lines]).map(String); },
    isReady: () => !!pyodide,
    isInterruptible: () => !!interruptView,
    version: () => cfg().version + ' / CPython ' + (cfg().cpython || '3.14')
  };
})();
