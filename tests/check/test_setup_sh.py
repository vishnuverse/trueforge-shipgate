"""scripts/setup.sh and stop.sh (spec any-repo §4): the offline paths. Real registration is the live task."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from shipgate_config import ROOT

FAKE = {
    "GITHUB_PAT": "ghp_fake_value_1234",
    "OPENROUTER_API_KEY": "sk-or-fake-5678",
    "OPENAI_API_KEY": "sk-oa-fake-3456",
    "TYPESAFE_API_KEY": "ts-fake-9012",
    "JIRA_EMAIL": "dev-fake@example.test",
    "JIRA_API_KEY": "jira-fake-3456",
}
GITHUB_ONLY = {k: v for k, v in FAKE.items() if not k.startswith("JIRA_")}
NO_JIRA = ROOT / "tests" / "fixtures" / "config" / "valid.yaml"  # shipgate.yaml carries a jira: section
OPENROUTER_CONFIG = NO_JIRA  # trueforge.model: openrouter/...; shipgate.yaml uses openai/...


def run(
    *args: str, env_file: Path | None = None, extra: dict[str, str] | None = None
) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k not in FAKE}
    env["SHIPGATE_CONFIG"] = str(ROOT / "shipgate.yaml")  # never a developer's shipgate.local.yaml
    if env_file is not None:
        env["SHIPGATE_ENV_FILE"] = str(env_file)
    env.update(extra or {})
    return subprocess.run(["bash", *args], capture_output=True, text=True, env=env, cwd=ROOT, timeout=120)


def env_file(tmp_path: Path, lines: list[str]) -> Path:
    p = tmp_path / ".env"
    p.write_text("\n".join(lines) + "\n")
    return p


def test_dry_run_prints_the_plan_and_no_secret(tmp_path: Path) -> None:
    pids = tmp_path / "pids"
    r = run(
        "scripts/setup.sh", "--dry-run",
        env_file=env_file(tmp_path, [f"{k}={v}" for k, v in FAKE.items()]),
        extra={"SHIPGATE_PID_DIR": str(pids)},
    )  # fmt: skip
    assert r.returncode == 0, r.stderr
    out = r.stdout + r.stderr
    for phrase in (
        "would start TrueForge",
        "would register",
        "vishnuverse/humanize",
        "would create missing labels",
        "model provider openai",
    ):
        assert phrase in out, phrase
    assert all(v not in out for v in FAKE.values())
    assert not pids.exists()


def test_export_and_quoted_env_lines_count(tmp_path: Path) -> None:
    lines = [
        'export GITHUB_PAT="ghp_fake_value_1234"',
        "OPENAI_API_KEY='sk-oa-fake-3456'",
        "TYPESAFE_API_KEY=ts-fake-9012",
        'export JIRA_EMAIL="dev-fake@example.test"',
        "JIRA_API_KEY='jira-fake-3456'",
    ]
    r = run("scripts/setup.sh", "--dry-run", env_file=env_file(tmp_path, lines))
    assert r.returncode == 0, r.stderr


def test_empty_key_is_a_usage_error_naming_the_key(tmp_path: Path) -> None:
    r = run(
        "scripts/setup.sh",
        "--dry-run",
        env_file=env_file(tmp_path, ["GITHUB_PAT=x", "OPENAI_API_KEY=", "TYPESAFE_API_KEY=y"]),
    )
    assert r.returncode == 2 and "OPENAI_API_KEY" in r.stderr


def test_only_the_configured_providers_key_is_required(tmp_path: Path) -> None:
    """trueforge.model picks the provider: openai/... needs OPENAI_API_KEY, openrouter/... its own key."""
    base = ["GITHUB_PAT=x", "TYPESAFE_API_KEY=z", "JIRA_EMAIL=e", "JIRA_API_KEY=j"]
    openai_only = env_file(tmp_path, [*base, "OPENAI_API_KEY=y"])
    assert run("scripts/setup.sh", "--dry-run", env_file=openai_only).returncode == 0
    r = run(
        "scripts/setup.sh", "--dry-run",
        env_file=openai_only, extra={"SHIPGATE_CONFIG": str(OPENROUTER_CONFIG)},
    )  # fmt: skip
    assert r.returncode == 2 and "OPENROUTER_API_KEY" in r.stderr
    openrouter_only = env_file(tmp_path, [*base, "OPENROUTER_API_KEY=y"])
    r = run(
        "scripts/setup.sh", "--dry-run",
        env_file=openrouter_only, extra={"SHIPGATE_CONFIG": str(OPENROUTER_CONFIG)},
    )  # fmt: skip
    assert r.returncode == 0 and "model provider openrouter" in r.stdout + r.stderr


def test_config_error_exits_2(tmp_path: Path) -> None:
    bad = ROOT / "tests" / "fixtures" / "config" / "bad-repo.yaml"
    r = run(
        "scripts/setup.sh", "--dry-run",
        env_file=env_file(tmp_path, [f"{k}={v}" for k, v in FAKE.items()]),
        extra={"SHIPGATE_CONFIG": str(bad)},
    )  # fmt: skip
    assert r.returncode == 2 and "target.repo" in r.stderr


def test_unknown_flag_exits_2() -> None:
    assert run("scripts/setup.sh", "--nope").returncode == 2


def all_keys(tmp_path: Path, keys: dict[str, str] = FAKE) -> Path:
    return env_file(tmp_path, [f"{k}={v}" for k, v in keys.items()])


def test_jira_section_checks_its_keys_and_plans_the_token_check(tmp_path: Path) -> None:
    r = run("scripts/setup.sh", "--dry-run", env_file=all_keys(tmp_path))
    assert r.returncode == 0, r.stderr
    out = r.stdout + r.stderr
    assert "JIRA_EMAIL, JIRA_API_KEY (values not shown)" in out and "project KAN" in out
    assert "would check that the Jira token reads developertunnel.atlassian.net" in out
    assert all(v not in out for v in FAKE.values())


def test_jira_section_with_an_empty_jira_key_is_a_usage_error(tmp_path: Path) -> None:
    r = run("scripts/setup.sh", "--dry-run", env_file=all_keys(tmp_path, {**FAKE, "JIRA_API_KEY": ""}))
    assert r.returncode == 2 and "JIRA_API_KEY is empty" in r.stderr and "jira: section" in r.stderr
    r = run("scripts/setup.sh", "--dry-run", env_file=all_keys(tmp_path, GITHUB_ONLY))
    assert r.returncode == 2 and "JIRA_EMAIL is empty" in r.stderr


def test_no_jira_section_needs_no_jira_keys(tmp_path: Path) -> None:
    r = run(
        "scripts/setup.sh", "--dry-run",
        env_file=all_keys(tmp_path, GITHUB_ONLY), extra={"SHIPGATE_CONFIG": str(NO_JIRA)},
    )  # fmt: skip
    assert r.returncode == 0, r.stderr
    assert "Jira" not in r.stdout + r.stderr


@pytest.mark.parametrize(("arg", "label"), [("KAN-4", "on KAN-4"), ("1", "on #1")])
def test_smoke_takes_an_issue_number_or_a_jira_key(tmp_path: Path, arg: str, label: str) -> None:
    r = run("scripts/setup.sh", "--dry-run", "--smoke", arg, env_file=all_keys(tmp_path))
    assert r.returncode == 0, r.stderr
    assert f"a triage smoke call {label}" in r.stdout


@pytest.mark.parametrize("arg", ["kan-4", "KAN4", "1a", "", "KAN-4 x", "K-4"])
def test_smoke_rejects_anything_else(tmp_path: Path, arg: str) -> None:
    r = run("scripts/setup.sh", "--dry-run", "--smoke", arg, env_file=all_keys(tmp_path))
    assert r.returncode == 2 and "--smoke needs an issue number or a Jira key" in r.stderr


def test_smoke_jira_key_needs_the_jira_section_and_its_project(tmp_path: Path) -> None:
    r = run(
        "scripts/setup.sh", "--dry-run", "--smoke", "KAN-4",
        env_file=all_keys(tmp_path, GITHUB_ONLY), extra={"SHIPGATE_CONFIG": str(NO_JIRA)},
    )  # fmt: skip
    assert r.returncode == 2 and "needs a jira: section" in r.stderr
    r = run("scripts/setup.sh", "--dry-run", "--smoke", "OPS-4", env_file=all_keys(tmp_path))
    assert r.returncode == 2 and "not a ticket of the configured Jira project KAN" in r.stderr


def test_stop_with_nothing_started(tmp_path: Path) -> None:
    r = run("scripts/stop.sh", extra={"SHIPGATE_PID_DIR": str(tmp_path / "pids")})
    assert r.returncode == 0 and "nothing to stop" in r.stdout
