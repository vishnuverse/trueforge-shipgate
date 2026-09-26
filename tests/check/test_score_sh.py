"""scripts/score.sh routing, offline: logging stubs for bash (reset.sh), uv, npm and curl sit first on PATH,
so nothing is reset, run or graded for real. Runs under /bin/bash (3.2 on macOS)."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from shipgate_config import ROOT

STUB = """#!/bin/sh
echo "{name} $*" >> "$SHIM_LOG"
{body}
exit 0
"""
BODIES = {
    "bash": '[ -n "$SHIM_RESET_FAIL" ] && exit 1',
    "uv": 'case "$*" in *"check.py --plan"*) printf \'%s\\n\' "$SHIM_PLAN" ;; '
    '*seed_jira.py*) [ -n "$SHIM_SEED_FAIL" ] && exit 1 ;; esac',
    "npm": "",
    "curl": "printf 200",
}
BASH = "/bin/bash" if Path("/bin/bash").exists() else "bash"


def score(tmp_path: Path, plan: str, *args: str, **flags: str) -> tuple[subprocess.CompletedProcess, list]:
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    for name, body in BODIES.items():
        stub = bindir / name
        stub.write_text(STUB.format(name=name, body=body))
        stub.chmod(0o755)
    log = tmp_path / "calls.log"
    log.write_text("")
    env = {
        "PATH": f"{bindir}:/usr/bin:/bin",
        "HOME": os.environ.get("HOME", str(tmp_path)),
        "SHIM_LOG": str(log),
        "SHIM_PLAN": plan,
        **flags,
    }
    r = subprocess.run(
        [BASH, "scripts/score.sh", *args], capture_output=True, text=True, env=env, cwd=ROOT, timeout=60
    )
    return r, log.read_text().splitlines()


def test_jira_scenario_resets_github_then_jira_and_passes_the_ticket(tmp_path: Path) -> None:
    r, calls = score(tmp_path, "TR-J01\tKAN-4\ttrue\t30", "TR-J01")
    assert r.returncode == 0, r.stderr
    assert "=== TR-J01: ticket KAN-4, reset true, timeout 30 min" in r.stdout
    assert calls == [
        "uv run python scripts/check.py --plan TR-J01",
        "curl -s -o /dev/null -m 3 -w %{http_code} http://127.0.0.1:8803/mcp",  # the triage MCP is up
        "bash scripts/reset.sh --yes",
        "uv run python scripts/seed_jira.py reset KAN-4 --yes",
        "npm --prefix orchestrator run shipgate -- run --ticket KAN-4 --approve script --scenario TR-J01 "
        "--timeout-min 30",
        "uv run python scripts/check.py TR-J01",
    ]


def test_github_scenario_is_unchanged(tmp_path: Path) -> None:
    r, calls = score(tmp_path, "TR-01\t1\ttrue\t25", "TR-01")
    assert r.returncode == 0, r.stderr
    assert "=== TR-01: issue #1, reset true, timeout 25 min" in r.stdout
    assert not any("seed_jira" in c for c in calls)
    assert "npm --prefix orchestrator run shipgate -- run --issue 1 --approve script --scenario TR-01 " \
        "--timeout-min 25" in calls  # fmt: skip


def test_jira_scenario_without_reset_touches_neither_side(tmp_path: Path) -> None:
    _, calls = score(tmp_path, "TR-J02\tKAN-7\tfalse\t20", "TR-J02")
    assert not any(c.startswith("bash ") or "seed_jira" in c for c in calls)
    assert any("run --ticket KAN-7" in c for c in calls)


def test_failed_jira_reset_skips_the_run(tmp_path: Path) -> None:
    r, calls = score(tmp_path, "TR-J01\tKAN-4\ttrue\t30", "TR-J01", SHIM_SEED_FAIL="1")
    assert r.returncode == 1 and "Jira reset of KAN-4 failed; not running TR-J01" in r.stderr
    assert not any(c.startswith("npm ") for c in calls)


def test_failed_github_reset_skips_the_jira_reset_too(tmp_path: Path) -> None:
    r, calls = score(tmp_path, "TR-J01\tKAN-4\ttrue\t30", "TR-J01", SHIM_RESET_FAIL="1")
    assert r.returncode == 1 and "reset failed; not running TR-J01" in r.stderr
    assert not any("seed_jira" in c or c.startswith("npm ") for c in calls)


def test_all_mixes_github_and_jira_scenarios(tmp_path: Path) -> None:
    r, calls = score(tmp_path, "TR-01\t1\tfalse\t25\nTR-J01\tKAN-4\tfalse\t30", "--all")
    assert r.returncode == 0, r.stderr
    runs = [c for c in calls if c.startswith("npm ")]
    assert [c.split(" run ", 2)[2].split(" --approve")[0] for c in runs] == ["--issue 1", "--ticket KAN-4"]
    assert calls[-1] == "uv run python scripts/check.py --all"
