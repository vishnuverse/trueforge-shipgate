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
    SKIP,
    CheckResult,
    GitHubView,
    JiraView,
    agent_name,
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
from .clients import (
    GitHubClient,
    GitHubReader,
    JiraClient,
    JiraReader,
    SourceError,
    TrueForgeClient,
    TrueForgeReader,
    load_dotenv,
)
from .constants import AGENT_NAME, FULL_REPO, JIRA
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
        "--regrade",
        action="store_true",
        help="with --all: grade against GitHub now, not the grade saved at run time",
    )
    p.add_argument(
        "--plan",
        action="store_true",
        help="print 'ID issue-or-KEY reset timeout_min' in run order and exit",
    )
    p.add_argument("--runs-dir", type=Path, help="default: <repo>/runs")
    p.add_argument("--scenarios-dir", type=Path, help="default: <repo>/tests/scenarios")
    return p


class Sources:
    """GitHub + TrueForge (+ Jira when a Jira scenario is graded) access for one invocation, with their own
    status lines. `agent_names` are the saved agents to read (the graded scenarios' agents)."""

    def __init__(
        self,
        offline: bool,
        github: GitHubReader | None,
        trueforge: TrueForgeReader | None,
        jira: JiraReader | None = None,
        agent_names: tuple[str, ...] = (AGENT_NAME,),
        need_jira: bool = False,
    ) -> None:
        self.lines: list[CheckResult] = []
        self.agents: dict[str, dict[str, Any] | None] = {}
        self.tf_unavailable: str | None = None
        self.jira = JiraView(None, "not a Jira scenario")
        if offline:
            self.gh = GitHubView(None, "offline")
            self.tf_unavailable = "offline"
            self.lines += [skip("github", "offline"), skip("trueforge", "offline")]
            if need_jira:
                self.jira = JiraView(None, "offline")
                self.lines.append(skip("jira", "offline"))
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
        if need_jira:
            self.jira = self._jira_view(jira)
        if trueforge is None:
            trueforge = TrueForgeClient(os.environ.get("TRUEFORGE_URL"))
        try:
            found = []
            for name in agent_names:
                self.agents[name] = trueforge.agent(name)
                found.append(f"saved agent {name} {'found' if self.agents[name] else 'not found'}")
            self.lines.append(ok("trueforge", "reachable; " + "; ".join(found)))
        except SourceError as exc:
            self.tf_unavailable = f"TrueForge unavailable: {exc}"
            self.lines.append(fail("trueforge", str(exc)))

    def _jira_view(self, jira: JiraReader | None) -> JiraView:
        """JIRA_EMAIL + JIRA_API_KEY come from the environment (.env is loaded by main via load_dotenv)."""
        error = None
        if jira is None:
            try:
                jira = JiraClient(os.environ.get("JIRA_EMAIL", ""), os.environ.get("JIRA_API_KEY", ""))
            except SourceError as exc:
                error = str(exc)
        if jira is not None:
            try:
                jira.myself()
                where = f"{JIRA.site} project {JIRA.project}" if JIRA else "Jira"
                self.lines.append(ok("jira", f"reading {where} (read-only)"))
            except SourceError as exc:
                error, jira = str(exc), None
        if error:
            self.lines.append(fail("jira", error))
        return JiraView(jira, f"Jira unavailable: {error}" if error else None)

    @property
    def agent(self) -> dict[str, Any] | None:
        """The GitHub agent (ticket-resolver)."""
        return self.agents.get(AGENT_NAME)

    def agent_for(self, source: str) -> dict[str, Any] | None:
        return self.agents.get(agent_name(source))


# Grade saved by `check.py <ID>` right after a run: GitHub state (PRs, comments, labels) is only true
# until the next scenario resets the fork, so `--all` reuses it unless --regrade.
SAVED_GRADE = "check.json"


def grade(
    scenario: Scenario, runs_dir: Path, src: Sources, use_saved: bool = False
) -> tuple[ScenarioResult, Timeline | None]:
    path = latest_run_path(runs_dir, scenario.id)
    if path is None:
        return ScenarioResult(scenario, None), None
    run = load_run(path)
    jira = src.jira if scenario.source == "jira" else None
    ctx = build_context(scenario, run, src.gh, runs_dir, jira)
    saved = path / SAVED_GRADE
    if use_saved and saved.exists():
        data = json.loads(saved.read_text(encoding="utf-8"))
        checks = [CheckResult.from_dict(c) for c in data.get("checks", [])]
        return ScenarioResult(scenario, path, checks, data.get("support") or support_metrics(ctx)), ctx.tl
    checks = common_checks(ctx) + scenario_checks(ctx)
    return ScenarioResult(scenario, path, checks, support_metrics(ctx)), ctx.tl


