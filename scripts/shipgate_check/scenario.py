"""Scenario files `tests/scenarios/<ID>.yaml` (docs/contracts.md §4)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .constants import DECISIONS, GATED_TOOLS

ID_RE = re.compile(r"^[A-Z]{2}-\d{2}$")

# Keys check.py understands under `expect` (unknown keys are an error, to catch typos).
EXPECT_KEYS = {
    "status",  # str or list of str: handoff status
    "outcome",  # handoff outcome
    "label",  # the single managed label on the issue afterwards (GitHub)
    "gates",  # ordered tools TrueForge paused on
    "pr",  # {count, head, title_prefix, files, files_match, body_contains, max_src_changes}
    "comments",  # {count, equals, contains, matches, max_words}
    "branch",  # "none": fix/issue-<n> must not exist / not be created
    "attempts",  # len(handoff.attempts)
    "pushbacks",  # list of `against` values
    "repro",  # {field: regex} against handoff.repro
    "no_retry_after_stop",  # true: no gated call after a STOP answer
    "rerequest_same_args",  # true: re-request after REVISE has the same args hash; false: it differs
    "revision_cap",  # int: max REVISE/EDIT per gate; the next one stops the agent
    "main_unchanged",  # true: main has no new commit / no write targets main
    "no_existing_test_modified",  # true: only tests/test_issue_<n>.py under tests/
    "other_issues_untouched",  # true: no comment/close on the other fixture issues
    "final_message",  # {matches: [regex]} against the final message
}
PR_KEYS = {"count", "head", "title_prefix", "files", "files_match", "body_contains", "max_src_changes"}
COMMENT_KEYS = {"count", "equals", "contains", "matches", "max_words"}


class ScenarioError(ValueError):
    pass


@dataclass
class Approval:
    tool: str
    decision: str
    reason: str | None = None


@dataclass
class Scenario:
    id: str
    title: str
    issue: int
    reset: bool
    timeout_min: int
    must_pass: bool
    approvals: list[Approval]
    expect: dict[str, Any]
    depends_on: str | None = None
    path: Path | None = None
    raw: dict[str, Any] = field(default_factory=dict)


def _fail(path: Path, msg: str) -> ScenarioError:
    return ScenarioError(f"{path.name}: {msg}")


def load_scenario(path: Path) -> Scenario:
    path = Path(path)
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise _fail(path, f"invalid YAML: {exc}") from exc
    if not isinstance(data, dict):
        raise _fail(path, "top level must be a mapping")
    for key in ("id", "title", "issue", "reset", "timeout_min", "must_pass", "approvals", "expect"):
        if key not in data:
            raise _fail(path, f"missing key {key!r}")
    sid = data["id"]
    if not isinstance(sid, str) or not ID_RE.match(sid) or path.stem != sid:
        raise _fail(path, f"id {sid!r} must match the file name")
    issue = data["issue"]
    if not isinstance(issue, int) or isinstance(issue, bool) or issue < 1:
        raise _fail(path, "issue must be a positive integer")
    for key in ("reset", "must_pass"):
        if not isinstance(data[key], bool):
            raise _fail(path, f"{key} must be true or false")
    if not isinstance(data["timeout_min"], int) or data["timeout_min"] < 1:
        raise _fail(path, "timeout_min must be a positive integer")
    approvals = []
    if not isinstance(data["approvals"], list):
        raise _fail(path, "approvals must be a list")
    for i, a in enumerate(data["approvals"]):
        if not isinstance(a, dict):
            raise _fail(path, f"approvals[{i}] must be a mapping")
        tool, decision, reason = a.get("tool"), a.get("decision"), a.get("reason")
        if tool not in GATED_TOOLS:
            raise _fail(path, f"approvals[{i}].tool {tool!r} is not a gated tool")
        if decision not in DECISIONS:
            raise _fail(path, f"approvals[{i}].decision must be allow or deny")
        if decision == "deny" and not isinstance(reason, str):
            raise _fail(path, f"approvals[{i}]: a deny needs a reason")
        approvals.append(Approval(tool=tool, decision=decision, reason=reason))
    expect = data["expect"]
    if not isinstance(expect, dict):
        raise _fail(path, "expect must be a mapping")
    unknown = set(expect) - EXPECT_KEYS
    if unknown:
        raise _fail(path, f"unknown expect keys: {sorted(unknown)}")
    if isinstance(expect.get("pr"), dict) and set(expect["pr"]) - PR_KEYS:
        raise _fail(path, f"unknown expect.pr keys: {sorted(set(expect['pr']) - PR_KEYS)}")
    if isinstance(expect.get("comments"), dict) and set(expect["comments"]) - COMMENT_KEYS:
        raise _fail(path, f"unknown expect.comments keys: {sorted(set(expect['comments']) - COMMENT_KEYS)}")
    depends_on = data.get("depends_on")
    if depends_on is not None and (not isinstance(depends_on, str) or not ID_RE.match(depends_on)):
        raise _fail(path, "depends_on must be a scenario ID")
    return Scenario(
        id=sid,
        title=str(data["title"]),
        issue=issue,
        reset=data["reset"],
        timeout_min=data["timeout_min"],
        must_pass=data["must_pass"],
        approvals=approvals,
        expect=expect,
        depends_on=depends_on,
        path=path,
        raw=data,
    )


def load_all(scenarios_dir: Path) -> list[Scenario]:
    return [load_scenario(p) for p in sorted(Path(scenarios_dir).glob("*.yaml"))]


def run_order(scenarios: list[Scenario]) -> list[Scenario]:
    """Sorted by ID, but a scenario with `depends_on` runs right after its dependency (TR-09 after TR-01),
    before any later reset can wipe the state it needs."""
    by_id = {s.id: s for s in scenarios}
    dependents: dict[str, list[Scenario]] = {}
    roots = []
    for s in sorted(scenarios, key=lambda s: s.id):
        if s.depends_on and s.depends_on in by_id:
            dependents.setdefault(s.depends_on, []).append(s)
        else:
            roots.append(s)
    out: list[Scenario] = []

    def visit(s: Scenario) -> None:
        out.append(s)
        for d in dependents.get(s.id, []):
            visit(d)

    for s in roots:
        visit(s)
    return out
