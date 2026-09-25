from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import pytest
from shipgate_check.cli import main

REPO_ROOT = Path(__file__).resolve().parents[2]
SCENARIOS = REPO_ROOT / "tests" / "scenarios"


@pytest.fixture
def runs_dir(tmp_path: Path) -> Path:
    d = tmp_path / "runs"
    d.mkdir()
    return d


@pytest.fixture
def check(runs_dir: Path, tmp_path: Path):
    """Run check.py in-process: check(*argv, github=..., trueforge=...) -> (exit_code, output).
    Offline unless a fake GitHub/TrueForge is passed. `root=tmp_path` keeps the real .env out of tests."""

    def _run(*argv: str, **kw: Any) -> tuple[int, str]:
        out = io.StringIO()
        args = [*argv, "--runs-dir", str(runs_dir), "--scenarios-dir", str(SCENARIOS)]
        if "github" not in kw and "trueforge" not in kw and "--offline" not in argv:
            args.append("--offline")
        code = main(args, out=out, root=tmp_path, **kw)
        return code, out.getvalue()

    return _run
