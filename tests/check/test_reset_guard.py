"""reset.sh closes PRs and deletes branches: it must refuse any non-demo target (spec any-repo §5)."""

from __future__ import annotations

import os
import subprocess

from shipgate_config import ROOT

FIXTURES = ROOT / "tests" / "fixtures" / "config"


def test_reset_refuses_a_configured_target_that_is_not_the_demo() -> None:
    env = {**os.environ, "SHIPGATE_CONFIG": str(FIXTURES / "valid-dotted-repo.yaml"), "GITHUB_PAT": ""}
    r = subprocess.run(
        ["bash", str(ROOT / "scripts" / "reset.sh")], capture_output=True, text=True, env=env, cwd=ROOT
    )
    assert r.returncode == 2
    assert "acme/my.pkg_x" in r.stderr and "demo" in r.stderr
