"""shipgate.yaml loader (spec any-repo §2). The same fixtures run in orchestrator/test/config.test.ts."""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest
from shipgate_config import ROOT, ConfigError, load_config

FIXTURES = ROOT / "tests" / "fixtures" / "config"
EXPECTED: dict[str, str | None] = json.loads((FIXTURES / "expected.json").read_text())


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_fixture(name: str) -> None:
    want = EXPECTED[name]
    if want is None:
        cfg = load_config(FIXTURES / name)
        assert cfg.owner and cfg.name and cfg.repo == f"{cfg.owner}/{cfg.name}"
        assert cfg.source_dir == "src/humanize" and cfg.tests_dir == "tests"  # trailing '/' normalised
    else:
        with pytest.raises(ConfigError) as exc:
            load_config(FIXTURES / name)
        assert f"{name}: {want}: " in str(exc.value)


def test_dotted_repo_splits_owner_and_name() -> None:
    cfg = load_config(FIXTURES / "valid-dotted-repo.yaml")
    assert (cfg.owner, cfg.name) == ("acme", "my.pkg_x")


def test_committed_config_is_the_demo() -> None:
    cfg = load_config(ROOT / "shipgate.yaml")
    assert cfg.repo == "drax0945/humanize" and cfg.default_branch == "main"
    assert cfg.test == ".venv/bin/python -m pytest -q -p no:cacheprovider --benchmark-disable --color=no"
    assert cfg.install == '.venv/bin/pip install -q --disable-pip-version-check -e ".[tests]"'
    assert cfg.description.startswith("humanize is a Python library") and "\n" not in cfg.description


def test_env_var_points_at_another_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SHIPGATE_CONFIG", str(FIXTURES / "valid-dotted-repo.yaml"))
    assert load_config().repo == "acme/my.pkg_x"


def test_cli_prints_one_value_and_exits_2_on_a_config_error() -> None:
    cmd = [sys.executable, str(ROOT / "scripts" / "shipgate_config.py"), "target.repo"]
    env = {k: v for k, v in os.environ.items() if k != "SHIPGATE_CONFIG"}
    ok = subprocess.run(cmd, capture_output=True, text=True, env=env)
    assert ok.returncode == 0 and ok.stdout == "drax0945/humanize\n"
    bad = subprocess.run(
        cmd, capture_output=True, text=True, env={**env, "SHIPGATE_CONFIG": str(FIXTURES / "bad-repo.yaml")}
    )
    assert bad.returncode == 2 and "target.repo" in bad.stderr
    usage = subprocess.run(cmd[:2] + ["nope"], capture_output=True, text=True, env=env)
    assert usage.returncode == 2
