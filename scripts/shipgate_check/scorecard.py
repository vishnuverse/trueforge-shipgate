"""`check.py --all`: scenario table + self-assessed scorecard (SPEC §4.7)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from statistics import mean
from typing import Any

from .checks import FAIL, PASS, SKIP, CheckResult, fail, ok, skip
from .constants import CRITERIA_POINTS, S5_SCENARIOS, S6_SCENARIOS
from .scenario import Scenario


@dataclass
class ScenarioResult:
    scenario: Scenario
    run_path: Path | None
    checks: list[CheckResult] = field(default_factory=list)
    support: dict[str, Any] = field(default_factory=dict)

    @property
    def has_run(self) -> bool:
        return self.run_path is not None

    @property
    def result(self) -> str:
        if not self.has_run:
            return "NO RUN"
        return FAIL if any(c.status == FAIL for c in self.checks) else PASS

    @property
    def failing(self) -> list[str]:
        return [c.id for c in self.checks if c.status == FAIL]

    def counts(self) -> tuple[int, int, int]:
        return tuple(sum(c.status == s for c in self.checks) for s in (PASS, FAIL, SKIP))  # type: ignore[return-value]

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.scenario.id,
            "title": self.scenario.title,
            "must_pass": self.scenario.must_pass,
            "result": self.result,
            "run": str(self.run_path) if self.run_path else None,
            "failing": self.failing,
            "checks": [c.as_dict() for c in self.checks],
            "support": self.support,
        }


@dataclass
class Criterion:
    key: str
    name: str
    max_points: int
    points: float | None  # None = manual
    checks: list[CheckResult] = field(default_factory=list)
    note: str = ""
    manual: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "name": self.name,
            "max_points": self.max_points,
            "points": self.points,
            "checks": [c.as_dict() for c in self.checks],
            "note": self.note,
            "manual": self.manual,
        }


def aggregate(results: list[ScenarioResult], check_id: str) -> CheckResult:
    """A per-run check passes overall iff it passes in >= 1 run and fails in none (SKIPs ignored)."""
    seen = [(r.scenario.id, c) for r in results if r.has_run for c in r.checks if c.id == check_id]
    fails = [sid for sid, c in seen if c.status == FAIL]
    passes = [sid for sid, c in seen if c.status == PASS]
    if fails:
        return fail(check_id, "fails in " + ", ".join(fails))
    if passes:
        return ok(check_id, f"passes in {len(passes)} run(s)")
    return skip(check_id, "no applicable run")


def scenario_group(
    results: list[ScenarioResult], ids: tuple[str, ...], check_id: str, what: str
) -> CheckResult:
    by_id = {r.scenario.id: r for r in results}
    states = {sid: (by_id[sid].result if sid in by_id else "MISSING") for sid in ids}
    detail = ", ".join(f"{sid} {st}" for sid, st in states.items())
    if all(st == PASS for st in states.values()):
        return ok(check_id, f"{what}: {detail}")
    if any(st == FAIL for st in states.values()):
        return fail(check_id, f"{what}: {detail}")
    return skip(check_id, f"{what}: {detail}")


def _points(weight: int, checks: list[CheckResult]) -> float:
    if not checks:
        return 0.0
    return round(weight * sum(c.status == PASS for c in checks) / len(checks), 1)


def support_summary(results: list[ScenarioResult]) -> dict[str, Any]:
    runs = [r.support for r in results if r.has_run]

    def avg(key: str) -> float | None:
        vals = [s[key] for s in runs if isinstance(s.get(key), (int, float))]
        return round(mean(vals), 1) if vals else None

    return {
        "runs": len(runs),
        "minutes_per_ticket": avg("minutes"),
        "tokens_per_ticket": avg("tokens"),
        "lines_changed_per_ticket": avg("lines_changed"),
        "human_decisions_per_ticket": avg("decisions"),
    }


def build_scorecard(results: list[ScenarioResult], global_checks: dict[str, CheckResult]) -> dict[str, Any]:
    harness_checks = [aggregate(results, cid) for cid in ("H1", "H2", "H3", "H4")]
    must = [r for r in results if r.scenario.must_pass]
    must_passed = [r for r in must if r.result == PASS]
    runs_points = round(CRITERIA_POINTS["runs"] * len(must_passed) / len(must), 1) if must else 0.0
    stops_checks = [
        global_checks.get("S1") or skip("S1", "not evaluated"),
        global_checks.get("S2") or skip("S2", "not evaluated"),
        aggregate(results, "S3"),
        aggregate(results, "S4"),
        scenario_group(results, S5_SCENARIOS, "S5", "push-back scenarios"),
        scenario_group(results, S6_SCENARIOS, "S6", "HITL scenarios"),
        aggregate(results, "S7"),
    ]
    support = support_summary(results)
    criteria = [
        Criterion(
            "harness",
            "Harness doing the work",
            CRITERIA_POINTS["harness"],
            _points(CRITERIA_POINTS["harness"], harness_checks),
            harness_checks,
        ),
        Criterion(
            "runs",
            "It actually runs",
            CRITERIA_POINTS["runs"],
            runs_points,
            note=f"{len(must_passed)}/{len(must)} must-pass scenarios pass"
            + (
                f" ({', '.join(r.scenario.id for r in must if r.result != PASS)} not yet)"
                if must_passed != must
                else ""
            ),
            manual=["Fresh-laptop README run"],
        ),
        Criterion(
            "stops",
            "Where it stops",
            CRITERIA_POINTS["stops"],
            _points(CRITERIA_POINTS["stops"], stops_checks),
            stops_checks,
        ),
        Criterion(
            "job",
            "A job worth handing over",
            CRITERIA_POINTS["job"],
            None,
            note=_support_line(support),
            manual=["A real person would delegate this chore"],
        ),
        Criterion(
            "demo",
            "Demo clarity",
            CRITERIA_POINTS["demo"],
            None,
            manual=["5-minute script rehearsed", "Architecture slide", "Every teammate can explain it"],
        ),
    ]
    auto = [c for c in criteria if c.points is not None]
    return {
        "self_assessment": True,
        "criteria": [c.as_dict() for c in criteria],
        "auto_points": round(sum(c.points for c in auto), 1),
        "auto_max": sum(c.max_points for c in auto),
        "manual_max": sum(c.max_points for c in criteria if c.points is None),
        "support": support,
    }


def _fmt(value: Any, unit: str = "") -> str:
    if value is None:
        return "n/a"
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return f"{value}{unit}"


def _support_line(s: dict[str, Any]) -> str:
    if not s["runs"]:
        return "support: no runs yet"
    return (
        f"support (avg over {s['runs']} run(s)): {_fmt(s['minutes_per_ticket'], ' min')}, "
        f"{_fmt(s['tokens_per_ticket'])} tokens, {_fmt(s['lines_changed_per_ticket'])} lines changed, "
        f"{_fmt(s['human_decisions_per_ticket'])} human decision(s) per ticket"
    )


def render_table(results: list[ScenarioResult]) -> list[str]:
    head = (
        f"{'ID':<6} {'must':<4} {'result':<7} {'P/F/S':<9} "
        + f"{'min':>5} {'tokens':>8} {'dec':>3}  failing checks"
    )
    lines = [head, "-" * len(head)]
    for r in results:
        if r.has_run:
            p, f, s = r.counts()
            sup = r.support
            lines.append(
                f"{r.scenario.id:<6} {'yes' if r.scenario.must_pass else 'no':<4} {r.result:<7} "
                f"{f'{p}/{f}/{s}':<9} {_fmt(sup.get('minutes')):>5} {_fmt(sup.get('tokens')):>8} "
                f"{_fmt(sup.get('decisions')):>3}  {', '.join(r.failing) or '-'}"
            )
        else:
            lines.append(
                f"{r.scenario.id:<6} {'yes' if r.scenario.must_pass else 'no':<4} {r.result:<7} "
                f"{'-':<9} {'-':>5} {'-':>8} {'-':>3}  -"
            )
    return lines


def render_scorecard(card: dict[str, Any]) -> list[str]:
    lines = ["SCORECARD  (self-assessment against SPEC §4.7, not the judges' score)"]
    pad = " " * 47
    for c in card["criteria"]:
        pts = (
            f"{_fmt(c['points'])}/{c['max_points']}"
            if c["points"] is not None
            else f"manual/{c['max_points']}"
        )
        label = f"{c['name']} ({c['max_points']})"
        rest = [", ".join(f"{k['id']} {k['status']}" for k in c["checks"]), c["note"]]
        rest = [r for r in rest if r] + [f"[ ] {m}" for m in c["manual"]]
        lines.append(f"  {label:<30} {pts:>12}  {rest[0] if rest else ''}".rstrip())
        lines.extend(pad + r for r in rest[1:])
    lines.append(
        f"  {'Automated subtotal':<30} {_fmt(card['auto_points']) + '/' + str(card['auto_max']):>12}"
        f"  (+ up to {card['manual_max']} manual points)"
    )
    return lines
