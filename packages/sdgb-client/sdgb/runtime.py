"""Runtime paths shared by the bot and its persistent caches."""
from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("B50_DATA_DIR", str(PROJECT_ROOT))).expanduser()
DATA_DIR.mkdir(parents=True, exist_ok=True)
