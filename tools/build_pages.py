#!/usr/bin/env python3
"""Generate the seven static HTML pages that share ``assets/app.js``.

Keeping the shell pages generated means every page gets the same script order,
viewport settings and navigation contract.

Run:  python tools/build_pages.py
"""

from __future__ import annotations

import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

PAGES = {
    "index.html": ("home", "今日任务"),
    "catalog.html": ("catalog", "课程目录"),
    "lesson.html": ("lesson", "这一节"),
    "playground.html": ("playground", "编程实验室"),
    "review.html": ("review", "错题册与历史"),
    "notes.html": ("notes", "笔记册"),
    "progress.html": ("progress", "学习进度"),
}

TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="私人定制的 Python 学习站：第一性原理 + 费曼学习法，一天一节，含浏览器内 Python 编程与自动判题。">
  <title>{title} · Python 私塾</title>
  <link rel="stylesheet" href="assets/app.css">
</head>
<body data-page="{page}">
  <header id="topbar"></header>
  <main class="wrap" id="app">
    <div class="card"><p class="muted">正在加载课程数据… 若长时间无响应，请通过 <span class="kbd">start.bat</span> 启动本地服务。</p></div>
  </main>
  <script src="assets/data/course.js"></script>
  <script src="assets/data/entry-bank.js"></script>
  <script src="assets/data/question-bank.js"></script>
  <script src="assets/py-runner.js"></script>
  <script src="assets/app.js"></script>
</body>
</html>
"""


def main() -> None:
    """Write all page shells."""
    for name, (page, title) in PAGES.items():
        (ROOT / name).write_text(
            TEMPLATE.format(page=page, title=title), encoding="utf-8"
        )
    print(f"wrote {len(PAGES)} html pages")


if __name__ == "__main__":
    main()
