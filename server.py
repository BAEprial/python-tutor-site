#!/usr/bin/env python3
"""Local server for the private Python learning site.

Serves the static HTML/CSS/JS files and persists learner data so that
WorkBuddy can read ``records/state.json`` and the Obsidian vault in ``notes/``.

Only the Python standard library is used (PEP 8, type hints, no globals).

Usage:
    python server.py                      # http://127.0.0.1:8765/
    python server.py --port 9000 --no-browser
    python server.py --coop               # enable cross-origin isolation
"""

from __future__ import annotations

import argparse
import json
import logging
import mimetypes
import os
import pathlib
import threading
import webbrowser
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parent
RECORDS = ROOT / "records"
NOTES = ROOT / "notes"
STATE_FILE = RECORDS / "state.json"
BACKUP_FILE = RECORDS / "state.backup.json"
MENTOR_FILE = RECORDS / "mentor-replies.json"
BRIEF_FILE = RECORDS / "mentor-brief.md"

LOG = logging.getLogger("pyfirst")


def ensure_dirs() -> None:
    """Create the data directories and seed the mentor inbox."""
    RECORDS.mkdir(exist_ok=True)
    NOTES.mkdir(exist_ok=True)
    if not MENTOR_FILE.exists():
        MENTOR_FILE.write_text(
            json.dumps({"replies": []}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def atomic_write(path: pathlib.Path, text: str) -> None:
    """Write UTF-8 text atomically so a crash cannot truncate learner data."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: pathlib.Path, fallback: Any) -> Any:
    """Read JSON, returning ``fallback`` for a missing or broken file."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def write_scope_feedback(data: dict[str, Any]) -> None:
    """Mirror the learner's 'not taught yet' flags to a file the mentor can read."""
    flags = data.get("scopeFlags", {})
    if not isinstance(flags, dict):
        flags = {}
    lines = [
        "# 超纲反馈（学习页点了「这题没学过」）",
        "",
        f"- 更新时间：{datetime.now().isoformat(timespec='seconds')}",
        f"- 标记数量：{len(flags)}",
        "",
    ]
    if not flags:
        lines.append("暂无标记。")
    else:
        lines += ["| 题目 | 当天 | 标记时间 |", "| --- | --- | --- |"]
        for qid, info in flags.items():
            info = info if isinstance(info, dict) else {}
            lines.append(
                f"| `{qid}` | Day {info.get('day', '?')} | {info.get('ts', '')} |"
            )
        lines += [
            "",
            "> 处理建议：核对该题的 unlock / TAG_DAY 是否设早了，或题干选项里是否用了"
            "未解锁的术语；改完重新生成课程数据并跑 tools/verify.py 复验。",
        ]
    atomic_write(RECORDS / "scope-feedback.md", "\n".join(lines) + "\n")


def _as_dict(value: Any) -> dict[str, Any]:
    """Return a dict for any JSON value (defensive against malformed state)."""
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    """Return a list for any JSON value."""
    return value if isinstance(value, list) else []


def _num(value: Any) -> int:
    """Best-effort integer conversion."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _utcnow() -> str:
    """UTC timestamp in the same shape as JavaScript's ``toISOString()``."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def merge_state(existing: Any, incoming: Any) -> dict[str, Any]:
    """Union-merge learner state so a stale/blank client cannot erase progress.

    The site can be opened from several origins (server URL, built-in preview,
    a local file). Each browser context owns its own ``localStorage``. Merging
    by record identity is what makes ``records/state.json`` the single source
    of truth: a newly opened empty page can never delete real answers.
    """
    old = _as_dict(existing)
    new = _as_dict(incoming)
    out: dict[str, Any] = {}

    # 1) attempts: union by id; voided/retired markers are sticky
    attempts: dict[str, dict[str, Any]] = {}
    for src in (_as_list(old.get("attempts")), _as_list(new.get("attempts"))):
        for item in src:
            if not isinstance(item, dict):
                continue
            key = str(item.get("id") or (item.get("qid"), item.get("ts")))
            prev = attempts.get(key, {})
            rec = dict(prev)
            rec.update(item)
            for flag in ("voided", "retired"):
                if prev.get(flag) or rec.get(flag):
                    rec[flag] = True
            attempts[key] = rec
    out["attempts"] = sorted(attempts.values(), key=lambda a: str(a.get("ts") or ""))

    # 2) progress: a completed lesson is never downgraded
    progress = {k: dict(v) for k, v in _as_dict(old.get("progress")).items()
                if isinstance(v, dict)}
    for lid, rec in _as_dict(new.get("progress")).items():
        if not isinstance(rec, dict):
            continue
        cur = progress.get(lid)
        if cur is None or (rec.get("status") == "done" and cur.get("status") != "done"):
            progress[lid] = rec
        elif str(rec.get("completedAt") or "") > str(cur.get("completedAt") or ""):
            progress[lid] = rec
    out["progress"] = progress

    # 3) sessions: per-lesson deep merge (answer state + code drafts)
    sessions = {k: dict(v) for k, v in _as_dict(old.get("sessions")).items()
                if isinstance(v, dict)}
    for lid, rec in _as_dict(new.get("sessions")).items():
        if not isinstance(rec, dict):
            continue
        cur = dict(sessions.get(lid, {}))
        for part in ("mcq", "lab"):
            merged_part = dict(_as_dict(cur.get(part)))
            merged_part.update(_as_dict(rec.get(part)))
            cur[part] = merged_part
        for key, value in rec.items():
            if key in ("mcq", "lab"):
                continue
            if value not in (None, "") or cur.get(key) in (None, ""):
                cur[key] = value
        sessions[lid] = cur
    out["sessions"] = sessions

    # 4) wrongBook: keep every entry; retired status is sticky
    wrong: dict[str, dict[str, Any]] = {}
    for src in (_as_list(old.get("wrongBook")), _as_list(new.get("wrongBook"))):
        for item in src:
            if not isinstance(item, dict):
                continue
            key = str((item.get("baseId"), item.get("lessonId")))
            prev = wrong.get(key, {})
            rec = dict(prev)
            rec.update(item)
            rec["wrongCount"] = max(_num(prev.get("wrongCount")),
                                    _num(item.get("wrongCount")))
            if prev.get("retired") or rec.get("retired"):
                rec["retired"] = True
                rec["mastered"] = True
            wrong[key] = rec
    out["wrongBook"] = list(wrong.values())

    # 5) notes: prefer non-empty text (a blank page must not clear a draft)
    notes: dict[str, dict[str, Any]] = {}
    for src in (_as_dict(old.get("notes")), _as_dict(new.get("notes"))):
        for lid, rec in src.items():
            if not isinstance(rec, dict):
                continue
            cur = dict(notes.get(lid, {}))
            for key, value in rec.items():
                fresh = bool(str(value or "").strip())
                stale = not str(cur.get(key) or "").strip()
                if fresh or stale:
                    cur[key] = value
            notes[lid] = cur
    out["notes"] = notes

    # 6) free-form drafts (feynman / comment / playground) use the same rule
    drafts = dict(_as_dict(old.get("drafts")))
    for key, value in _as_dict(new.get("drafts")).items():
        if str(value or "").strip() or not str(drafts.get(key) or "").strip():
            drafts[key] = value
    out["drafts"] = drafts

    # 7) comments, snippets, daily activity
    def union_list(key: str, ident: Any) -> list[dict[str, Any]]:
        bucket: dict[str, dict[str, Any]] = {}
        for src in (_as_list(old.get(key)), _as_list(new.get(key))):
            for item in src:
                if isinstance(item, dict):
                    bucket[str(ident(item))] = dict(item)
        return list(bucket.values())

    out["comments"] = union_list(
        "comments", lambda c: c.get("id") or (c.get("ts"), c.get("text")))
    out["snippets"] = union_list("snippets", lambda s: s.get("ts") or s.get("title"))

    activity: dict[str, dict[str, Any]] = {}
    for src in (_as_dict(old.get("activity")), _as_dict(new.get("activity"))):
        for day, rec in src.items():
            if not isinstance(rec, dict):
                continue
            cur = dict(activity.get(day, {}))
            for field in ("lessons", "attempts", "correct"):
                cur[field] = max(_num(cur.get(field)), _num(rec.get(field)))
            activity[day] = cur
    out["activity"] = activity

    # 8) scopeFlags: trust a client that carries real progress, ignore blank ones
    client_has_data = bool(_as_list(new.get("attempts")) or
                           _as_dict(new.get("progress")))
    out["scopeFlags"] = (dict(_as_dict(new.get("scopeFlags"))) if client_has_data
                         else dict(_as_dict(old.get("scopeFlags"))))

    # 9) scalar fields
    for key in ("profile", "settings"):
        merged_scalar = dict(_as_dict(old.get(key)))
        merged_scalar.update(_as_dict(new.get(key)))
        out[key] = merged_scalar
    out["mentorSeen"] = max(_num(old.get("mentorSeen")), _num(new.get("mentorSeen")))
    out["version"] = new.get("version") or old.get("version") or 2
    out["updatedAt"] = _utcnow()
    return out


def write_drafts_md(data: dict[str, Any]) -> None:
    """Mirror unsaved drafts so the mentor sees half-written answers immediately."""
    notes = _as_dict(data.get("notes"))
    drafts = _as_dict(data.get("drafts"))
    lines = [
        "# 实时草稿 · 给导师（WorkBuddy）",
        "",
        f"- 更新时间：{datetime.now().astimezone().isoformat(timespec='seconds')}",
        "- 规则：输入框里每敲一个字都会同步到这里，不需要点「保存」。",
        "- 费曼复述、课堂笔记、代码草稿、留言草稿、实验室代码都算。",
        "",
        "## 一、按天的复述与笔记",
        "",
    ]
    labels = {"feynman": "费曼复述", "note": "课堂笔记", "code": "代码草稿"}
    found = False
    for lid in sorted(notes):
        rec = _as_dict(notes[lid])
        chunks = [(labels[k], str(rec.get(k) or "").strip())
                  for k in labels if str(rec.get(k) or "").strip()]
        if not chunks:
            continue
        found = True
        if lid.startswith("d") and lid[1:].isdigit():
            head = f"### Day {int(lid[1:])}（{lid}）"
        else:
            head = f"### {lid}"
        lines += [head, ""]
        for label, text in chunks:
            lines += [f"**{label}**", "", text, ""]
    if not found:
        lines += ["（暂无）", ""]
    lines += ["## 二、未发布的留言 / 实验室代码草稿", ""]
    extra = [(k, str(v or "").strip()) for k, v in sorted(drafts.items())
             if str(v or "").strip()]
    if extra:
        for key, text in extra:
            lines += [f"**`{key}`**", "", text, ""]
    else:
        lines += ["（暂无）", ""]
    lines += ["> 完整明细见 `records/state.json`；点过「保存」的内容在 `notes/`。", ""]
    atomic_write(RECORDS / "drafts.md", "\n".join(lines))


def safe_name(name: str) -> str:
    """Return a safe basename for a note file."""
    cleaned = pathlib.Path(name).name.replace("\\", "").replace("/", "")
    if not cleaned.endswith(".md"):
        cleaned += ".md"
    return cleaned


class Handler(SimpleHTTPRequestHandler):
    """Static files plus a tiny JSON API."""

    server_version = "PyFirst/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        LOG.info("%s - %s", self.address_string(), fmt % args)

    def translate_path(self, path: str) -> str:
        """Keep private records and build tools out of the static web root."""
        full = pathlib.Path(super().translate_path(path)).resolve()
        try:
            rel = full.relative_to(ROOT)
        except ValueError:
            return str(ROOT / "_outside_root")
        private = {"records", "tools", "notes", ".workbuddy", ".git"}
        if rel.parts and rel.parts[0] in private:
            return str(ROOT / "_private")
        return str(full)

    def end_headers(self) -> None:
        # The site may be opened from a file:// page or the editor's preview
        # panel (different origin). Allow those contexts to reach the same
        # records/state.json instead of falling back to an empty localStorage.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if getattr(self.server, "coop", False):
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802 (stdlib naming)
        """Answer CORS preflight triggered by JSON POSTs from another origin."""
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _json(self, obj: Any, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except (ValueError, UnicodeDecodeError):
            return {}

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path.startswith("/api/state"):
            self._json(read_json(STATE_FILE, {}))
            return
        if self.path.startswith("/api/mentor"):
            data = read_json(MENTOR_FILE, {"replies": []})
            self._json({"replies": data.get("replies", [])})
            return
        if self.path.startswith("/api/brief"):
            text = BRIEF_FILE.read_text(encoding="utf-8") if BRIEF_FILE.exists() else ""
            self._json({"markdown": text})
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path.startswith("/api/state"):
            data = self._body()
            if not data:
                self._json({"ok": False, "error": "empty payload"}, 400)
                return
            # Never overwrite: merge by record identity. A blank page opened
            # in another browser context can no longer wipe out real progress.
            existing = read_json(STATE_FILE, {})
            # Explicit user actions (reset / import a backup) may replace the
            # whole snapshot; ordinary saves are always merged.
            replace = "replace=1" in self.path
            merged = data if replace else merge_state(existing, data)
            if STATE_FILE.exists():
                try:
                    BACKUP_FILE.write_text(
                        STATE_FILE.read_text(encoding="utf-8"), encoding="utf-8")
                except OSError:
                    LOG.warning("could not write state backup")
            atomic_write(STATE_FILE, json.dumps(merged, ensure_ascii=False, indent=2))
            for job in (write_scope_feedback, write_drafts_md):
                try:
                    job(merged)
                except OSError:
                    LOG.warning("could not write mentor mirror")
            self._json({"ok": True, "merged": True})
            return

        if self.path.startswith("/api/notes/sync"):
            files = self._body().get("files", {})
            if not isinstance(files, dict):
                self._json({"ok": False, "error": "files must be an object"}, 400)
                return
            written = 0
            for name, text in files.items():
                if not isinstance(name, str) or not isinstance(text, str):
                    continue
                atomic_write(NOTES / safe_name(name), text)
                written += 1
            self._json({"ok": True, "written": written})
            return

        if self.path.startswith("/api/report"):
            markdown = self._body().get("markdown", "")
            if not isinstance(markdown, str):
                self._json({"ok": False, "error": "markdown must be a string"}, 400)
                return
            atomic_write(BRIEF_FILE, markdown)
            self._json({"ok": True})
            return

        self._json({"ok": False, "error": "unknown endpoint"}, 404)


def seed_vault() -> None:
    """Create the Obsidian starter pages, without overwriting existing notes."""
    meta: dict[str, Any] = {}
    course_js = ROOT / "assets" / "data" / "course.js"
    if course_js.exists():
        raw = course_js.read_text(encoding="utf-8")
        try:
            meta = json.loads(
                raw[len("window.COURSE = "):].rstrip().rstrip(";")
            ).get("meta", {})
        except ValueError:
            meta = {}
    starters = {
        "笔记册首页.md": (
            "---\ntags: [python, 笔记册首页]\n---\n\n# Python 私塾 · 笔记册\n\n"
            "用 Obsidian 打开本文件夹即为知识库。\n\n"
            f"- 原文：{meta.get('sourceName', '廖雪峰 Python 教程')} "
            f"[{meta.get('source', '')}]({meta.get('source', '')})（免费）\n"
            f"- 计划：{meta.get('totalDays', 112)} 天 / 每天 "
            f"{meta.get('dailyMinutes', 20)} 分钟\n"
            "- 方法：第一性原理 + 费曼学习法 + 间隔重复\n\n"
            "## 常用\n\n- [[错题册]]\n- [[学习周报]]\n- [[导师答疑]]\n\n"
            "在学习站点击「同步到 Obsidian 文件夹」后，每一节会生成 `Day-xxx.md`。\n"
        ),
        "错题册.md": "# 错题册\n\n还没有错题。做错的题会自动同步到这里。\n",
        "学习周报.md": "# 学习周报\n\n在进度页点击「写入 records/ 供导师读取」后，这里会更新。\n",
        "导师答疑.md": "# 导师答疑\n\n在网站 Comments 里提问；WorkBuddy 的回信会出现在网站和这里。\n",
    }
    for name, text in starters.items():
        target = NOTES / name
        if not target.exists():
            target.write_text(text, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    """Parse CLI options."""
    parser = argparse.ArgumentParser(description="PyFirst local learning server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    parser.add_argument(
        "--coop", action="store_true",
        help="send COOP/COEP headers (enables Pyodide interrupt timeout; "
             "may block some CDN resources)",
    )
    return parser.parse_args()


def main() -> None:
    """Start the local server."""
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    ensure_dirs()
    seed_vault()
    mimetypes.add_type("application/wasm", ".wasm")
    mimetypes.add_type("text/javascript", ".mjs")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.coop = args.coop  # type: ignore[attr-defined]
    url = f"http://{args.host}:{args.port}/"
    LOG.info("serving %s at %s", ROOT, url)
    LOG.info("state: %s | notes: %s | mentor inbox: %s", STATE_FILE, NOTES, MENTOR_FILE)
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        LOG.info("shutting down")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
