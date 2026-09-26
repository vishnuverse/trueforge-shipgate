"""The one tolerant .env reader for the Python side (triage MCP, seed_jira.py). Stdlib only.

The env file is SHIPGATE_ENV_FILE when set, else <repo>/.env (the same rule as scripts/setup.sh and
scripts/setup_trueforge.ts). Values are returned, never printed.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def env_path(environ: Mapping[str, str] | None = None) -> Path:
    environ = os.environ if environ is None else environ
    return Path(environ["SHIPGATE_ENV_FILE"]) if environ.get("SHIPGATE_ENV_FILE") else ROOT / ".env"


def read_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export") and key[6:7].isspace():  # `export KEY=value` (shell-sourceable .env)
            key = key[6:].strip()
        if not key.isidentifier():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key] = value
    return out


def load_env(dotenv: Path, environ: Mapping[str, str]) -> dict[str, str]:
    """The process environment wins over .env."""
    return {**read_dotenv(dotenv), **dict(environ)}
