"""shipgate.yaml: the one target repo and its commands.

(See docs/superpowers/specs/2026-09-26-any-repo-setup-design.md §2.)

Read by scorer, triage MCP, reset.sh; orchestrator/src/config.ts applies the same rules. Both run fixtures in
tests/fixtures/config/. SHIPGATE_CONFIG=<path> points at another file.

Shell use:  uv run python scripts/shipgate_config.py target.repo   (prints one value; exit 2 on error)
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPO_RE = re.compile(r"^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$")
URL_RE = re.compile(r"^https?://[^\s/]+")
MAX_DESCRIPTION = 500
SCHEMA: dict[str, tuple[str, ...]] = {
    "target": ("repo", "default_branch", "description"),
    "python": ("install", "test", "source_dir", "tests_dir"),
    "trueforge": ("url", "model"),
}


class ConfigError(ValueError):
    """shipgate.yaml is missing or invalid; the message names the file and the key."""


@dataclass(frozen=True)
class Config:
    repo: str
    default_branch: str
    description: str
    install: str
    test: str
    source_dir: str
    tests_dir: str
    trueforge_url: str
    model: str

    @property
    def owner(self) -> str:
        return self.repo.split("/", 1)[0]

    @property
    def name(self) -> str:
        return self.repo.split("/", 1)[1]


def config_path() -> Path:
    """SHIPGATE_CONFIG, else the git-ignored shipgate.local.yaml (each runner's own target),
    else shipgate.yaml."""
    if os.environ.get("SHIPGATE_CONFIG"):
        return Path(os.environ["SHIPGATE_CONFIG"])
    local = ROOT / "shipgate.local.yaml"
    return local if local.exists() else ROOT / "shipgate.yaml"


def _relative(value: str) -> bool:
    return not value.startswith("/") and ".." not in value.split("/") and not re.match(r"^[A-Za-z]:", value)


def load_config(path: Path | str | None = None) -> Config:
    p = Path(path) if path is not None else config_path()

    def err(key: str, problem: str) -> ConfigError:
        return ConfigError(f"{p.name}: {key}: {problem}")

    try:
        data = yaml.safe_load(p.read_text(encoding="utf-8"))
    except OSError as exc:
        raise err("(file)", f"cannot read {p} ({exc.strerror})") from exc
    except yaml.YAMLError as exc:
        raise err("(file)", "invalid YAML") from exc
    if not isinstance(data, dict):
        raise err("(root)", "must be a mapping")
    for key in data:
        if key not in SCHEMA:
            raise err(str(key), "unknown key")
    v: dict[str, str] = {}
    for section, keys in SCHEMA.items():
        block = data.get(section)
        if not isinstance(block, dict):
            raise err(section, "missing or not a mapping")
        for key in block:
            if key not in keys:
                raise err(f"{section}.{key}", "unknown key")
        for key in keys:
            value = block.get(key)
            if not isinstance(value, str) or not value.strip():
                raise err(f"{section}.{key}", "missing or empty")
            v[f"{section}.{key}"] = value.strip()
    if not REPO_RE.match(v["target.repo"]):
        raise err("target.repo", "must be owner/name")
    if len(v["target.description"]) > MAX_DESCRIPTION:
        raise err("target.description", f"longer than {MAX_DESCRIPTION} characters")
    for key in ("python.install", "python.test"):
        if "`" in v[key]:
            raise err(key, "must not contain a backtick")
    for key in ("python.source_dir", "python.tests_dir"):
        if not _relative(v[key]):
            raise err(key, "must be a relative path without '..'")
        v[key] = v[key].rstrip("/")
    if not URL_RE.match(v["trueforge.url"]):
        raise err("trueforge.url", "must be an http(s) URL")
    return Config(
        repo=v["target.repo"],
        default_branch=v["target.default_branch"],
        description=v["target.description"],
        install=v["python.install"],
        test=v["python.test"],
        source_dir=v["python.source_dir"],
        tests_dir=v["python.tests_dir"],
        trueforge_url=v["trueforge.url"],
        model=v["trueforge.model"],
    )


GETTERS: dict[str, Callable[[Config], str]] = {
    "target.repo": lambda c: c.repo,
    "target.owner": lambda c: c.owner,
    "target.name": lambda c: c.name,
    "target.default_branch": lambda c: c.default_branch,
    "trueforge.url": lambda c: c.trueforge_url,
    "trueforge.model": lambda c: c.model,
}


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] not in GETTERS:
        print(f"usage: shipgate_config.py <{'|'.join(GETTERS)}>", file=sys.stderr)
        return 2
    try:
        cfg = load_config()
    except ConfigError as exc:
        print(f"shipgate_config: {exc}", file=sys.stderr)
        return 2
    print(GETTERS[argv[0]](cfg))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
