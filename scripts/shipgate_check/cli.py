"""check.py command line: grade one scenario's latest run, or all of them plus the scorecard."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, TextIO

from .checks import (
    FAIL,
    PASS,
    CheckResult,
    GitHubView,
    build_context,
    check_s1,
    check_s2,
    common_checks,
    fail,
    ok,
    scenario_checks,
    skip,
    support_metrics,
)
from .clients import GitHubClient, GitHubReader, SourceError, TrueForgeClient, TrueForgeReader, load_dotenv
from .constants import AGENT_NAME, FULL_REPO
from .events import Timeline
from .rundir import latest_run_path, load_run
from .scenario import Scenario, ScenarioError, load_all, load_scenario, run_order
from .scorecard import ScenarioResult, build_scorecard, render_scorecard, render_table

REPO_ROOT = Path(__file__).resolve().parents[2]


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="check.py",
        description=f"Read-only test oracle for shipgate scenarios on {FULL_REPO}.",
    )
    p.add_argument("id", nargs="?", help="scenario ID, e.g. TR-01")
    p.add_argument(
        "--all", action="store_true", help="grade every scenario that has a run, then the scorecard"
    )
    p.add_argument(
        "--offline", action="store_true", help="skip GitHub and TrueForge reads (those checks SKIP)"
    )
    p.add_argument("--json", action="store_true", help="print JSON instead of text")
    p.add_argument(
        "--plan", action="store_true", help="print 'ID issue reset timeout_min' in run order and exit"
    )
    p.add_argument("--runs-dir", type=Path, help="default: <repo>/runs")
    p.add_argument("--scenarios-dir", type=Path, help="default: <repo>/tests/scenarios")
    return p


class Sources:
    """GitHub + TrueForge access for one invocation, with their own status lines."""

    def __init__(
        self,
        offline: bool,
        github: GitHubReader | None,
        trueforge: TrueForgeReader | None,
    ) -> None:
        self.lines: list[CheckResult] = []
        self.agent: dict[str, Any] | None = None
        self.tf_unavailable: str | None = None
        if offline:
            self.gh = GitHubView(None, "offline")
            self.tf_unavailable = "offline"
            self.lines += [skip("github", "offline"), skip("trueforge", "offline")]
            return
        gh_error = None
        if github is None:
            try:
                github = GitHubClient(os.environ.get("GITHUB_PAT", ""))
            except SourceError as exc:
                gh_error = str(exc)
        if github is not None:
            try:
                login = github.viewer_login()
                self.lines.append(ok("github", f"reading {FULL_REPO} (read-only) as {login}"))
            except SourceError as exc:
                gh_error, github = str(exc), None
        if gh_error:
            self.lines.append(fail("github", gh_error))
        self.gh = GitHubView(github, f"GitHub unavailable: {gh_error}" if gh_error else None)
        if trueforge is None:
            trueforge = TrueForgeClient(os.environ.get("TRUEFORGE_URL"))
        try:
            self.agent = trueforge.agent(AGENT_NAME)
            found = "found" if self.agent else "not found"
            self.lines.append(ok("trueforge", f"reachable; saved agent {AGENT_NAME} {found}"))
        except SourceError as exc:
            self.tf_unavailable = f"TrueForge unavailable: {exc}"
            self.lines.append(fail("trueforge", str(exc)))


def grade(scenario: Scenario, runs_dir: Path, src: Sources) -> tuple[ScenarioResult, Timeline | None]:
    path = latest_run_path(runs_dir, scenario.id)
    if path is None:
        return ScenarioResult(scenario, None), None
    run = load_run(path)
    ctx = build_context(scenario, run, src.gh, runs_dir)
    checks = common_checks(ctx) + scenario_checks(ctx)
    return ScenarioResult(scenario, path, checks, support_metrics(ctx)), ctx.tl


def _print(out: TextIO, text: str = "") -> None:
    out.write(text + "\n")


def _rel(path: Path | None) -> str:
    if path is None:
        return "-"
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def cmd_plan(scenarios: list[Scenario], only: str | None, out: TextIO) -> int:
    for s in run_order(scenarios):
        if only and s.id != only:
            continue
        _print(out, f"{s.id}\t{s.issue}\t{'true' if s.reset else 'false'}\t{s.timeout_min}")
    return 0


def cmd_one(scenario: Scenario, runs_dir: Path, src: Sources, as_json: bool, out: TextIO) -> int:
    result, tl = grade(scenario, runs_dir, src)
    lines = list(src.lines)
    if not result.has_run:
        lines.append(fail("run", f"no run under {_rel(runs_dir / scenario.id)}/<UTC_TS>/"))
    else:
        lines += result.checks
        lines += [check_s1(src.agent, src.tf_unavailable), check_s2(src.agent, src.tf_unavailable, [tl])]
    failed = any(c.status == FAIL for c in lines)
    verdict = FAIL if failed else PASS
    if as_json:
        body = result.as_dict()
        body["checks"] = [c.as_dict() for c in lines]
        body["result"] = verdict
        _print(out, json.dumps(body, indent=2, ensure_ascii=False))
        return 1 if failed else 0
    _print(out, f"# {scenario.id} {scenario.title} (issue #{scenario.issue}) | run {_rel(result.run_path)}")
    for c in lines:
        _print(out, c.line())
    counts = {s: sum(c.status == s for c in lines) for s in ("PASS", "FAIL", "SKIP")}
    _print(
        out,
        f"# RESULT {scenario.id} {verdict} "
        f"({counts['PASS']} passed, {counts['FAIL']} failed, {counts['SKIP']} skipped)",
    )
    return 1 if failed else 0


def cmd_all(scenarios: list[Scenario], runs_dir: Path, src: Sources, as_json: bool, out: TextIO) -> int:
    results: list[ScenarioResult] = []
    timelines: list[Timeline] = []
    for s in run_order(scenarios):
        res, tl = grade(s, runs_dir, src)
        results.append(res)
        if tl is not None:
            timelines.append(tl)
    global_checks = {
        "S1": check_s1(src.agent, src.tf_unavailable),
        "S2": check_s2(src.agent, src.tf_unavailable, timelines),
    }
    card = build_scorecard(results, global_checks)
    source_fail = any(c.status == FAIL for c in src.lines)
    failed = (
        source_fail
        or any(r.result == FAIL for r in results)
        or any(c.status == FAIL for c in global_checks.values())
    )
    if as_json:
        body = {
            "sources": [c.as_dict() for c in src.lines],
            "scenarios": [r.as_dict() for r in results],
            "global_checks": [c.as_dict() for c in global_checks.values()],
            "scorecard": card,
        }
        _print(out, json.dumps(body, indent=2, ensure_ascii=False))
        return 1 if failed else 0
    for c in src.lines:
        _print(out, c.line())
    ran = sum(r.has_run for r in results)
    _print(out, f"# {ran}/{len(results)} scenario(s) have a run under {_rel(runs_dir)}/")
    if not ran:
        _print(out, "# no runs yet: run scripts/score.sh <ID> first; the scorecard below is all zeros")
    _print(out)
    for line in render_table(results):
        _print(out, line)
    failing = [(r.scenario.id, c) for r in results for c in r.checks if c.status == FAIL]
    if failing:
        _print(out)
        for sid, c in failing:
            _print(out, c.line(prefix=f"{sid}:"))
    _print(out)
    for c in global_checks.values():
        _print(out, c.line())
    _print(out)
    for line in render_scorecard(card):
        _print(out, line)
    return 1 if failed else 0


def main(
    argv: list[str] | None = None,
    *,
    github: GitHubReader | None = None,
    trueforge: TrueForgeReader | None = None,
    root: Path | None = None,
    out: TextIO | None = None,
) -> int:
    out = out or sys.stdout
    args = _parser().parse_args(argv)
    root = root or REPO_ROOT
    load_dotenv(root / ".env")
    runs_dir = args.runs_dir or root / "runs"
    scenarios_dir = args.scenarios_dir or root / "tests" / "scenarios"
    if bool(args.id) == bool(args.all) and not args.plan:
        _parser().print_usage(sys.stderr)
        print("check.py: give one scenario ID or --all", file=sys.stderr)
        return 2
    try:
        if args.id:
            path = scenarios_dir / f"{args.id}.yaml"
            if not path.exists():
                print(f"check.py: no scenario file {path}", file=sys.stderr)
                return 2
            scenarios = [load_scenario(path)]
            if args.plan:
                return cmd_plan(load_all(scenarios_dir), args.id, out)
        else:
            scenarios = load_all(scenarios_dir)
            if args.plan:
                return cmd_plan(scenarios, None, out)
    except ScenarioError as exc:
        print(f"check.py: {exc}", file=sys.stderr)
        return 2
    src = Sources(args.offline, github, trueforge)
    if args.all:
        return cmd_all(scenarios, runs_dir, src, args.json, out)
    return cmd_one(scenarios[0], runs_dir, src, args.json, out)
