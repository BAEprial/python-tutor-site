#!/usr/bin/env python3
"""End-to-end verification of course data, daily papers and auto-grading.

1. Loads the generated JS data with Node and assembles a paper for all 112 days,
   simulating a learner who answers every question (so seen/recent de-duplication
   is exercised exactly as in the browser).
2. Checks the anti-overscope invariants:
   - no question may appear before its unlock day,
   - no advanced terminology may appear in a day's question text before that day,
   - every day must match its difficulty-based plan (3-5 MCQ, 1-3 lab,
     0-1 Feynman) and the pool must cover that plan,
   - no question may repeat on consecutive days,
   - every question must map to a real knowledge point (no silent fallback).
3. Runs the *reference solution* of every programming exercise through the
   exact same grading script the browser uses, and asserts it passes.

Run:  python tools/verify.py
"""

from __future__ import annotations

import contextlib
import io
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

NODE_SCRIPT = r"""
global.window = {};
const fs = require('fs');
eval(fs.readFileSync('assets/data/course.js', 'utf8'));
eval(fs.readFileSync('assets/data/entry-bank.js', 'utf8'));
eval(fs.readFileSync('assets/data/question-bank.js', 'utf8'));
eval(fs.readFileSync('assets/py-runner.js', 'utf8'));
const C = window.COURSE, Q = window.QB, P = window.PyRun;

// 术语 -> 首次允许出现的 Day。用于抓出「必须搜才能懂」的提前名词。
const TERMS = [
  ['装饰器', 34], ['生成器', 25], ['闭包', 32], ['元类', 51], ['迭代器', 26],
  ['可哈希', 15], ['魔法命令', 4], ['venv', 38], ['pip', 38], ['snake_case', 8],
  ['CPython', 4], ['IPython', 4], ['Traceback', 53], ['asyncio', 109],
  ['GIL', 64], ['lambda', 33], ['pickle', 61], ['__slots__', 45],
  ['dict', 15], ['tuple', 11], ['def ', 16], ['return', 16],
  ['import ', 36], ['class ', 39], ['yield', 25], ['isinstance', 43],
  ['functools', 34], ['requirements.txt', 38], ['UPPER_CASE', 8], ['CapWords', 40]
];

const days = [], scripts = [], problems = [], scopeProblems = [], termProblems = [];
const poolProblems = [], repeatProblems = [];
const seen = {}, recentDays = [];

for (const l of C.lessons) {
  const recent = recentDays.slice(-2).flat();
  const paper = Q.pickDaily(l, seen, { recent: recent, flagged: [], preview: false });
  const want = l.plan || { mcq: 5, lab: 3, feynman: l.feynman ? 1 : 0 };
  if (!(want.mcq >= 3 && want.mcq <= 5)) problems.push(l.id + ' plan.mcq=' + want.mcq);
  if (!(want.lab >= 1 && want.lab <= 3)) problems.push(l.id + ' plan.lab=' + want.lab);
  if (!(want.feynman === 0 || want.feynman === 1)) problems.push(l.id + ' plan.feynman=' + want.feynman);
  if (want.feynman !== (l.feynman ? 1 : 0)) problems.push(l.id + ' plan.feynman 与 feynman 内容不一致');
  if (paper.mcq.length !== want.mcq) problems.push(l.id + ' mcq=' + paper.mcq.length + ' want=' + want.mcq);
  if (paper.lab.length !== want.lab) problems.push(l.id + ' lab=' + paper.lab.length + ' want=' + want.lab);

  const all = paper.mcq.concat(paper.lab);
  for (const q of all) {
    if (q.unlock > l.day) scopeProblems.push('Day ' + l.day + ' ' + q.id + ' unlock=' + q.unlock);
    if (!q.reqLabel) problems.push(l.id + ' ' + q.id + ' missing reqLabel');
    // 代码骨架里出现 def solve，就说明这天还没资格出函数题
    if (l.day < 18 && q.type === 'lab' && q.mode !== 'stdout')
      scopeProblems.push('Day ' + l.day + ' ' + q.id + ' 提前出现函数式编程题');
    if (l.day < 18 && q.starter && q.starter.indexOf('def ') >= 0)
      scopeProblems.push('Day ' + l.day + ' ' + q.id + ' starter 提前出现 def');
    const text = [q.stem || '', q.brief || '', q.explain || '', q.title || '']
      .concat(q.options || []).concat(q.hints || []).join(' ');
    for (const [term, day] of TERMS) {
      if (l.day < day && text.indexOf(term) >= 0)
        termProblems.push('Day ' + l.day + ' ' + q.id + ' 提前出现「' + term + '」(Day ' + day + ')');
    }
  }
  for (const q of paper.mcq) {
    if (!q.stem || !Array.isArray(q.options) || q.options.length !== 4) problems.push(l.id + ' ' + q.id + ' bad options');
    // 四个选项必须两两不同：参数化生成题（如 g001）在某些随机数下会让多个公式退化成同一个值。
    if (Array.isArray(q.options)) {
      const uq = new Set(q.options.map(String));
      if (uq.size !== q.options.length) problems.push(l.id + ' ' + q.id + ' 重复选项 ' + JSON.stringify(q.options));
    }
    if (q.answer < 0 || q.answer > 3) problems.push(l.id + ' ' + q.id + ' bad answer');
    if (!q.explain) problems.push(l.id + ' ' + q.id + ' no explain');
  }
  for (const q of paper.lab) {
    if (!q.brief || !q.starter || !q.solution || !q.judge) problems.push(l.id + ' ' + q.id + ' incomplete lab');
    scripts.push({ id: l.id + '/' + q.id, token: q.token, script: P.buildScript(q, q.solution) });
  }

  const sizes = Q.poolSizes(l.day, {}, want);
  if (sizes.mcq < want.mcq || sizes.lab < want.lab)
    poolProblems.push('Day ' + l.day + ' pool mcq=' + sizes.mcq + '/' + want.mcq + ' lab=' + sizes.lab + '/' + want.lab);

  const ids = all.map(q => q.id);
  for (const qid of ids) {
    if (recent.indexOf(qid) >= 0) repeatProblems.push('Day ' + l.day + ' 连续重复 ' + qid);
  }
  recentDays.push(ids);
  if (recentDays.length > 3) recentDays.shift();
  ids.forEach(id => { seen[id] = (seen[id] || 0) + 1; });

  days.push({ id: l.id, day: l.day, title: l.title,
    mcq: paper.mcq.length, lab: paper.lab.length, feynman: want.feynman,
    ids: ids, unlocks: all.map(q => q.unlock) });
}

// 入门第一行代码的判据：引号是外壳（单双引号等价）、英文逗号后的空格是排版习惯，
// 两者都不该决定「会不会 print」；中文全角逗号在引号内部，属于内容差异，仍应判错。
const s001 = Q.ENTRY_LAB.find(q => q.id === 's001');
const s001Body = s001.make(Q.makeRng(7));
const eqQuestion = {
  token: 'PYTUTOR_EQ',
  judge: Object.assign({ mode: 'stdout' }, s001Body.judge)
};
const equivalence = [
  { name: '单引号+空格',   code: "print('Hello, world!')", pass: true },
  { name: '双引号+空格',   code: 'print("Hello, world!")', pass: true },
  { name: '单引号+无空格', code: "print('Hello,world!')",  pass: true },
  { name: '双引号+无空格', code: 'print("Hello,world!")',  pass: true },
  { name: '中文全角逗号',  code: "print('Hello，world!')", pass: false },
  { name: '内容完全不对',  code: "print('Hi')",            pass: false }
].map(x => Object.assign(x, {
  token: eqQuestion.token, script: P.buildScript(eqQuestion, x.code)
}));

console.log(JSON.stringify({
  total: C.lessons.length, chapters: C.chapters.length,
  bank: Q.stats, days, scripts, problems, equivalence,
  scopeProblems, termProblems, poolProblems, repeatProblems
}));
"""


