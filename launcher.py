#!/usr/bin/env python3
"""One-click, persistent entry point for the private Python learning site.

If the server is already running, just open the site. Otherwise this process
*becomes* the server (and stays alive), so a double-click on the desktop
shortcut keeps the local service up for the whole session.

Only the Python standard library is used.
"""

from __future__ import annotations

import argparse
import pathlib
import socket
import sys
import webbrowser

ROOT = pathlib.Path(__file__).resolve().parent
PORT = 8765
HOST = "127.0.0.1"
URL = f"http://{HOST}:{PORT}/"


def is_running() -> bool:
    """Return True when the learning server already answers on PORT."""
    try:
        with socket.create_connection((HOST, PORT), timeout=0.4):
            return True
    except OSError:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Open the Python tutor")
    parser.add_argument("--no-browser", action="store_true",
                        help="keep serving but do not open a browser window")
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()

    if is_running():
        if not args.no_browser:
            webbrowser.open(URL)
        return

    # Run the server in THIS process. Launched from a pythonw.exe shortcut
    # there is no console window, and the service lives until the user logs out.
    sys.path.insert(0, str(ROOT))
    import server  # noqa: PLC0415  (local module, imported only when needed)
    sys.argv = ["server.py", "--port", str(args.port)] + (
        ["--no-browser"] if args.no_browser else []
    )
    server.main()


if __name__ == "__main__":
    main()
