"""shipgate.yaml loader (spec any-repo §2). The same fixtures run in orchestrator/test/config.test.ts."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

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
    assert cfg.repo == "vishnuverse/humanize" and cfg.default_branch == "main"
    assert cfg.test == ".venv/bin/python -m pytest -q -p no:cacheprovider --benchmark-disable --color=no"
    assert cfg.install == '.venv/bin/pip install -q --disable-pip-version-check -e ".[tests]"'
    assert cfg.description.startswith("humanize is a Python library") and "\n" not in cfg.description


def test_env_var_points_at_another_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SHIPGATE_CONFIG", str(FIXTURES / "valid-dotted-repo.yaml"))
    assert load_config().repo == "acme/my.pkg_x"


def test_cli_prints_one_value_and_exits_2_on_a_config_error() -> None:
    cmd = [sys.executable, str(ROOT / "scripts" / "shipgate_config.py"), "target.repo"]
    env = {**os.environ, "SHIPGATE_CONFIG": str(ROOT / "shipgate.yaml")}
    ok = subprocess.run(cmd, capture_output=True, text=True, env=env)
    assert ok.returncode == 0 and ok.stdout == "vishnuverse/humanize\n"
    bad = subprocess.run(
        cmd, capture_output=True, text=True, env={**env, "SHIPGATE_CONFIG": str(FIXTURES / "bad-repo.yaml")}
    )
    assert bad.returncode == 2 and "target.repo" in bad.stderr
    usage = subprocess.run(cmd[:2] + ["nope"], capture_output=True, text=True, env=env)
    assert usage.returncode == 2


def test_local_file_overrides_the_committed_one(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Each person running the agent keeps their own target in a git-ignored shipgate.local.yaml."""
    import shipgate_config

    (tmp_path / "shipgate.yaml").write_text((FIXTURES / "valid.yaml").read_text())
    monkeypatch.setattr(shipgate_config, "ROOT", tmp_path)
    monkeypatch.delenv("SHIPGATE_CONFIG", raising=False)
    assert shipgate_config.config_path() == tmp_path / "shipgate.yaml"
    (tmp_path / "shipgate.local.yaml").write_text((FIXTURES / "valid-dotted-repo.yaml").read_text())
    assert shipgate_config.config_path() == tmp_path / "shipgate.local.yaml"
    assert shipgate_config.load_config().repo == "acme/my.pkg_x"
    monkeypatch.setenv("SHIPGATE_CONFIG", str(tmp_path / "shipgate.yaml"))
    assert shipgate_config.config_path() == tmp_path / "shipgate.yaml"


def test_jira_section_is_optional_and_parsed() -> None:
    assert load_config(FIXTURES / "valid.yaml").jira is None
    jira = load_config(FIXTURES / "valid-jira.yaml").jira
    assert jira is not None
    assert (jira.site, jira.project, jira.cloud_id) == (
        "developertunnel.atlassian.net",
        "KAN",
        "ce61dd8b-2e04-4815-9b7b-60a570df782b",
    )
    assert (jira.status_start, jira.status_review, jira.status_open) == ("In Progress", "In Review", "To Do")
    assert jira.key_re().match("KAN-4") and not jira.key_re().match("kan-4")
    assert not jira.key_re().match("SAM1-4") and not jira.key_re().match("KAN-0")
    assert jira.ticket_url("KAN-4") == "https://developertunnel.atlassian.net/browse/KAN-4"


def test_ticket_names_follow_the_shared_rule() -> None:
    from shipgate_config import ticket_names

    for case in json.loads((FIXTURES / "ticket-names.json").read_text()):
        got = ticket_names(case["key"], case["tests_dir"])
        assert got == {k: case[k] for k in ("ref", "slug", "branch", "test_file")}