def main() -> int:
    """Run all checks; return a process exit code."""
    proc = subprocess.run(
        ["node", "-e", NODE_SCRIPT],
        cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8",
    )
    if proc.returncode != 0:
        print("Node stage failed:\n" + proc.stderr)
        return 1
    data = json.loads(proc.stdout)
    print(f"course: {data['total']} days / {data['chapters']} chapters")
    print(f"bank:   {data['bank']}")
    print(f"papers: {len(data['days'])} assembled, "
          f"{sum(d['mcq'] for d in data['days'])} MCQ + "
          f"{sum(d['lab'] for d in data['days'])} LAB slots")

    failures = []
    for key, label in [
        ("problems", "结构"),
        ("scopeProblems", "超纲（题目早于解锁日）"),
        ("termProblems", "提前术语"),
        ("poolProblems", "题池不足"),
        ("repeatProblems", "连续重复"),
    ]:
        items = data[key]
        if items:
            failures.append((label, items))
        print(f"{label}: {'OK' if not items else str(len(items)) + ' 处问题'}")
        for msg in items[:12]:
            print("   -", msg)

    fallback = data["bank"].get("fallback", [])
    if fallback:
        failures.append(("未映射知识点的题目", fallback))
        print("未映射知识点的题目:", fallback[:20])
    else:
        print("知识点映射: OK")

    early = [d for d in data["days"] if d["day"] <= 15]
    print("\n前 15 天组卷（题 id / 各自解锁日）:")
    for d in early:
        print(f"  Day {d['day']:>2} {d['title']}: {','.join(d['ids'])}"
              f"   unlock={max(d['unlocks'])}")

    grade_failures = []
    for item in data["scripts"]:
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                exec(compile(item["script"], "<" + item["id"] + ">", "exec"),
                     {"__name__": "__main__"})
            if item["token"] not in buf.getvalue():
                grade_failures.append((item["id"], "token missing: " + buf.getvalue()[:200]))
        except Exception as exc:  # noqa: BLE001 - verification wants every error
            grade_failures.append((item["id"], f"{type(exc).__name__}: {exc}"))

    print(f"\n判题: {len(data['scripts'])} 个脚本实跑，"
          f"{len(grade_failures)} 个失败")
    for name, msg in grade_failures[:20]:
        print("   -", name, "→", msg)
    if grade_failures:
        failures.append(("参考解答判题", [f"{n}: {m}" for n, m in grade_failures[:20]]))

    eq_failures = []
    for item in data["equivalence"]:
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                exec(compile(item["script"], "<eq:" + item["name"] + ">", "exec"),
                     {"__name__": "__main__"})
            passed = item["token"] in buf.getvalue()
        except Exception:  # noqa: BLE001 - a failing grade raises on purpose
            passed = False
        if passed != item["pass"]:
            eq_failures.append((item["name"], f"预期 {item['pass']}，实际 {passed}"))
    print(f"引号/空格等价性: {len(data['equivalence'])} 个用例，"
          f"{len(eq_failures)} 个不符")
    for name, msg in eq_failures:
        print("   -", name, "→", msg)
    if eq_failures:
        failures.append(("引号/空格等价性", [f"{n}: {m}" for n, m in eq_failures]))

    if failures:
        print("\n=== 验证未通过 ===")
        return 1
    print("\n=== 全部验证通过：无超纲、无提前术语、无连续重复、判题全通过 ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
