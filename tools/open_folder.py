#!/usr/bin/env python3
"""Open the learning-site folder in Explorer (used by the desktop shortcut)."""

from __future__ import annotations

import os
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

if __name__ == "__main__":
    os.startfile(str(ROOT))
