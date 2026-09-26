"""Live smoke test (spec §9): real GitHub + real TypeSafe on the fork's fixture issues.

Run before filming:  uv run pytest -m live tests/mcp -q
(reads TYPESAFE_API_KEY from .env or the environment)
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx
import pytest
import server
from shipgate_config import load_config

pytestmark = pytest.mark.live
ENV = server.load_env(server.env_path(), os.environ)
needs_key = pytest.mark.skipif(not ENV.get("TYPESAFE_API_KEY"), reason="TYPESAFE_API_KEY not set")


def _triage(n: int, tmp_path: Path) -> dict:
    with httpx.Client() as c:
        return server.triage(n, client=c, env=ENV, audit_log=tmp_path / "triage.jsonl", config=load_config())


@needs_key
def test_live_issue_1_is_a_patchable_defect(tmp_path: Path) -> None:
    v = _triage(1, tmp_path)
    assert v["error"] is None, v
    assert v["route"] == "defect" and v["patch_allowed"] is True, v


@needs_key
def test_live_issue_3_is_held(tmp_path: Path) -> None:
    v = _triage(3, tmp_path)
    assert v["error"] is None, v
    assert v["patch_allowed"] is False, v
