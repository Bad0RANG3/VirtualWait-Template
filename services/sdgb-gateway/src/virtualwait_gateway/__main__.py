from __future__ import annotations

from pathlib import Path
import os


def _load_env_file(path: Path) -> None:
    """Load KEY=VALUE pairs without overriding existing process env."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


# Prefer cwd .env.local, then package-adjacent defaults for local dev.
_cwd = Path.cwd()
_load_env_file(_cwd / ".env.local")
_load_env_file(_cwd / ".env")
_package_root = Path(__file__).resolve().parents[2]
_load_env_file(_package_root / ".env.local")
_load_env_file(_package_root / ".env")

from .app import main

main()