def _save_grade(result: ScenarioResult) -> None:
    if result.run_path is None:
        return
    body = {"checks": [c.as_dict() for c in result.checks], "support": result.support}
    (result.run_path / SAVED_GRADE).write_text(json.dumps(body, indent=1, ensure_ascii=False) + "\n", "utf-8")


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
        _print(out, f"{s.id}\t{s.plan_ref}\t{'true' if s.reset else 'false'}\t{s.timeout_min}")
    return 0


def cmd_one(scenario: Scenario, runs_dir: Path, src: Sources, as_json: bool, out: TextIO) -> int:
    result, tl = grade(scenario, runs_dir, src)
    if result.has_run and src.gh.available and (scenario.source != "jira" or src.jira.available):
        _save_grade(result)
    lines = list(src.lines)
    if not result.has_run:
        lines.append(fail("run", f"no run under {_rel(runs_dir / scenario.id)}/<UTC_TS>/"))
    else:
        lines += result.checks
        agent, source = src.agent_for(scenario.source), scenario.source
        lines += [
            check_s1(agent, src.tf_unavailable, source),
            check_s2(agent, src.tf_unavailable, [tl], source),
        ]
    failed = any(c.status == FAIL for c in lines)
    verdict = FAIL if failed else PASS
    if as_json:
        body = result.as_dict()
        body["checks"] = [c.as_dict() for c in lines]
        body["result"] = verdict
        _print(out, json.dumps(body, indent=2, ensure_ascii=False))
        return 1 if failed else 0
    _print(out, f"# {scenario.id} {scenario.title} ({scenario.label}) | run {_rel(result.run_path)}")
    for c in lines:
        _print(out, c.line())
    counts = {s: sum(c.status == s for c in lines) for s in ("PASS", "FAIL", "SKIP")}
    _print(
        out,
        f"# RESULT {scenario.id} {verdict} "
        f"({counts['PASS']} passed, {counts['FAIL']} failed, {counts['SKIP']} skipped)",
    )
    return 1 if failed else 0


def _merge(cid: str, checks: dict[str, CheckResult]) -> CheckResult:
    """One scorecard line for S1/S2 over both saved agents: FAIL if either fails, else SKIP if either
    skips."""
    if len(checks) == 1:
        return next(iter(checks.values()))
    statuses = {c.status for c in checks.values()}
    status = FAIL if FAIL in statuses else SKIP if SKIP in statuses else PASS
    return CheckResult(status, cid, " | ".join(f"{agent_name(k)}: {c.reason}" for k, c in checks.items()))


def cmd_all(
    scenarios: list[Scenario], runs_dir: Path, src: Sources, as_json: bool, out: TextIO, regrade: bool = False
) -> int:
    results: list[ScenarioResult] = []
    timelines: dict[str, list[Timeline]] = {"github": []}
    for s in run_order(scenarios):
        res, tl = grade(s, runs_dir, src, use_saved=not regrade)
        results.append(res)
        if tl is not None:
            timelines.setdefault(s.source, []).append(tl)
    # S1/S2 grade the GitHub agent always, the Jira agent once a Jira scenario has a run (Jira is optional).
    s1 = {kind: check_s1(src.agent_for(kind), src.tf_unavailable, kind) for kind in timelines}
    s2 = {
        kind: check_s2(src.agent_for(kind), src.tf_unavailable, tls, kind) for kind, tls in timelines.items()
    }
    global_checks = {"S1": _merge("S1", s1), "S2": _merge("S2", s2)}
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


def _needs(scenarios: list[Scenario], runs_dir: Path, grade_all: bool) -> tuple[tuple[str, ...], bool]:
    """(saved agents to read, whether Jira is read): the one scenario's agent, or for --all the GitHub agent
    plus the Jira agent once a Jira scenario has a run."""
    if not grade_all:
        return (scenarios[0].agent,), scenarios[0].source == "jira"
    jira_ran = any(s.source == "jira" and latest_run_path(runs_dir, s.id) for s in scenarios)
    return (AGENT_NAME, agent_name("jira")) if jira_ran else (AGENT_NAME,), jira_ran


def main(
    argv: list[str] | None = None,
    *,
    github: GitHubReader | None = None,
    trueforge: TrueForgeReader | None = None,
    jira: JiraReader | None = None,
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
    agent_names, need_jira = _needs(scenarios, runs_dir, args.all)
    src = Sources(args.offline, github, trueforge, jira, agent_names=agent_names, need_jira=need_jira)
    if args.all:
        return cmd_all(scenarios, runs_dir, src, args.json, out, regrade=args.regrade)
    return cmd_one(scenarios[0], runs_dir, src, args.json, out)
