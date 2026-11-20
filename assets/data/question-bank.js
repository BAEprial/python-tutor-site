/* 题库与每日组卷调度器。
 * 每天的选择 / 编程 / 费曼数量由 course.js 的 lesson.plan 给出（3~5 / 1~3 / 0~1），
 * 核心约束：只考「截至今天已经教过」的内容。
 * 每道题由 tags 推出 unlock（所需知识点里最晚的解锁日），组卷时硬过滤 unlock <= day。
 * 早期零基础题在 entry-bank.js（stdout 型判题，不要求先学 def）。
 */
window.QB = (function () {
  'use strict';

  /* ============ 知识点解锁表 ============
   * 数字 = 该知识点在本站 112 天课程里第一次被讲到的 Day。
   * 这样「简介」页绝不会冒出 dict 的 key、装饰器或 pip。
   */
  const TAG_DAY = {
    orientation: 1, computer: 1, python_intro: 1,
    history: 2, install: 3, interpreter: 4,
    hello: 5, print: 5, editor: 6, io: 7,
    datatype: 8, variable: 8, number: 8, pep8: 8,
    string: 10, encoding: 10,
    list: 11, tuple: 11,
    condition: 12, match: 13, loop: 14,
    dict: 15, set: 15,
    function: 16, call: 17, params: 19, recursion: 20,
    slice: 21, iteration: 23, comprehension: 24, generator: 25, iterator: 26,
    higherorder: 27, mapreduce: 29, filter: 30, sorted: 31,
    closure: 32, lambda: 33, decorator: 34, partial: 35,
    module: 36, pip: 38, venv: 38,
    class: 39, access: 41, inheritance: 42, introspection: 43, classattr: 44,
    slots: 45, property: 47, mixin: 48, dunder: 49, enum: 50, metaclass: 51,
    error: 52, debug: 54, testing: 55, unittest: 55, doctest: 56,
    fileio: 57, stringio: 59, pathlib: 60,
    serialization: 61, json: 61, pickle: 61,
    process: 62, thread: 64, threadlocal: 65, distributed: 67,
    regex: 68, datetime: 69, collections: 71, argparse: 72,
    base64: 73, struct: 74, hashlib: 75, hmac: 76, itertools: 77,
    contextlib: 78, urllib: 79, xml: 80, htmlparser: 81,
    thirdparty: 83, pillow: 84, requests: 85, chardet: 86, psutil: 87,
    gui: 88, turtle: 89, tcpip: 90, socket: 92, udp: 93,
    smtp: 94, pop3: 96, sqlite: 97, mysql: 99, sqlalchemy: 100,
    http: 102, html: 103, wsgi: 104, framework: 105, template: 106,
    coroutine: 108, asyncio: 109, aiohttp: 110,
    faq: 111, summary: 112
  };
  const TAG_LABEL = {
    orientation: '课程定位', computer: '计算机常识', python_intro: '什么是 Python',
    history: 'Python 版本', install: '安装与命令行', interpreter: '解释器',
    hello: '第一个程序', print: 'print()', editor: '编辑器与 .py 文件', io: '输入与输出',
    datatype: '变量与数据类型', variable: '变量', number: '数字运算', pep8: '代码规范',
    string: '字符串', encoding: '编码 str/bytes', list: 'list', tuple: 'tuple',
    condition: 'if / 缩进', match: 'match', loop: '循环', dict: 'dict', set: 'set',
    function: '函数定义', call: '函数调用', params: '函数参数', recursion: '递归',
    slice: '切片', iteration: '迭代', comprehension: '列表生成式',
    generator: '生成器', iterator: '迭代器', higherorder: '高阶函数',
    mapreduce: 'map/reduce', filter: 'filter', sorted: 'sorted', closure: '闭包',
    lambda: 'lambda', decorator: '装饰器', partial: '偏函数', module: '模块',
    pip: 'pip', venv: '虚拟环境', class: '类与实例', error: '异常', testing: '测试',
    fileio: '文件读写', process: '进程', thread: '线程', asyncio: 'asyncio'
  };
  // 章组名与哨兵词不参与解锁计算
  const GROUP_TAGS = new Set([
    'general', 'meta', 'basics', 'advanced', 'functional', 'module_group',
    'quality', 'io_group', 'stdlib', 'concurrency', 'network', 'data', 'web',
    'thirdparty_group', 'oop', 'testing_group', 'early', 'scope'
  ]);
  // 少数题的 tags 不够精确，按题目内容手动校准（数字 = 直接指定解锁日）
  const REQ_OVERRIDE = {
    m014: 43,   // isinstance / bool 是 int 子类 → 面向对象「获取对象信息」
    m052: 38,   // venv 在「安装第三方模块」首次出现，而非 venv 模块那节
    m008: 53,   // Traceback 读法在「错误处理」才真正展开
    m049: 37,   // import 执行时机在「使用模块」
    m066: 54,   // assert 在「调试」
    m064: 53,   // except 写法在「错误处理」
    m019: 15    // tuple 能否作 dict 的 key，要等讲完 dict 才能判断
  };

  function scopeOf(q) {
    const tags = (q.tags || []).filter(t => !GROUP_TAGS.has(t));
    const req = tags.filter(t => TAG_DAY[t] !== undefined);
    let unlock = req.length ? Math.max.apply(null, req.map(t => TAG_DAY[t])) : 18;
    if (REQ_OVERRIDE[q.id] !== undefined) unlock = REQ_OVERRIDE[q.id];
    // compare / custom 题的代码骨架是 def solve(...)：必须等 Day 18「定义函数」之后
    if (q.type === 'lab' && q.mode !== 'stdout' && q.unlock === undefined) {
      unlock = Math.max(unlock, 18);
    }
    return {
      req: req.length ? req : ['general'],
      unlock: q.unlock !== undefined ? q.unlock : unlock,
      fallback: req.length === 0 && REQ_OVERRIDE[q.id] === undefined
    };
  }
  function decorate(q) {
    const s = scopeOf(q);
    q.req = s.req;
    q.unlock = s.unlock;
    q.fallback = s.fallback;
    return q;
  }
  function reqLabel(q) {
    return (q.req || []).map(t => TAG_LABEL[t] || t).join(' · ');
  }

  const M = (id, tags, level, stem, options, answer, explain) => decorate({
    id, tags: tags.split(' '), level, stem, options, answer, explain, gen: false
  });
  // 生成题的统一护栏：make() 返回的四个选项必须两两不同。
  // 某些参数组合会让多个错误算式退化成同一个值（g001 的 c=1、g002 的切片重叠等），
  // 这里换随机实例重抽；极端情况下仍冲突则用不重复的占位值补足，绝不放行重复选项。
  function ensureDistinct(b, remake) {
    if (!b || !Array.isArray(b.options)) return b;
    const uniq = o => new Set(o.map(String)).size === o.length;
    let tries = 0;
    while (!uniq(b.options) && tries < 24) { b = remake(); tries++; }
    if (!uniq(b.options)) {
      const opts = b.options.map(String);
      const used = new Set(opts);
      let pad = 0;
      for (let i = 0; i < opts.length; i++) {
        if (i === b.answer) continue;
        if (used.has(opts[i])) {
          let v;
          do { v = String(pad++); } while (used.has(v));
          opts[i] = v; used.add(v);
        }
      }
      b.options = opts;
    }
    return b;
  }
  const G = (id, tags, level, make) => decorate({
    id, tags: tags.split(' '), level, make: (r) => ensureDistinct(make(r), () => make(r)), gen: true
  });
  const L = (id, tags, level, make) => decorate({
    id, tags: tags.split(' '), level, make, type: 'lab'
  });
  // entry-bank.js 里的零基础题自带 unlock，走同一套 decorate
  function adopt(list) { return (list || []).map(decorate); }

  /* ---------------- 选择题：概念题 ---------------- */
  const MCQ = [
    M('m001', 'meta orientation general', 1, 'CPU 能直接执行的是什么？', ['Python 源码', '机器指令', '中文注释', 'HTML 标签'], 1, '任何高级语言最终都要翻译成 CPU 认识的机器指令。'),
    M('m002', 'meta orientation general', 1, '关于「高级语言代码更短」，下列说法正确的是？', ['一定运行更快', '表达同一意图的代码量更少，但通常更慢', '不需要解释器', '只能做网站'], 1, '抽象换来表达效率，代价通常是运行速度与可控性。'),
    M('m003', 'meta history general', 1, '本教程基于哪个 Python 大版本？', ['Python 2', 'Python 3', 'Python 1', 'Jython'], 1, 'print 在 Python 3 是函数，2.x 的 print 语句不能直接用。'),
    M('m004', 'meta install general', 1, '验证解释器是否装好，最直接的命令行是？', ['python --version', 'python --hello', 'dir python', 'python --list'], 0, 'python --version 输出版本号；PATH 没配好会提示找不到命令。'),
    M('m005', 'meta interpreter general', 1, '关于 CPython 与 IPython，正确的是？', ['两者都是语言规范', 'CPython 是解释器实现，IPython 是增强的交互环境', 'IPython 是一门新语言', '.py 文件里可写 IPython 魔法命令'], 1, '魔法命令只属于交互环境，写进 .py 会报语法错。'),
    M('m006', 'meta pep8 general', 1, 'PEP 8 推荐的缩进方式是？', ['1 个 Tab', '4 个空格', '8 个空格', '2 个空格'], 1, '统一用 4 空格；Tab 与空格混用会触发 IndentationError。'),
    M('m007', 'meta pep8 general', 1, '下面哪个变量名最符合 PEP 8？', ['StudentName', 'student_name', 'studentName', 'STUDENTNAME'], 1, '变量用小写加下划线更易读；类和常量另有写法，讲到面向对象时再展开。'),
    M('m008', 'meta faq general', 2, '读 Traceback 时，最该先看的是？', ['第一行文件名', '最后一行异常类型与消息', '中间的空行', '代码行数'], 1, '最后一行给出异常类型与原因，往上才是调用栈位置。'),
    M('m009', 'meta summary general', 2, '学完语法后最应该做的下一步是？', ['再抄一遍笔记', '独立完成一个完整小项目', '直接背所有内置函数', '换一门语言'], 1, '工程能力来自把零散知识连成一条可交付的链路。'),
    M('m010', 'basics hello general', 1, 'print("Hi", 2026) 的输出是？', ['Hi2026', 'Hi 2026', 'Hi, 2026', '报错'], 1, 'print 多个参数默认用空格分隔，末尾自动换行。'),
    M('m011', 'basics io general', 1, 'input() 的返回值类型一定是？', ['int', 'str', 'float', '取决于输入内容'], 1, '输入「123」也是字符串 "123"，计算前必须 int() 转换。'),
    M('m012', 'basics datatype general', 1, '执行 a = 1; b = a; a = 2 后，b 的值是？', ['1', '2', 'None', '报错'], 0, '= 是把名字绑定到对象；重新绑定 a 不改变 b 指向的 1。'),
    M('m013', 'basics datatype general', 1, '7 // 2 与 7 / 2 的结果分别是？', ['3 和 3.5', '3.5 和 3.5', '3 和 3', '4 和 3.5'], 0, '// 是向下取整整除，/ 永远返回浮点数。'),
    M('m014', 'basics datatype general', 2, 'type(3) is int 与 isinstance(True, int) 的结果？', ['True 和 False', 'True 和 True', 'False 和 False', 'False 和 True'], 1, 'bool 是 int 的子类，因此 isinstance(True, int) 为 True。'),
    M('m015', 'basics string encoding general', 2, '"中".encode("utf-8") 得到几个字节？', ['1', '2', '3', '4'], 2, 'UTF-8 中常用汉字占 3 字节；len(str) 数的是字符数。'),
    M('m016', 'basics string encoding general', 2, '关于 str 与 bytes，正确的是？', ['可以直接相加', 'encode 把 str 变 bytes，decode 反向还原', 'bytes 有 .upper() 但没有 .decode()', '两者完全等价'], 1, '编码必须成对且一致，混用会抛 TypeError 或乱码。'),
    M('m017', 'basics string general', 1, '字符串不可变意味着？', ['不能切片', '不能用 + 拼接出新的字符串', '不能修改其中某个字符', '不能用 len()'], 2, 's[0] = "x" 会报错；但 s + "x" 会生成新对象。'),
    M('m018', 'basics list tuple general', 1, 'a = [1, 2]; a.append(3) 的返回值是？', ['[1, 2, 3]', '3', 'None', '报错'], 2, 'append 原地修改列表并返回 None，这是高频陷阱。'),
    M('m019', 'basics list tuple general', 1, '下列哪项是 tuple 的特性？', ['可 append', '不可变、可作 dict 的 key', '元素必须同类型', '不能切片'], 1, '不可变 → 可哈希 → 可作字典键或集合元素。'),
    M('m020', 'basics list tuple general', 2, 'a = [1]; b = a; b.append(2) 之后 a 是？', ['[1]', '[1, 2]', '[2]', '报错'], 1, '两个名字指向同一个可变列表对象。'),
    M('m021', 'basics condition general', 1, 'Python 用什么划分代码块？', ['大括号', '缩进', 'begin/end', '分号'], 1, '缩进是语法的一部分，同层代码必须对齐。'),
    M('m022', 'basics condition general', 2, 'if / elif / else 结构中会执行几条分支？', ['全部', '最多一条', '至少两条', '由缩进决定'], 1, '从上往下判断，命中后跳过其余分支。'),
    M('m023', 'basics match general', 2, 'match 语句中通配符 case _ 应该放在？', ['最前', '最后', '任意位置', '不能与 case 混用'], 1, '_ 匹配一切，放前面会屏蔽后续所有分支。'),
    M('m024', 'basics loop general', 1, 'range(1, 5) 产生的序列是？', ['1,2,3,4,5', '1,2,3,4', '0,1,2,3,4', '0,1,2,3'], 1, '左闭右开，不含 stop。'),
    M('m025', 'basics loop general', 2, 'break 与 continue 的区别是？', ['都结束循环', 'break 结束整个循环，continue 跳过本次剩余语句', 'continue 结束整个循环', '两者等价'], 1, 'continue 直接进入下一轮迭代。'),
    M('m026', 'basics dict set general', 1, '下列哪项不能作为 dict 的 key？', ['1', '"a"', '(1, 2)', '[1, 2]'], 3, 'key 必须可哈希；list 可变因此不可哈希。'),
    M('m027', 'basics dict set general', 2, 'set([1, 1, 2, 2, 3]) 的结果是？', ['[1, 2, 3]', '{1, 2, 3}', '{1: 2, 3: 1}', '报错'], 1, '集合自动去重且不保证顺序。'),
    M('m028', 'basics dict set general', 2, '遍历 dict 时，默认得到的是？', ['键值对元组', 'key', 'value', '索引'], 1, '要键值对用 d.items()，只要值用 d.values()。'),
    M('m029', 'function call general', 1, '定义函数时函数体何时执行？', ['执行 def 语句时', '调用函数时', '导入模块时', '保存文件时'], 1, 'def 只创建函数对象，调用才进入函数体。'),
    M('m030', 'function params general', 1, '没有 return 的函数返回什么？', ['0', '空字符串', 'None', '报错'], 2, '函数默认返回 None。'),
    M('m031', 'function params general', 2, '为什么 def f(a=[]) 是陷阱？', ['语法错误', '默认列表在函数定义时创建，被所有调用共享', '列表不能作参数', '会拖慢运行'], 1, '可变默认值只创建一次，应写 a=None 再在函数内建新列表。'),
    M('m032', 'function params general', 2, '*args 与 **kw 分别收集？', ['位置参数 / 关键字参数', '关键字参数 / 位置参数', '默认值 / 返回值', '全局变量 / 局部变量'], 0, '*args 得到 tuple，**kw 得到 dict。'),
    M('m033', 'function recursion general', 2, '递归函数必须具备？', ['至少两个参数', '基线条件且每步向基线靠近', '必须写成一行', '全局变量'], 1, '缺少出口会触发 RecursionError。'),
    M('m034', 'function higherorder general', 2, '「函数是一等对象」意味着？', ['只能定义在模块顶层', '可赋值、可作参数、可作返回值', '不能嵌套定义', '必须有返回值'], 1, '能赋值、能传参、能返回，是后面很多写法的基础。'),
    M('m035', 'advanced slice general', 2, 's = "abcdef"，s[1:4] 是？', ['"abc"', '"bcd"', '"bcde"', '"abcd"'], 1, '左闭右开，索引 1、2、3 → bcd。'),
    M('m036', 'advanced slice general', 2, 's[::-1] 的作用是？', ['取前三个', '反转序列', '删除最后一个', '步长为 1 的拷贝'], 1, 'step 为负表示从右往左取。'),
    M('m037', 'advanced iteration general', 2, 'for x in {"a": 1, "b": 2} 中 x 是？', ['"a" 再 "b"', '1 再 2', '("a",1) 再 ("b",2)', '索引'], 0, '字典默认迭代 key。'),
    M('m038', 'advanced comprehension general', 2, '[x*x for x in range(4) if x % 2 == 0] 的结果是？', ['[0, 4]', '[1, 9]', '[0, 1, 4, 9]', '[0, 4, 16]'], 0, 'x 取 0、2，平方得 0、4。'),
    M('m039', 'advanced generator general', 3, '生成器相比列表最大的优势是？', ['可以随机访问', '惰性求值、省内存', '可以被遍历多次', '元素可修改'], 1, 'yield 每次只产出一个值；但生成器只能消费一次。'),
    M('m040', 'advanced iterator general', 3, '关于 Iterable 与 Iterator，正确的是？', ['两者完全相同', 'list 是 Iterable 但不是 Iterator', 'Iterator 一定可重复遍历', 'Iterable 一定有 next()'], 1, 'iter(list) 才得到 Iterator；Iterator 有 __next__ 且会被消耗。'),
    M('m041', 'functional mapreduce general', 2, 'map(f, xs) 返回的是？', ['列表', '惰性迭代器', '字典', '生成器函数'], 1, 'Python 3 的 map/filter 返回迭代器，要 list() 才能看到内容。'),
    M('m042', 'functional filter general', 2, 'filter 的谓词函数应该返回？', ['新的元素', '布尔值', '索引', 'None'], 1, '返回真则保留该元素。'),
    M('m043', 'functional sorted general', 2, 'sorted(xs, key=len) 中 key 会？', ['只调用一次', '对每个元素调用一次，用返回值作比较依据', '修改原列表', '必须写成 len()'], 1, 'key 是函数对象，不要加括号调用。'),
    M('m044', 'functional closure general', 3, '闭包「记住」的是？', ['变量当时的值的副本', '定义时的环境（变量本身）', '函数的返回值', '全局命名空间'], 1, '循环里创建闭包常因延迟求值看到变量的最终值。'),
    M('m045', 'functional lambda general', 2, 'lambda 的语法限制是？', ['只能有一个参数', '函数体只能是一个表达式', '不能有返回值', '必须命名'], 1, '复杂逻辑请用 def，可读性更重要。'),
    M('m046', 'functional decorator general', 3, '@decorator 生效的时刻是？', ['函数调用时', '函数定义时', '模块卸载时', '第一次 print 时'], 1, '定义时就把原函数替换成 wrapper。'),
    M('m047', 'functional decorator general', 3, '定义装饰器时通常要加 functools.wraps，是为了？', ['加速', '保留原函数的 __name__ 等元信息', '支持多参数', '避免递归'], 1, '否则调试与文档工具看到的全是 wrapper。'),
    M('m048', 'functional partial general', 3, 'functools.partial 的作用是？', ['合并两个函数', '固定部分参数生成新可调用对象', '把函数变成生成器', '缓存返回值'], 1, '常用于回调与专用函数工厂。'),
    M('m049', 'module module_group general', 2, 'import some_module 时会发生什么？', ['什么也不做', '执行模块顶层代码并绑定名字', '只检查语法', '自动安装依赖'], 1, '所以可执行的测试代码要放进 if __name__ == "__main__":。'),
    M('m050', 'module pep8 general', 2, 'if __name__ == "__main__": 的作用是？', ['声明编码', '让文件既可被导入又可直接运行', '定义主函数', '启用多线程'], 1, '被导入时 __name__ 是模块名，不会执行这段。'),
    M('m051', 'module pep8 general', 2, '为什么不建议 from x import *？', ['语法已废弃', '污染命名空间、来源不清晰', '会变慢很多', '只能导入一个名字'], 1, '显式导入让名字来源可追踪。'),
    M('m052', 'module pip venv thirdparty general', 2, 'venv 解决的核心问题是？', ['提升运行速度', '隔离不同项目的依赖', '自动写代码', '替代解释器'], 1, '不同项目需要同一包的不同版本时，隔离是必须的。'),
    M('m053', 'oop class general', 2, '方法定义中的 self 是？', ['类名', '调用该方法的实例', '全局变量', '父类'], 1, 'Python 显式把实例作为第一个参数传入。'),
    M('m054', 'oop class general', 2, '__init__ 的调用时机是？', ['定义类时', '创建实例后自动调用', '每次访问属性时', '导入模块时'], 1, '它负责初始化实例状态。'),
    M('m055', 'oop access general', 3, '单下划线前缀 _x 表示？', ['真正的私有，外部绝对无法访问', '约定上的「内部使用」', '类属性', '常量'], 1, 'Python 靠约定；双下划线会触发名字改写但也不是安全边界。'),
    M('m056', 'oop inheritance general', 3, '多态带来的好处是？', ['运行更快', '调用方无需关心对象的具体子类', '减少文件数量', '自动修复 bug'], 1, '只要接口一致，新增子类不必改调用代码。'),
    M('m057', 'oop introspection general', 3, '检查对象是否属于某类型（含子类）用？', ['type(x) == T', 'isinstance(x, T)', 'dir(x)', 'id(x)'], 1, 'type 是精确比较，isinstance 考虑继承。'),
    M('m058', 'oop classattr general', 3, '类属性被谁共享？', ['每个实例各一份', '该类的所有实例', '只有第一个实例', '所有类'], 1, '可变类属性被多实例共享，容易踩坑。'),
    M('m059', 'oop slots general', 4, '__slots__ 的直接效果是？', ['让类可继承', '限制实例可绑定的属性名并省内存', '自动实现 __str__', '启用多线程'], 1, '子类不写 __slots__ 就重新获得 __dict__。'),
    M('m060', 'oop property general', 4, '@property 让方法可以？', ['被当作属性访问', '自动异步执行', '被继承为类方法', '替代 import'], 0, '调用方写 obj.x 而不是 obj.x()。'),
    M('m061', 'oop dunder general', 4, 'len(obj) 能作用于自定义类，是因为实现了？', ['__str__', '__len__', '__iter__', '__call__'], 1, '特殊方法让自定义对象接入内置语法。'),
    M('m062', 'oop enum general', 3, 'Enum 的主要价值是？', ['比字符串快十倍', '把有限个具名常量变成真正的类型', '自动生成文档', '替代字典'], 1, '避免散落的魔法数字与拼写错误。'),
    M('m063', 'oop metaclass general', 4, 'type(int) 的结果是？', ['int', 'type', 'object', 'function'], 1, '类也是对象，type 是默认元类。'),
    M('m064', 'quality error general', 2, '下列写法最危险的是？', ['except ValueError:', 'except Exception as e: log(e)', 'except: pass', 'finally: f.close()'], 2, '裸 except + pass 会吞掉所有错误，包括键盘中断。'),
    M('m065', 'quality error general', 3, 'finally 中的代码？', ['只在成功时执行', '只在异常时执行', '无论是否异常都会执行', '不会执行'], 2, '常用于释放资源。'),
    M('m066', 'quality debug general', 2, 'assert 最适合表达？', ['用户输入校验', '「这不可能发生」的内部不变量', '异常恢复', '日志归档'], 1, 'assert 可被 -O 关闭，不能替代输入校验。'),
    M('m067', 'quality unittest testing general', 3, 'unittest 自动发现测试方法要求方法名？', ['以 test 开头', '以 Test 开头', '任意', '以 _ 开头'], 0, '类继承 unittest.TestCase，方法名 test_*。'),
    M('m068', 'quality doctest testing general', 3, 'doctest 的示例写在？', ['注释里', 'docstring 的 >>> 之后', 'requirements.txt', '单独 md 文件'], 1, '文档示例可直接执行，防止示例过期。'),
    M('m069', 'io_group fileio general', 2, 'open(path, "r", encoding="utf-8") 中显式指定编码是为了？', ['加快读取', '避免不同系统默认编码不同导致乱码', '启用二进制模式', '自动关闭文件'], 1, '编码必须显式声明，跨平台才一致。'),
    M('m070', 'io_group fileio general', 2, 'with open(...) as f: 的主要好处是？', ['自动压缩', '退出块时自动关闭文件', '自动转码', '只读大文件'], 1, '即使中途抛异常也会关闭。'),
    M('m071', 'io_group stringio general', 3, 'StringIO 适合？', ['保存大文件', '在内存中模拟文本文件', '替代数据库', '压缩图片'], 1, 'BytesIO 是其 bytes 版本。'),
    M('m072', 'io_group pathlib general', 3, 'Path("a/b/c.txt").suffix 是？', ['"a/b"', '"c.txt"', '".txt"', '"c"'], 2, 'suffix 返回最后一个扩展名，含点。'),
    M('m073', 'io_group serialization json pickle general', 3, '关于 pickle，正确的是？', ['跨语言通用', '可反序列化任意对象，但绝不能处理不信任的数据', '只能存字符串', '比 json 更安全'], 1, '反序列化不可信数据可能执行任意代码。'),
    M('m074', 'concurrency process thread general', 4, 'GIL 带来的直接限制是？', ['不能开多线程', '纯 Python 线程难以并行利用多核跑 CPU 密集任务', '不能写异步代码', '不能用 socket'], 1, 'IO 密集仍可从线程获益，CPU 密集用多进程。'),
    M('m075', 'concurrency process general', 4, '进程与线程最关键的区别是？', ['进程更快', '进程有独立内存，线程共享内存', '线程不能被调度', '进程不能通信'], 1, '共享内存带来竞态，需要 Lock/Queue。'),
    M('m076', 'concurrency threadlocal general', 4, 'ThreadLocal 解决的是？', ['加速计算', '让每个线程拥有独立的数据副本', '跨进程传值', '自动加锁'], 1, '常用于保存请求上下文。'),
    M('m077', 'concurrency coroutine asyncio general', 5, 'await 的作用是？', ['开启新线程', '把控制权交还事件循环，等待可等待对象', '强制同步执行', '捕获异常'], 1, '单线程内通过让出控制权实现并发。'),
    M('m078', 'concurrency asyncio general', 5, '在协程里调用 time.sleep(5) 会？', ['让出控制权', '阻塞整个事件循环', '自动变成 await', '提高并发'], 1, '应改用 await asyncio.sleep(5)。'),
    M('m079', 'stdlib regex general', 3, 're.match 与 re.search 的区别是？', ['完全相同', 'match 从字符串开头匹配，search 找任意位置', 'search 只找第一个字符', 'match 不支持分组'], 1, '需要整串匹配可用 fullmatch 或锚点。'),
    M('m080', 'stdlib regex general', 3, '正则 .* 默认采用？', ['懒惰匹配', '贪婪匹配', '精确匹配', '随机匹配'], 1, '加 ? 变成 .*? 才是懒惰匹配。'),
    M('m081', 'stdlib datetime general', 3, 'datetime(2026,1,1) + timedelta(days=10) 是？', ['2026-01-10', '2026-01-11', '2026-01-09', '2026-02-01'], 1, '从 1 月 1 日往后 10 天是 1 月 11 日。'),
    M('m082', 'stdlib collections general', 3, 'Counter("banana").most_common(1) 返回？', ["[('b', 1)]", "[('a', 3)]", "[('n', 2)]", "['banana']"], 1, 'a 出现 3 次最多。'),
    M('m083', 'stdlib argparse general', 3, 'argparse 相比直接读 sys.argv 的优势是？', ['运行更快', '自动类型转换、默认值与 --help', '不需要导入', '能自动联网'], 1, '命令行接口应声明式定义。'),
    M('m084', 'stdlib base64 general', 3, '关于 base64，正确的是？', ['是一种加密算法', '把字节映射成可打印字符，任何人都能解码', '只有 Python 能解', '会压缩数据'], 1, '编码不是加密，且体积约增大 1/3。'),
    M('m085', 'stdlib hashlib general', 3, 'MD5/SHA256 属于？', ['对称加密', '摘要算法，同输入同输出且不可逆', '压缩算法', '编码方式'], 1, '用于完整性校验；md5 已不适合安全场景。'),
    M('m086', 'stdlib hmac general', 4, 'hmac 相比裸 sha256(message) 多提供了？', ['更快的速度', '密钥参与，可验证消息来源', '更短的输出', '压缩能力'], 1, '常用于接口签名。'),
    M('m087', 'stdlib itertools general', 3, 'islice(count(10), 3) 的结果是？', ['[10, 11, 12]', '[10, 11, 12, 13]', '无限序列', '[0, 1, 2]'], 0, 'islice 给无限迭代器设了上界。'),
    M('m088', 'stdlib contextlib general', 3, '@contextmanager 中 yield 的位置表示？', ['函数返回值', 'with 块主体执行的位置', '循环开始', '异常类型'], 1, 'yield 前是进入，yield 后是退出清理。'),
    M('m089', 'stdlib urllib general', 3, '构造查询串 "?q=python&n=2" 应该用？', ['字符串拼接', 'urllib.parse.urlencode', 'base64.b64encode', 'json.dumps'], 1, 'urlencode 负责转义特殊字符。'),
    M('m090', 'stdlib xml htmlparser general', 3, 'HTMLParser 的工作方式是？', ['一次性返回整棵树', '遇到开始标签/数据等事件时回调', '用正则匹配', '把 HTML 转成图片'], 1, '事件驱动解析。'),
    M('m091', 'thirdparty requests general', 4, '使用 requests.get 时几乎总应设置？', ['timeout', 'verify=False', 'allow_redirects=False', 'proxies=None'], 0, '没有超时可能让程序永久挂起。'),
    M('m092', 'thirdparty pillow general', 4, 'Pillow 中 Image.open(p).resize((w, h)) 得到？', ['已保存到磁盘的文件', '新的 Image 对象，需再 save', '字节串', '列表'], 1, 'resize 返回新对象，不修改原图。'),
    M('m093', 'network tcpip socket udp general', 4, 'TCP 与 UDP 的核心差异是？', ['TCP 更慢且不可靠', 'TCP 面向连接、可靠有序；UDP 无连接、不保证到达', 'UDP 只能发文本', 'TCP 不需要端口'], 1, '可靠性来自建连、确认与重传。'),
    M('m094', 'network tcpip general', 3, 'IP 地址与端口分别定位？', ['进程 / 主机', '主机 / 主机上的进程', '文件 / 目录', '协议 / 数据'], 1, '一个连接由 (源IP, 源端口, 目的IP, 目的端口) 唯一确定。'),
    M('m095', 'network smtp pop3 general', 3, '发送邮件与收取邮件通常分别使用？', ['POP3 / SMTP', 'SMTP / POP3 或 IMAP', 'HTTP / FTP', 'TCP / UDP'], 1, 'SMTP 负责投递，收件协议负责读取。'),
    M('m096', 'data sqlite mysql sqlalchemy general', 4, '防止 SQL 注入的正确做法是？', ['把用户输入转义后拼进字符串', '使用参数化查询（? / %s 占位符）', '限制用户名长度', '用大写 SQL 关键字'], 1, '参数化让数据与语句结构彻底分离。'),
    M('m097', 'data sqlite general', 3, 'sqlite3 中执行 INSERT 后通常需要？', ['refresh()', 'con.commit()', 'con.flush()', 'close() 才算保存'], 1, '事务要显式提交；用 with con 可自动管理。'),
    M('m098', 'web http general', 4, 'HTTP 状态码 404 表示？', ['成功', '服务端内部错误', '资源未找到', '需要认证'], 2, '2xx 成功 / 4xx 客户端 / 5xx 服务端。'),
    M('m099', 'web wsgi general', 5, 'WSGI 应用返回给服务器的必须是？', ['str', 'bytes 的可迭代对象', 'dict', 'JSON 字符串'], 1, '响应体是 bytes；返回 str 会报错。'),
    M('m100', 'web template html general', 4, '模板中输出用户内容时必须？', ['直接拼接', '做 HTML 转义', '转成大写', '用 base64'], 1, '否则会造成 XSS。'),
    M('m101', 'web framework general', 4, '框架里的「路由」指？', ['数据库连接', 'URL 到处理函数的映射', '模板文件', '日志文件'], 1, '请求进来先按路由分派。'),
    M('m102', 'data sqlalchemy general', 5, 'ORM 的 N+1 问题指？', ['连接数过多', '为取 N 条关联数据额外发了 N 次查询', '表名太长', '索引失效'], 1, '理解 SQL 才能发现并优化这类问题。'),
    M('m103', 'quality error general', 3, '捕获多个异常时，子类异常应写在？', ['父类之后', '父类之前', '任意位置', 'finally 里'], 1, '父类在前会先命中，子类分支永远不可达。'),
    M('m104', 'concurrency distributed general', 5, '分布式进程相比本机多进程额外引入了？', ['更简单的调试', '网络不可靠与序列化成本', '更小的内存', '自动加锁'], 1, '必须考虑超时、重试与数据编解码。'),
  ];

  /* ---------------- 选择题：输出追踪题（参数化变体） ---------------- */
  const GEN = [
    G('g001', 'basics datatype general', 1, r => {
      // c=1 时 a+b*c、a*c+b、(a+b)*c 会退化成同一个 a+b，出现三个相同选项。
      // 用不同的错误算式保证四个选项两两不同：把第一个干扰项改成 (a+b+c)，
      // 再按需把仍冲突的项替换成不与已有项重复的数，直到互异。
      const a = r.int(3, 20), b = r.int(2, 9), c = r.int(1, 6);
      const correct = a + b * c;                 // 唯一正确答案，固定放在 A
      const raw = [(a + b) * c, a + b + c, a * c + b];
      const options = [String(correct)];
      let filler = correct + 1;                  // 备用干扰值，逐次递增避开已用值
      for (const v of raw) {
        let x = v;
        while (options.indexOf(String(x)) >= 0) { x = filler++; }
        options.push(String(x));
      }
      return { stem: `执行 print(${a} + ${b} * ${c}) 的输出是？`, options: options, answer: 0,
        explain: '先乘除后加减：' + `${b} * ${c} = ${b * c}，再加 ${a}，得 ${correct}。` };
    }),
    G('g002', 'advanced slice general', 2, r => {
      const s = r.pick(['abcdef', 'python', 'hello', 'abcdefg', 'uvwxyz']);
      const i = r.int(1, 3), j = i + r.int(2, 3);
      return { stem: `s = "${s}"，print(s[${i}:${j}]) 输出什么？`, options: [s.slice(i, j), s.slice(i - 1, j - 1), s.slice(j, i), s.slice(0, j - i)], answer: 0, explain: '切片左闭右开，取索引 ' + i + ' 到 ' + (j - 1) + '，得到 "' + s.slice(i, j) + '"。' };
    }),
    G('g003', 'basics string general', 1, r => {
      const s = r.pick(['Hello', 'Python', 'abc', 'Hi']);
      return { stem: `print("${s}".upper() + "!") 的输出是？`, options: [s.toUpperCase() + '!', s + '!', s.toLowerCase() + '!', s.toUpperCase()], answer: 0, explain: 'upper() 返回新的全大写字符串，再用 + 拼接。' };
    }),
    G('g004', 'basics list comprehension advanced', 2, r => {
      const n = r.int(4, 7);
      const right = [];
      for (let i = 0; i < n; i++) if (i % 2 === 0) right.push(i * i);
      return { stem: `[x*x for x in range(${n}) if x % 2 == 0] 的结果是？`, options: [JSON.stringify(right), JSON.stringify([...Array(n).keys()]), JSON.stringify(right.slice(1)), JSON.stringify(right.map(x => x + 1))], answer: 0, explain: '先按条件筛出偶数索引，再逐个平方；结果是 ' + JSON.stringify(right) + '。' };
    }),
    G('g005', 'basics loop general', 1, r => {
      const n = r.int(3, 8);
      return { stem: `total = 0\nfor i in range(1, ${n} + 1):\n    total += i\nprint(total) 输出？`, options: [String(n * (n + 1) / 2), String(n * n), String(n * (n - 1) / 2), String(n + 1)], answer: 0, explain: '等差数列求和 n(n+1)/2 = ' + n + '×' + (n + 1) + '/2 = ' + n * (n + 1) / 2 + '。' };
    }),
    G('g006', 'basics dict set general', 2, r => {
      const k = r.pick(['a', 'b', 'x', 'name']);
      return { stem: `d = {"${k}": 1, "b": 2}\nd["c"] = 3\nprint(len(d), d.get("z", 9)) 输出？`, options: k === 'b' ? ['2 9', '3 9', '2 None', '3 None'] : ['3 9', '2 9', '3 None', '2 0'], answer: 0, explain: '原有 2 个键再加 c 共 3 个（若键重复则只有 2 个）；get 取不到返回默认值 9。' };
    }),
    G('g007', 'function params general', 2, r => {
      const a = r.int(2, 9);
      return { stem: `def f(x, y=${a}):\n    return x * y\nprint(f(${a + 1}), f(2, 3)) 输出？`, options: [`${(a + 1) * a} 6`, `${(a + 1) * a} ${2 * a}`, `${(a + 1) * 3} 6`, `${a + 1} 6`], answer: 0, explain: '第一次省略 y 用默认值 ' + a + '，第二次显式传 3。' };
    }),
    G('g008', 'advanced comprehension functional', 3, r => {
      const words = r.pick([['kiwi', 'apple', 'banana'], ['a', 'bbbb', 'cc'], ['go', 'python', 'rust']]);
      const sorted = [...words].sort((x, y) => x.length - y.length || x.localeCompare(y));
      return { stem: `print(sorted(${JSON.stringify(words)}, key=len)) 的结果是？`, options: [JSON.stringify(sorted), JSON.stringify([...words].sort()), JSON.stringify([...words].reverse()), JSON.stringify([...words].sort((x, y) => y.length - x.length))], answer: 0, explain: 'key=len 按字符串长度升序；长度相同时保持原顺序（排序稳定）。' };
    }),
    G('g009', 'basics condition general', 1, r => {
      const n = r.int(5, 60);
      const right = n > 30 ? '大' : '小';
      return { stem: `n = ${n}\nprint("大" if n > 30 else "小") 输出？`, options: [right, right === '大' ? '小' : '大', 'None', '报错'], answer: 0, explain: `${n} ${n > 30 ? '大于' : '不大于'} 30，因此取对应分支。` };
    }),
    G('g010', 'advanced iterator generator general', 3, r => {
      const xs = [r.int(1, 9), r.int(10, 20), r.int(21, 30)];
      return { stem: `g = (x * 2 for x in ${JSON.stringify(xs)})\nprint(list(g), list(g)) 输出？`, options: [`${JSON.stringify(xs.map(x => x * 2))} []`, `${JSON.stringify(xs.map(x => x * 2))} ${JSON.stringify(xs.map(x => x * 2))}`, `[] ${JSON.stringify(xs.map(x => x * 2))}`, '报错'], answer: 0, explain: '生成器只能消费一次，第二次已耗尽，list() 得到空列表。' };
    }),
    G('g011', 'oop classattr general', 3, r => {
      const n = r.int(2, 5);
      return { stem: `class C:\n    total = 0\n    def __init__(self):\n        C.total += 1\nfor _ in range(${n}):\n    C()\nprint(C.total) 输出？`, options: [String(n), String(n - 1), '0', String(n + 1)], answer: 0, explain: '类属性被所有实例共享，每创建一次实例加 1。' };
    }),
    G('g012', 'stdlib collections itertools general', 3, r => {
      const s = r.pick(['banana', 'abccba', 'mississippi', 'hello']);
      const counts = {};
      for (const ch of s) counts[ch] = (counts[ch] || 0) + 1;
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      return { stem: `Counter("${s}").most_common(1) 的结果是？`, options: [`[('${top[0]}', ${top[1]})]`, `[('${s[0]}', ${counts[s[0]]})]`, `[('${s[s.length - 1]}', ${counts[s[s.length - 1]]})]`, '[]'], answer: 0, explain: `逐字符统计，'${top[0]}' 出现 ${top[1]} 次最多。` };
    }),
    G('g013', 'data sqlite network web general', 3, r => {
      const host = r.pick(['127.0.0.1', 'localhost', 'example.com']);
      const port = r.pick([80, 443, 8080, 5432]);
      return { stem: `addr = "${host}:${port}"\nhost, port = addr.split(":")\nprint(host, int(port) + 1) 输出？`, options: [`${host} ${port + 1}`, `${host} ${port}`, `${port} ${host}`, '报错'], answer: 0, explain: 'split 按冒号拆成两段，int() 后才能做加法。网络地址常这样解析。' };
    }),
    G('g014', 'quality error general', 3, r => {
      const n = r.int(1, 5);
      return { stem: `try:\n    x = 10 / 0\nexcept ZeroDivisionError:\n    x = ${n}\nfinally:\n    x += 1\nprint(x) 输出？`, options: [String(n + 1), String(n), 'NaN', '报错'], answer: 0, explain: 'except 先赋 ' + n + '，finally 一定执行再 +1。' };
    }),
  ];

  /* ---------------- 编程实操题 ---------------- */
  const py = (s) => s; // 可读性标记：字符串里是 Python 代码
  const LAB = [
    L('l001', 'basics loop general', 1, r => {
      const n = r.int(4, 12);
      return { title: '区间求和', brief: `实现 solve(n)，返回 1 到 n（含）所有整数之和。例：n=${n}。`, starter: 'def solve(n):\n    # TODO: 用循环或公式求和\n    pass', hints: ['先想：n=1 时应该返回几？', '可以用 total = 0 加一个 for 循环。', '也可以直接用等差数列公式 n*(n+1)//2。'], solution: 'def solve(n):\n    return n * (n + 1) // 2', ref: 'def __ref__(n):\n    return sum(range(1, n + 1))', cases: [[String(n)], ['1'], ['0'], ['10']] };
    }),
    L('l002', 'basics datatype general', 1, r => {
      const c = r.int(10, 40);
      return { title: '摄氏转华氏', brief: '实现 solve(c)，把摄氏温度转为华氏温度：f = c * 9 / 5 + 32，返回浮点数。', starter: 'def solve(c):\n    # TODO\n    pass', hints: ['注意运算优先级，先乘除后加。', '用 / 而不是 //，结果应是浮点数。'], solution: 'def solve(c):\n    return c * 9 / 5 + 32', ref: 'def __ref__(c):\n    return c * 9.0 / 5 + 32', cases: [[String(c)], ['0'], ['100'], ['-10']] } ;
    }),
    L('l003', 'basics string slice advanced general', 1, r => {
      const s = r.pick(['python', 'hello', 'abcde', 'abcdef']);
      return { title: '反转字符串', brief: '实现 solve(s)，返回 s 的反转结果。', starter: 'def solve(s):\n    # TODO\n    pass', hints: ['字符串可以切片。', '步长为 -1 时从右往左取。', 's[::-1] 一行就够。'], solution: 'def solve(s):\n    return s[::-1]', ref: 'def __ref__(s):\n    return "".join(reversed(s))', cases: [[`'${s}'`], ["'a'"], ["''"], ["'上海'"]] };
    }),
    L('l004', 'basics string general', 1, r => {
      const s = r.pick(['banana', 'hello world', 'mississippi']);
      const ch = s[0];
      return { title: '统计字符出现次数', brief: '实现 solve(s, ch)，返回字符 ch 在字符串 s 中出现的次数。', starter: 'def solve(s, ch):\n    # TODO\n    pass', hints: ['字符串有内置方法可以直接数。', '也可以自己用 for 遍历累加。'], solution: 'def solve(s, ch):\n    return s.count(ch)', ref: 'def __ref__(s, ch):\n    return sum(1 for x in s if x == ch)', cases: [[`'${s}'`, `'${ch}'`], ["'aaaa'", "'a'"], ["'abc'", "'z'"], ["''", "'a'"]] };
    }),
    L('l005', 'basics list general', 1, r => {
      const xs = [r.int(1, 9), r.int(1, 9), r.int(1, 9), r.int(1, 9)];
      return { title: '找最大值', brief: '实现 solve(xs)，返回非空列表 xs 中的最大值（请先尝试自己写循环）。', starter: 'def solve(xs):\n    # TODO\n    pass', hints: ['先假设第一个元素最大。', '遍历剩余元素，遇到更大的就更新。'], solution: 'def solve(xs):\n    best = xs[0]\n    for x in xs[1:]:\n        if x > best:\n            best = x\n    return best', ref: 'def __ref__(xs):\n    return max(xs)', cases: [[JSON.stringify(xs)], ['[7]'], ['[-1, -5, -2]'], ['[3, 3, 3]']] };
    }),
    L('l006', 'basics condition loop comprehension general', 1, r => {
      const n = r.int(5, 12);
      return { title: '收集偶数', brief: '实现 solve(n)，返回 0 到 n-1 之间所有偶数组成的列表。', starter: 'def solve(n):\n    # TODO\n    pass', hints: ['判断偶数用 x % 2 == 0。', 'range(n) 给出 0 到 n-1。', '列表生成式可以一行搞定。'], solution: 'def solve(n):\n    return [x for x in range(n) if x % 2 == 0]', ref: 'def __ref__(n):\n    return list(range(0, n, 2))', cases: [[String(n)], ['1'], ['0'], ['6']] };
    }),
    L('l007', 'basics condition general', 2, r => {
      return { title: '成绩分级', brief: '实现 solve(score)：≥90 返回 "A"，≥60 返回 "B"，否则返回 "C"。', starter: 'def solve(score):\n    # TODO\n    pass', hints: ['先判断最高的边界。', '注意 90 和 60 都属于较高等级。'], solution: 'def solve(score):\n    if score >= 90:\n        return "A"\n    if score >= 60:\n        return "B"\n    return "C"', ref: 'def __ref__(s):\n    return "A" if s >= 90 else ("B" if s >= 60 else "C")', cases: [['95'], ['90'], ['60'], ['59'], ['0']] };
    }),
    L('l008', 'function recursion general', 2, r => {
      const n = r.int(4, 8);
      return { title: '阶乘（递归）', brief: '实现 solve(n)，用递归返回 n!（n≥0，0! = 1）。', starter: 'def solve(n):\n    # TODO: 写出基线条件与递推\n    pass', hints: ['n <= 1 时直接返回 1。', '否则返回 n * solve(n - 1)。'], solution: 'def solve(n):\n    return 1 if n <= 1 else n * solve(n - 1)', ref: 'def __ref__(n):\n    import math\n    return math.factorial(n)', cases: [[String(n)], ['0'], ['1'], ['5']] };
    }),
    L('l009', 'function recursion general', 3, r => {
      const n = r.int(6, 12);
      return { title: '斐波那契数列', brief: '实现 solve(n)，返回斐波那契第 n 项，约定 F(0)=0, F(1)=1。', starter: 'def solve(n):\n    # TODO\n    pass', hints: ['可以用递归，也可以用两个变量迭代。', '迭代版：a, b = 0, 1，循环 n 次。'], solution: 'def solve(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a', ref: 'def __ref__(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a', cases: [[String(n)], ['0'], ['1'], ['10']] };
    }),
    L('l010', 'basics dict set general', 2, r => {
      return { title: '列表去重（保持顺序）', brief: '实现 solve(xs)，去掉列表中的重复元素并保持第一次出现的顺序。', starter: 'def solve(xs):\n    # TODO\n    pass', hints: ['用一个集合记录「见过」。', '按顺序遍历，没见过就加入结果。'], solution: 'def solve(xs):\n    seen, out = set(), []\n    for x in xs:\n        if x not in seen:\n            seen.add(x)\n            out.append(x)\n    return out', ref: 'def __ref__(xs):\n    return list(dict.fromkeys(xs))', cases: [['[3, 1, 3, 2, 1]'], ['[]'], ['[1, 1, 1]'], ["['a', 'b', 'a']"]] };
    }),
    L('l011', 'basics dict general', 2, r => {
      return { title: '合并两个字典', brief: '实现 solve(d1, d2)，返回合并后的新字典；若键重复，以 d2 为准。不要修改原字典。', starter: 'def solve(d1, d2):\n    # TODO\n    pass', hints: ['先复制 d1，再更新。', 'dict(d1) 会创建浅拷贝。'], solution: 'def solve(d1, d2):\n    out = dict(d1)\n    out.update(d2)\n    return out', ref: 'def __ref__(a, b):\n    return {**a, **b}', cases: [["{'a': 1}", "{'b': 2}"], ["{'a': 1}", "{'a': 9}"], ['{}', "{'x': 3}"], ["{'x': 1}", '{}']] };
    }),
    L('l012', 'basics string dict general', 2, r => {
      return { title: '词频统计', brief: '实现 solve(text)，返回每个单词出现次数的字典（用空白分词）。', starter: 'def solve(text):\n    # TODO\n    pass', hints: ['text.split() 按任意空白切分。', '用 dict 或 collections.Counter。'], solution: 'def solve(text):\n    d = {}\n    for w in text.split():\n        d[w] = d.get(w, 0) + 1\n    return d', ref: 'def __ref__(t):\n    from collections import Counter\n    return dict(Counter(t.split()))', cases: [["'a b a c'"], ["''"], ["'x x x'"], ["'hello world'"]] };
    }),
    L('l013', 'basics string general', 2, r => {
      return { title: '判断回文', brief: '实现 solve(s)，若 s 正着读反着读一样返回 True，否则 False。', starter: 'def solve(s):\n    # TODO\n    pass', hints: ['把字符串反转后比较。', 's[::-1] 会返回反转结果。'], solution: 'def solve(s):\n    return s == s[::-1]', ref: 'def __ref__(s):\n    return s == "".join(reversed(s))', cases: [["'level'"], ["'python'"], ["''"], ["'上海海上'"]] };
    }),
    L('l014', 'advanced comprehension general', 2, r => {
      return { title: '二维列表展平', brief: '实现 solve(matrix)，把二维列表展平成一维列表。', starter: 'def solve(matrix):\n    # TODO\n    pass', hints: ['双层 for 的列表生成式。', '顺序是「先逐行，再逐元素」。'], solution: 'def solve(matrix):\n    return [x for row in matrix for x in row]', ref: 'def __ref__(m):\n    import itertools\n    return list(itertools.chain.from_iterable(m))', cases: [['[[1, 2], [3, 4]]'], ['[]'], ['[[1], [], [2, 3]]'], ['[[0, 0], [0]]']] };
    }),
    L('l015', 'advanced slice general', 2, r => {
      const n = r.int(2, 5);
      return { title: '按长度分块', brief: '实现 solve(xs, n)，把列表 xs 按每 n 个一组切成若干块（最后一块可以不足 n 个）。', starter: 'def solve(xs, n):\n    # TODO\n    pass', hints: ['用 range(0, len(xs), n) 生成每块起点。', '切片 xs[i:i+n] 取一块。'], solution: 'def solve(xs, n):\n    return [xs[i:i + n] for i in range(0, len(xs), n)]', ref: 'def __ref__(xs, n):\n    return [xs[i:i+n] for i in range(0, len(xs), n)]', cases: [['[1, 2, 3, 4, 5]', String(n)], ['[]', '2'], ['[1, 2, 3]', '1'], ['[1, 2, 3, 4]', '2']] };
    }),
    L('l016', 'advanced comprehension general', 3, r => {
      return { title: '矩阵转置', brief: '实现 solve(matrix)，返回转置后的二维列表（行列互换）。', starter: 'def solve(matrix):\n    # TODO\n    pass', hints: ['zip(*matrix) 会把各行的第 i 个元素凑成一组。', '再转成 list 即可。'], solution: 'def solve(matrix):\n    return [list(row) for row in zip(*matrix)]', ref: 'def __ref__(m):\n    return [list(c) for c in zip(*m)]', cases: [['[[1, 2], [3, 4]]'], ['[[1, 2, 3]]'], ['[]'], ['[[1], [2], [3]]']] };
    }),
    L('l017', 'function params general', 2, r => {
      return { title: '带默认值的问候', brief: '实现 solve(name, prefix="Hi")，返回 "前缀, 名字!"；prefix 缺省时用 "Hi"。', starter: 'def solve(name, prefix="Hi"):\n    # TODO\n    pass', hints: ['f-string 很好用：f"{prefix}, {name}!"', '默认值写在参数列表里。'], solution: 'def solve(name, prefix="Hi"):\n    return f"{prefix}, {name}!"', ref: 'def __ref__(n, p="Hi"):\n    return p + ", " + n + "!"', cases: [["'小派'"], ["'Ada'", "'Hello'"], ["'X'", "''"], ["'Bob'", "'Yo'"]] };
    }),
    L('l018', 'function params general', 3, r => {
      return { title: '可变参数求和', brief: '实现 solve(*args)，返回所有参数的和（无参数时返回 0）。', starter: 'def solve(*args):\n    # TODO\n    pass', hints: ['args 是一个 tuple。', 'sum() 可以直接求和。'], solution: 'def solve(*args):\n    return sum(args)', ref: 'def __ref__(*a):\n    return sum(a)', cases: [['1', '2', '3'], [], ['10'], ['-1', '1', '5']] };
    }),
    L('l019', 'function higherorder functional general', 3, r => {
      return { title: '把函数应用两次', brief: '实现 solve(f, x)，返回 f(f(x))。', starter: 'def solve(f, x):\n    # TODO\n    pass', hints: ['f 是传进来的函数对象。', '先算一次，再把结果喂回 f。'], solution: 'def solve(f, x):\n    return f(f(x))', ref: 'def __ref__(f, x):\n    return f(f(x))', cases: [['lambda a: a + 1', '3'], ['lambda a: a * 2', '5'], ['str.upper', "'hi'"], ['abs', '-7']] };
    }),
    L('l020', 'functional closure lambda general', 3, r => {
      return { title: '函数工厂', brief: '实现 solve(n)，返回一个「把输入加 n」的函数。判题会调用你返回的函数。', starter: 'def solve(n):\n    # TODO: 返回一个函数\n    pass', hints: ['在函数内部 def 一个新函数。', '新函数引用外层的 n，这就是闭包。', '记得 return 内层函数本身（不加括号）。'], solution: 'def solve(n):\n    def add(x):\n        return x + n\n    return add', ref: 'def __ref__(n):\n    return lambda x: x + n', cases: [['3'], ['0'], ['-2'], ['10']], refCall: true };
    }),
    L('l021', 'functional sorted general', 2, r => {
      return { title: '按字符串长度排序', brief: '实现 solve(words)，返回按长度升序排列的新列表（长度相同保持原顺序）。', starter: 'def solve(words):\n    # TODO\n    pass', hints: ['sorted 的 key 参数接收函数。', 'key=len，注意不要写 len()。'], solution: 'def solve(words):\n    return sorted(words, key=len)', ref: 'def __ref__(w):\n    return sorted(w, key=len)', cases: [["['bbb', 'a', 'cc']"], ['[]'], ["['x']"], ["['aa', 'b', 'cc', 'd']"]] };
    }),
    L('l022', 'functional filter mapreduce general', 2, r => {
      return { title: '筛选正数', brief: '实现 solve(xs)，返回列表中所有大于 0 的元素组成的新列表。', starter: 'def solve(xs):\n    # TODO\n    pass', hints: ['列表生成式 + if 条件。', '也可以用 filter。'], solution: 'def solve(xs):\n    return [x for x in xs if x > 0]', ref: 'def __ref__(xs):\n    return list(filter(lambda x: x > 0, xs))', cases: [['[-1, 0, 2, 3]'], ['[]'], ['[1, 2]'], ['[-5, -2]']] };
    }),
    L('l023', 'functional mapreduce general', 2, r => {
      return { title: '逐元素平方', brief: '实现 solve(xs)，返回每个元素平方后的新列表。', starter: 'def solve(xs):\n    # TODO\n    pass', hints: ['用 for 循环逐个平方再 append 进新列表。', '列表生成式 [x * x for x in xs] 更直观。'], solution: 'def solve(xs):\n    return [x * x for x in xs]', ref: 'def __ref__(xs):\n    return list(map(lambda x: x*x, xs))', cases: [['[1, 2, 3]'], ['[]'], ['[-2, 0]'], ['[5]']] };
    }),
    L('l024', 'functional mapreduce general', 3, r => {
      return { title: '列表求积', brief: '实现 solve(xs)，返回所有元素的乘积（空列表返回 1）。', starter: 'def solve(xs):\n    # TODO\n    pass', hints: ['准备一个变量存乘积，初始值设为 1。', '用 for 循环把每个元素乘进去，最后返回它。'], solution: 'def solve(xs):\n    total = 1\n    for x in xs:\n        total *= x\n    return total', ref: 'def __ref__(xs):\n    import math\n    return math.prod(xs)', cases: [['[2, 3, 4]'], ['[]'], ['[7]'], ['[1, -2, 3]']] };
    }),
    L('l025', 'advanced generator iterator general', 3, r => {
      return { title: '自定义区间生成器', brief: '实现 solve(a, b)，返回一个生成器，依次产出 a 到 b-1 的整数。判题会转成列表比较。', starter: 'def solve(a, b):\n    # TODO: 用 yield\n    pass', hints: ['函数里出现 yield 就变成生成器函数。', '循环 range(a, b) 并 yield 每个值。'], solution: 'def solve(a, b):\n    for i in range(a, b):\n        yield i', ref: 'def __ref__(a, b):\n    return list(range(a, b))', cases: [['1', '5'], ['0', '0'], ['-2', '2'], ['3', '4']], refCall: 'list' };
    }),
    L('l026', 'oop class general', 3, r => {
      return { title: '写一个计数器类', brief: '定义类 Counter，有 inc() 方法使计数 +1，有 value() 方法返回当前计数（初值 0）。', starter: 'class Counter:\n    # TODO: __init__ / inc / value\n    pass', hints: ['__init__ 里用 self.n = 0。', 'inc 里 self.n += 1。', 'value 返回 self.n。'], solution: 'class Counter:\n    def __init__(self):\n        self.n = 0\n    def inc(self):\n        self.n += 1\n    def value(self):\n        return self.n', check: 'c = Counter()\nassert c.value() == 0\nc.inc(); c.inc(); c.inc()\nassert c.value() == 3\n{{TOKEN}}' };
    }),
    L('l027', 'oop class inheritance general', 3, r => {
      return { title: '矩形面积与周长', brief: '定义类 Rectangle(w, h)，方法 area() 返回面积、perimeter() 返回周长。', starter: 'class Rectangle:\n    # TODO\n    pass', hints: ['__init__ 保存 w、h 到 self。', 'area = w*h；perimeter = 2*(w+h)。'], solution: 'class Rectangle:\n    def __init__(self, w, h):\n        self.w, self.h = w, h\n    def area(self):\n        return self.w * self.h\n    def perimeter(self):\n        return 2 * (self.w + self.h)', check: 'r = Rectangle(3, 4)\nassert r.area() == 12\nassert r.perimeter() == 14\nassert Rectangle(0, 5).area() == 0\n{{TOKEN}}' };
    }),
    L('l028', 'oop access property general', 4, r => {
      return { title: '带校验的分数属性', brief: '定义类 Score，属性 value 用 @property 实现；赋值时把值限制在 0~100（超出则夹到边界）。', starter: 'class Score:\n    # TODO: @property + setter\n    pass', hints: ['内部存 self._v。', 'setter 里用 max(0, min(100, v))。'], solution: 'class Score:\n    def __init__(self):\n        self._v = 0\n    @property\n    def value(self):\n        return self._v\n    @value.setter\n    def value(self, v):\n        self._v = max(0, min(100, v))', check: 's = Score()\nassert s.value == 0\ns.value = 150\nassert s.value == 100\ns.value = -5\nassert s.value == 0\ns.value = 42\nassert s.value == 42\n{{TOKEN}}' };
    }),
    L('l029', 'oop dunder general', 4, r => {
      return { title: '定制类：长度与字符串', brief: '定义类 Bag(items)：len(bag) 返回元素个数，str(bag) 返回 "Bag(n)"，n 为个数。', starter: 'class Bag:\n    # TODO: __init__ / __len__ / __str__\n    pass', hints: ['实现 __len__ 支撑 len()。', '实现 __str__ 支撑 str()。'], solution: 'class Bag:\n    def __init__(self, items):\n        self.items = list(items)\n    def __len__(self):\n        return len(self.items)\n    def __str__(self):\n        return f"Bag({len(self)})"', check: 'b = Bag([1, 2, 3])\nassert len(b) == 3\nassert str(b) == "Bag(3)"\nassert len(Bag([])) == 0\n{{TOKEN}}' };
    }),
    L('l030', 'oop inheritance general', 4, r => {
      return { title: '继承与多态', brief: '定义 Animal.speak() 返回 "..."；定义子类 Dog 覆盖 speak() 返回 "汪"。', starter: 'class Animal:\n    # TODO\n    pass\n\nclass Dog(Animal):\n    # TODO\n    pass', hints: ['class Dog(Animal): 表示继承。', '子类同名方法会覆盖父类。'], solution: 'class Animal:\n    def speak(self):\n        return "..."\n\nclass Dog(Animal):\n    def speak(self):\n        return "汪"', check: 'assert Animal().speak() == "..."\nassert Dog().speak() == "汪"\nassert isinstance(Dog(), Animal)\n{{TOKEN}}' };
    }),
    L('l031', 'quality error general', 3, r => {
      return { title: '安全除法', brief: '实现 solve(a, b)，返回 a/b；当 b 为 0 时返回 None（用异常处理）。', starter: 'def solve(a, b):\n    # TODO\n    pass', hints: ['用 try / except ZeroDivisionError。', '只捕获具体的异常类型。'], solution: 'def solve(a, b):\n    try:\n        return a / b\n    except ZeroDivisionError:\n        return None', ref: 'def __ref__(a, b):\n    return a / b if b != 0 else None', cases: [['10', '2'], ['1', '0'], ['-6', '3'], ['0', '5']] };
    }),
    L('l032', 'quality unittest testing general', 3, r => {
      return { title: '写一个断言式测试函数', brief: '实现 solve()，内部用 assert 验证 1+1==2 与 "abc".upper()=="ABC"，全部通过返回 "OK"。', starter: 'def solve():\n    # TODO: 用 assert 写两条检查\n    pass', hints: ['assert 条件, "消息"。', '最后 return "OK"。'], solution: 'def solve():\n    assert 1 + 1 == 2\n    assert "abc".upper() == "ABC"\n    return "OK"', ref: 'def __ref__():\n    return "OK"', cases: [[]] };
    }),
    L('l033', 'io_group serialization json general', 3, r => {
      return { title: 'JSON 往返', brief: '实现 solve(d)，把字典 d 用 json.dumps 转成字符串（ensure_ascii=False），再 json.loads 还原并返回。', starter: 'def solve(d):\n    # TODO\n    pass', hints: ['先 import json。', '返回还原后的对象，应与输入相等。'], solution: 'def solve(d):\n    import json\n    return json.loads(json.dumps(d, ensure_ascii=False))', ref: 'def __ref__(d):\n    return dict(d)', cases: [["{'a': 1}"], ['{}'], ["{'name': '小派', 'ok': True}"], ["{'x': [1, 2]}"]] };
    }),
    L('l034', 'io_group fileio pathlib general', 3, r => {
      return { title: '路径信息提取', brief: '实现 solve(p)，用 pathlib 返回 (文件名, 后缀) 元组。', starter: 'def solve(p):\n    # TODO\n    pass', hints: ['from pathlib import Path。', 'Path(p).name 与 .suffix。'], solution: 'def solve(p):\n    from pathlib import Path\n    q = Path(p)\n    return (q.name, q.suffix)', ref: 'def __ref__(p):\n    import os\n    return (os.path.basename(p), os.path.splitext(p)[1])', cases: [["'a/b/c.txt'"], ["'hello.py'"], ["'README'"], ["'dir/笔记.md'"]] };
    }),
    L('l035', 'io_group stringio general', 3, r => {
      return { title: '内存文本缓冲', brief: '实现 solve(parts)，用 io.StringIO 依次写入 parts 中每个字符串，返回 getvalue() 的结果。', starter: 'def solve(parts):\n    # TODO\n    pass', hints: ['from io import StringIO。', '循环 write，最后 getvalue()。'], solution: 'def solve(parts):\n    from io import StringIO\n    buf = StringIO()\n    for p in parts:\n        buf.write(p)\n    return buf.getvalue()', ref: 'def __ref__(parts):\n    return "".join(parts)', cases: [["['a', 'b', 'c']"], ['[]'], ["['Hello, ', 'World']"], ["['x']"]] };
    }),
    L('l036', 'stdlib regex general', 3, r => {
      return { title: '提取所有数字', brief: '实现 solve(s)，用正则返回字符串中所有连续数字组成的列表（字符串形式）。', starter: 'def solve(s):\n    # TODO\n    pass', hints: ['import re。', 're.findall 配合模式 r"[0-9]+"。'], solution: 'def solve(s):\n    import re\n    return re.findall(r"[0-9]+", s)', ref: 'def __ref__(s):\n    import re\n    return re.findall(r"[0-9]+", s)', cases: [["'a1b22c333'"], ["'no digits'"], ["'007-2026'"], ["''"]] };
    }),
    L('l037', 'stdlib datetime general', 3, r => {
      return { title: '日期加天数', brief: '实现 solve(days)，返回 2026-01-01 加上 days 天后的日期字符串，格式 YYYY-MM-DD。', starter: 'def solve(days):\n    # TODO\n    pass', hints: ['from datetime import datetime, timedelta。', 'strftime("%Y-%m-%d") 格式化。'], solution: 'def solve(days):\n    from datetime import datetime, timedelta\n    return (datetime(2026, 1, 1) + timedelta(days=days)).strftime("%Y-%m-%d")', ref: 'def __ref__(d):\n    from datetime import datetime, timedelta\n    return (datetime(2026,1,1)+timedelta(days=d)).strftime("%Y-%m-%d")', cases: [['10'], ['0'], ['365'], ['-1']] };
    }),
    L('l038', 'stdlib collections general', 3, r => {
      return { title: '出现次数最多的字符', brief: '实现 solve(s)，返回出现次数最多的字符及其次数组成的元组；空串返回 ("", 0)。', starter: 'def solve(s):\n    # TODO\n    pass', hints: ['collections.Counter 的 most_common(1)。', '注意空串要单独处理。'], solution: 'def solve(s):\n    from collections import Counter\n    if not s:\n        return ("", 0)\n    return Counter(s).most_common(1)[0]', ref: 'def __ref__(s):\n    from collections import Counter\n    return ("", 0) if not s else Counter(s).most_common(1)[0]', cases: [["'banana'"], ["''"], ["'aabbc'"], ["'xyz'"]] };
    }),
    L('l039', 'stdlib base64 struct general', 3, r => {
      return { title: 'Base64 编解码', brief: '实现 solve(b)，把 bytes 用 base64 编码成字符串，再解码回原始 bytes 并返回。', starter: 'def solve(b):\n    # TODO\n    pass', hints: ['import base64。', 'b64encode 返回 bytes，可 .decode() 转 str。'], solution: 'def solve(b):\n    import base64\n    s = base64.b64encode(b).decode("ascii")\n    return base64.b64decode(s)', ref: 'def __ref__(b):\n    return b', cases: [["b'hi'"], ["b''"], ["b'Python'"], ["bytes([0, 1, 2])"]] };
    }),
    L('l040', 'stdlib hashlib hmac general', 3, r => {
      return { title: '计算摘要前 8 位', brief: '实现 solve(s)，返回字符串 s（UTF-8 编码）的 md5 十六进制摘要的前 8 个字符。', starter: 'def solve(s):\n    # TODO\n    pass', hints: ['先 s.encode("utf-8")。', 'hashlib.md5(...).hexdigest()[:8]。'], solution: 'def solve(s):\n    import hashlib\n    return hashlib.md5(s.encode("utf-8")).hexdigest()[:8]', ref: 'def __ref__(s):\n    import hashlib\n    return hashlib.md5(s.encode("utf-8")).hexdigest()[:8]', cases: [["'abc'"], ["''"], ["'Python'"], ["'小派'"]] };
    }),
    L('l041', 'stdlib itertools general', 3, r => {
      return { title: '取无限序列的前 n 项', brief: '实现 solve(start, n)，返回从 start 开始连续 n 个整数组成的列表（请用 itertools.islice + count）。', starter: 'def solve(start, n):\n    # TODO\n    pass', hints: ['itertools.count(start) 是无限迭代器。', 'islice 给它设上界。'], solution: 'def solve(start, n):\n    import itertools\n    return list(itertools.islice(itertools.count(start), n))', ref: 'def __ref__(a, n):\n    return list(range(a, a + n))', cases: [['10', '3'], ['0', '5'], ['-2', '4'], ['100', '0']] };
    }),
    L('l042', 'stdlib urllib network general', 3, r => {
      return { title: '构造查询字符串', brief: '实现 solve(d)，用 urllib.parse.urlencode 把字典转成查询串（如 "q=python&n=2"）。', starter: 'def solve(d):\n    # TODO\n    pass', hints: ['from urllib.parse import urlencode。', '直接返回 urlencode(d)。'], solution: 'def solve(d):\n    from urllib.parse import urlencode\n    return urlencode(d)', ref: 'def __ref__(d):\n    from urllib.parse import urlencode\n    return urlencode(d)', cases: [["{'q': 'python', 'n': 2}"], ['{}'], ["{'a': 'x y'}"], ["{'k': 1}"]] };
    }),
    L('l043', 'stdlib xml htmlparser web general', 3, r => {
      return { title: '解析 XML 节点文本', brief: '实现 solve(xml)，用 ElementTree 解析并返回根节点的 <b> 子节点的文本。', starter: 'def solve(xml):\n    # TODO\n    pass', hints: ['ET.fromstring(xml)。', 'root.find("b").text。'], solution: 'def solve(xml):\n    import xml.etree.ElementTree as ET\n    root = ET.fromstring(xml)\n    return root.find("b").text', ref: 'def __ref__(x):\n    import xml.etree.ElementTree as ET\n    return ET.fromstring(x).find("b").text', cases: [["'<a><b>1</b></a>'"], ["'<a><b>hello</b></a>'"], ["'<r><b></b></r>'"], ["'<a><b>小派</b></a>'"]] };
    }),
    L('l044', 'web html template general', 3, r => {
      return { title: 'HTML 转义', brief: '实现 solve(s)，用 html.escape 转义字符串，防止 XSS。', starter: 'def solve(s):\n    # TODO\n    pass', hints: ['from html import escape。', '直接返回 escape(s)。'], solution: 'def solve(s):\n    from html import escape\n    return escape(s)', ref: 'def __ref__(s):\n    from html import escape\n    return escape(s)', cases: [["'<script>'"], ["'a&b'"], ["'plain'"], ["'\"quote\"'"]] };
    }),
    L('l045', 'data sqlite general', 4, r => {
      return { title: '参数化查询', brief: '实现 solve(name)，在内存 SQLite 里建表 t(id, name)，插入 (1, "小派")，然后用参数化查询按 name 返回 id（找不到返回 -1）。', starter: 'def solve(name):\n    # TODO\n    pass', hints: ['sqlite3.connect(":memory:")。', '用 ? 占位符，不要用字符串拼接。', 'fetchone() 可能是 None。'], solution: 'def solve(name):\n    import sqlite3\n    con = sqlite3.connect(":memory:")\n    con.execute("CREATE TABLE t (id INTEGER, name TEXT)")\n    con.execute("INSERT INTO t VALUES (?, ?)", (1, "小派"))\n    row = con.execute("SELECT id FROM t WHERE name = ?", (name,)).fetchone()\n    con.close()\n    return row[0] if row else -1', ref: 'def __ref__(n):\n    return 1 if n == "小派" else -1', cases: [["'小派'"], ["'别人'"], ["''"], ["'x'"]] };
    }),
    L('l046', 'network tcpip socket udp web general', 3, r => {
      return { title: '解析主机与端口', brief: '实现 solve(addr)，把 "host:port" 拆成 (host, int(port)) 元组。', starter: 'def solve(addr):\n    # TODO\n    pass', hints: ['addr.split(":") 得到两段。', '第二段要 int() 转换。'], solution: 'def solve(addr):\n    host, port = addr.split(":")\n    return (host, int(port))', ref: 'def __ref__(a):\n    h, p = a.split(":")\n    return (h, int(p))', cases: [["'127.0.0.1:8080'"], ["'localhost:80'"], ["'example.com:443'"], ["'h:1'"]] };
    }),
    L('l047', 'web http wsgi framework general', 4, r => {
      return { title: '构造 HTTP 状态行', brief: '实现 solve(code, reason)，返回形如 "HTTP/1.1 200 OK" 的状态行字符串。', starter: 'def solve(code, reason):\n    # TODO\n    pass', hints: ['用 f-string 拼接。', '注意空格位置。'], solution: 'def solve(code, reason):\n    return f"HTTP/1.1 {code} {reason}"', ref: 'def __ref__(c, r):\n    return "HTTP/1.1 " + str(c) + " " + r', cases: [['200', "'OK'"], ['404', "'Not Found'"], ['500', "'Error'"], ['301', "'Moved'"]] };
    }),
    L('l048', 'concurrency coroutine asyncio general', 4, r => {
      return { title: '用 yield 造一个协程式生成器', brief: '实现 solve(n)，返回一个生成器，依次产出 0..n-1 的平方。判题会转成列表比较。', starter: 'def solve(n):\n    # TODO: 用 yield\n    pass', hints: ['函数体里出现 yield 即为生成器。', 'for i in range(n): yield i*i。'], solution: 'def solve(n):\n    for i in range(n):\n        yield i * i', ref: 'def __ref__(n):\n    return [i*i for i in range(n)]', cases: [['4'], ['0'], ['1'], ['6']], refCall: 'list' };
    }),
    L('l049', 'module module_group pep8 general', 2, r => {
      return { title: '模块式入口函数', brief: '实现 solve(xs)，返回 (元素个数, 元素和) 元组；并写出 if __name__ == "__main__": 的规范入口（判题只调用 solve）。', starter: 'def solve(xs):\n    # TODO\n    pass\n\nif __name__ == "__main__":\n    print(solve([1, 2, 3]))', hints: ['len(xs) 与 sum(xs)。', '入口守卫是规范，不是题目要求的一部分。'], solution: 'def solve(xs):\n    return (len(xs), sum(xs))\n\nif __name__ == "__main__":\n    print(solve([1, 2, 3]))', ref: 'def __ref__(xs):\n    return (len(xs), sum(xs))', cases: [['[1, 2, 3]'], ['[]'], ['[7]'], ['[-1, 1]']] };
    }),
    L('l050', 'meta faq summary general', 1, r => {
      return { title: '最小改动：修好这个函数', brief: '函数 solve(xs) 本应返回列表最后一个元素，但空列表会报错。请修好它：空列表返回 None。', starter: 'def solve(xs):\n    return xs[-1]  # 空列表会抛 IndexError，请修好', hints: ['先判断列表是否为空。', 'if not xs: return None。'], solution: 'def solve(xs):\n    if not xs:\n        return None\n    return xs[-1]', ref: 'def __ref__(xs):\n    return xs[-1] if xs else None', cases: [['[1, 2, 3]'], ['[]'], ["['a']"], ['[0, 0]']] };
    }),
    L('l051', 'thirdparty pillow requests general', 3, r => {
      return { title: '模拟第三方库的配置字典', brief: '实现 solve(pkg, version)，返回形如 {"pkg": 名称, "version": 版本, "source": "PyPI"} 的依赖描述字典。', starter: 'def solve(pkg, version):\n    # TODO\n    pass', hints: ['直接构造一个 dict 返回。', '浏览器里没有这些包，用纯数据描述依赖。'], solution: 'def solve(pkg, version):\n    return {"pkg": pkg, "version": version, "source": "PyPI"}', ref: 'def __ref__(p, v):\n    return {"pkg": p, "version": v, "source": "PyPI"}', cases: [["'requests'", "'2.x'"], ["'pillow'", "'11.x'"], ["'chardet'", "'5.x'"], ["'psutil'", "'7.x'"]] };
    }),
    L('l052', 'network smtp pop3 concurrency distributed general', 4, r => {
      return { title: '协议特征分类', brief: '实现 solve(name)，对 "smtp"/"pop3" 返回 "mail"，对 "tcp"/"udp" 返回 "transport"，其余返回 "unknown"。', starter: 'def solve(name):\n    # TODO\n    pass', hints: ['用字典做映射最清晰。', 'd.get(name, "unknown")。'], solution: 'def solve(name):\n    table = {"smtp": "mail", "pop3": "mail", "tcp": "transport", "udp": "transport"}\n    return table.get(name, "unknown")', ref: 'def __ref__(n):\n    return "mail" if n in ("smtp","pop3") else ("transport" if n in ("tcp","udp") else "unknown")', cases: [["'smtp'"], ["'udp'"], ["'http'"], ["'pop3'"]] };
    }),
  ];

  /* 合并 entry-bank.js 的零基础题（自带 unlock，不依赖 def / 后续语法） */
  const ENTRY = window.ENTRY_BANK || {};
  const ENTRY_MCQ = adopt(ENTRY.mcq || []);
  const ENTRY_LAB = adopt(ENTRY.lab || []);
  MCQ.push.apply(MCQ, ENTRY_MCQ);
  LAB.push.apply(LAB, ENTRY_LAB);

  /* ---------------- 工具函数 ---------------- */
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function makeRng(seed) {
    let a = seed >>> 0;
    const f = () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      f,
      int: (lo, hi) => lo + Math.floor(f() * (hi - lo + 1)),
      pick: (arr) => arr[Math.floor(f() * arr.length)]
    };
  }
  function matchScore(q, lesson, seen, daySeed, opts) {
    const tags = new Set(lesson.tags.concat([lesson.group]));
    let s = 0;
    if (q.tags.some(t => tags.has(t))) s += 120;
    if (q.tags.includes(lesson.group)) s += 25;
    if (q.unlock === lesson.day) s += 70;          // 优先考今天刚学的
    if (q.level <= lesson.difficulty) s += 12;
    else s -= 20;
    s -= (seen[q.id] || 0) * 60;                    // 做过的题降权
    if (opts.recent && opts.recent.indexOf(q.id) >= 0) s -= 160; // 近几天别重复
    s += hashStr(daySeed + q.id) % 17;
    return s;
  }
  // 硬约束：知识点未解锁 / 用户标记过「没学过」/ 早期难度过高 → 一律不出现
  function allowed(q, lesson, opts) {
    const preview = opts.preview ? 1 : 0;
    if (q.unlock > lesson.day + preview) return false;
    if (opts.flagged && opts.flagged.indexOf(q.id) >= 0) return false;
    const cap = lesson.day <= 10 ? 1 : (lesson.day <= 20 ? 2 : 5);
    if (q.level > cap) return false;
    return true;
  }
  function take(pool, count, lesson, seen, daySeed, opts) {
    const ok = pool.filter(q => allowed(q, lesson, opts));
    // 池子不足时放宽难度上限，但「未解锁」这条绝不放宽
    const src = ok.length >= count
      ? ok
      : pool.filter(q => q.unlock <= lesson.day + (opts.preview ? 1 : 0)
          && !(opts.flagged && opts.flagged.indexOf(q.id) >= 0));
    // 老会话首次固定卷子时，优先保留学员已经答过的题；不参与日常组卷
    const prefer = opts.prefer || [];
    const scored = src
      .map(q => ({ q, s: matchScore(q, lesson, seen, daySeed, opts) + (prefer.indexOf(q.id) >= 0 ? 1000 : 0) }))
      .sort((a, b) => b.s - a.s || (a.q.id < b.q.id ? -1 : 1));
    // 只要没做过的题够数，就绝不重复最近两天出过的题
    const recent = opts.recent || [];
    const fresh = scored.filter(x => recent.indexOf(x.q.id) < 0);
    return (fresh.length >= count ? fresh : scored).slice(0, count).map(x => x.q);
  }

  // 当天题量：课程数据里的 plan 是唯一权威；缺字段时退回旧版 5+3，保证旧数据可用。
  function planOf(lesson) {
    const p = lesson && lesson.plan;
    return {
      mcq: p && Number.isInteger(p.mcq) ? p.mcq : 5,
      lab: p && Number.isInteger(p.lab) ? p.lab : 3,
      feynman: p && Number.isInteger(p.feynman) ? p.feynman : (lesson && lesson.feynman ? 1 : 0)
    };
  }
  function pickDaily(lesson, seen, options) {
    seen = seen || {};
    const opts = Object.assign({ preview: false, recent: [], flagged: [] }, options || {});
    const daySeed = lesson.id + '|' + (lesson.day || 1);
    const plan = planOf(lesson);
    const mcqPool = MCQ.concat(GEN);
    const chosenM = take(mcqPool, plan.mcq, lesson, seen, daySeed + 'm',
      Object.assign({}, opts, { prefer: opts.preferMcq || [] }));
    const chosenL = take(LAB, plan.lab, lesson, seen, daySeed + 'l',
      Object.assign({}, opts, { prefer: opts.preferLab || [] }));

    // 通用兜底：生成题的四个选项必须两两不同。若某个随机实例撞出重复项，
    // 换盐重抽最多 24 次；仍失败则按正确项之外补足不重复的占位值，杜绝「四个 8」。
    function distinctOptions(q, baseSeed) {
      let body = null;
      for (let salt = 0; salt < 24; salt++) {
        const r = makeRng(hashStr(baseSeed + '|' + q.id + '|s' + salt));
        const b = q.make(r);
        const seenOpt = new Set(b.options.map(String));
        if (seenOpt.size === b.options.length) { body = b; break; }
      }
      if (!body) {
        const r = makeRng(hashStr(baseSeed + '|' + q.id + '|s0'));
        body = q.make(r);
        const opts = body.options.map(String);
        const used = new Set(opts);
        let pad = 0;
        for (let i = 0; i < opts.length; i++) {
          if (i === body.answer) continue;
          if (used.has(opts[i])) {
            let v = String(pad++);
            while (used.has(v) || v === opts[body.answer]) v = String(pad++);
            opts[i] = v; used.add(v);
          }
        }
        body.options = opts;
      }
      return body;
    }
    const mcq = chosenM.sort((a, b) => a.level - b.level).map(q => {
      const body = q.gen ? distinctOptions(q, daySeed) : q;
      return {
        uid: q.id + '@' + lesson.id, id: q.id, type: 'mcq', level: q.level,
        tags: q.tags, stem: body.stem, options: body.options,
        answer: body.answer, explain: body.explain,
        unlock: q.unlock, req: q.req, reqLabel: reqLabel(q), scaffold: !!q.scaffold
      };
    });

    const lab = chosenL.sort((a, b) => a.level - b.level).map(q => {
      const r = makeRng(hashStr(daySeed + '|' + q.id));
      const b = q.make(r);
      const token = 'PYTUTOR_' + Math.random().toString(36).slice(2, 9).toUpperCase();
      const isStdout = q.mode === 'stdout' || !!b.judge;
      return {
        uid: q.id + '@' + lesson.id, id: q.id, type: 'lab', level: q.level,
        tags: q.tags, title: b.title, brief: b.brief, starter: b.starter,
        hints: b.hints || [], solution: b.solution || '', token,
        unlock: q.unlock, req: q.req, reqLabel: reqLabel(q),
        scaffold: !!q.scaffold, mode: isStdout ? 'stdout' : 'compare',
        judge: isStdout
          ? Object.assign({ mode: 'stdout' }, b.judge || {})
          : b.check
            ? { mode: 'custom', code: b.check.replace('{{TOKEN}}', 'print("' + token + '")') }
            : {
                mode: 'compare', fn: 'solve', ref: b.ref, cases: b.cases,
                refCall: b.refCall || false
              }
      };
    });
    return { mcq, lab, plan: plan };
  }

  function conceptsOnDay(day) {
    return Object.keys(TAG_DAY)
      .filter(k => TAG_DAY[k] === day)
      .map(k => TAG_LABEL[k] || k);
  }
  function poolSizes(day, opts, plan) {
    const fake = { day: day, tags: [], group: '', difficulty: 1,
      plan: plan || { mcq: 5, lab: 3, feynman: 0 } };
    return {
      mcq: MCQ.concat(GEN).filter(q => allowed(q, fake, opts || {})).length,
      lab: LAB.filter(q => allowed(q, fake, opts || {})).length,
      need: planOf(fake)
    };
  }

  return {
    pickDaily, MCQ, GEN, LAB, ENTRY_MCQ, ENTRY_LAB, planOf,
    makeRng, hashStr, TAG_DAY, TAG_LABEL, reqLabel,
    conceptsOnDay, poolSizes, allowed,
    stats: {
      mcq: MCQ.length, gen: GEN.length, lab: LAB.length,
      entryMcq: ENTRY_MCQ.length, entryLab: ENTRY_LAB.length,
      fallback: MCQ.concat(GEN, LAB).filter(q => q.fallback).map(q => q.id)
    }
  };
})();
