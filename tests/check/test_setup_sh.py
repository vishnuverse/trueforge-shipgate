"""scripts/setup.sh and stop.sh (spec any-repo §4): the offline paths. Real registration is the live task."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from shipgate_config import ROOT

FAKE = {
    "GITHUB_PAT": "ghp_fake_value_1234",
    "OPENROUTER_API_KEY": "sk-or-fake-5678",
    "TYPESAFE_API_KEY": "ts-fake-9012",
}


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
    ):
        assert phrase in out, phrase
    assert all(v not in out for v in FAKE.values())
    assert not pids.exists()


def test_export_and_quoted_env_lines_count(tmp_path: Path) -> None:
    lines = [
        'export GITHUB_PAT="ghp_fake_value_1234"',
        "OPENROUTER_API_KEY='sk-or-fake-5678'",
        "TYPESAFE_API_KEY=ts-fake-9012",
    ]
    r = run("scripts/setup.sh", "--dry-run", env_file=env_file(tmp_path, lines))
    assert r.returncode == 0, r.stderr


def test_empty_key_is_a_usage_error_naming_the_key(tmp_path: Path) -> None:
    r = run(
        "scripts/setup.sh",
        "--dry-run",
        env_file=env_file(tmp_path, ["GITHUB_PAT=x", "OPENROUTER_API_KEY=", "TYPESAFE_API_KEY=y"]),
    )
    assert r.returncode == 2 and "OPENROUTER_API_KEY" in r.stderr


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


def test_stop_with_nothing_started(tmp_path: Path) -> None:
    r = run("scripts/stop.sh", extra={"SHIPGATE_PID_DIR": str(tmp_path / "pids")})
    assert r.returncode == 0 and "nothing to stop" in r.stdout
