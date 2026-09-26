"""Scenario files `tests/scenarios/<ID>.yaml` (docs/contracts.md §4).

A scenario names exactly one ticket: `issue: <n>` (a GitHub issue on the target repo, agent
ticket-resolver) or `ticket: <KEY>` (a Jira ticket in the shipgate.yaml jira: project, agent
ticket-resolver-jira)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from shipgate_config import ticket_names

from .constants import AGENT_NAME, DECISIONS, FULL_REPO, GATED_TOOLS, JIRA, JIRA_AGENT, TESTS_DIR

ID_RE = re.compile(r"^[A-Z]{2}-[A-Z]?\d{2}$")  # TR-01, TR-J01

# Keys check.py understands under `expect` (unknown keys are an error, to catch typos).
EXPECT_KEYS = {
    "status",  # str or list of str: handoff status
    "outcome",  # str or list of str: handoff outcome
    "label",  # str or list of str: the single managed label on the issue (GitHub) / ticket (Jira) afterwards
    "ticket_status",  # str or list of str: the Jira ticket's status afterwards (Jira scenarios only)
    "gates",  # ordered tools TrueForge paused on
    "pr",  # {count, head, title_prefix, files, files_match, body_contains, max_src_changes}
    "comments",  # {count, equals, contains, matches, max_words}
    "branch",  # "none": fix/issue-<n> (fix/<key> for Jira) must not exist / not be created
    "attempts",  # len(handoff.attempts)
    "pushbacks",  # list of `against` values
    "repro",  # {field: regex} against handoff.repro
    "no_retry_after_stop",  # true: no gated call after a STOP answer
    "rerequest_same_args",  # true: re-request after REVISE has the same args hash; false: it differs
    "revision_cap",  # int: max REVISE/EDIT per gate; the next one stops the agent
    "main_unchanged",  # true: main has no new commit / no write targets main
    "no_existing_test_modified",  # true: only tests/test_issue_<n>.py (tests/test_<key>.py) under tests/
    "other_issues_untouched",  # true: no comment/close on the other fixture issues (Jira: on any of #1-#7)
    "final_message",  # {matches: [regex]} against the final message
    "triage",  # {route, patch_allowed, ai_instructions}: the triage_ticket / triage_jira_ticket verdict
}
PR_KEYS = {"count", "head", "title_prefix", "files", "files_match", "body_contains", "max_src_changes"}
COMMENT_KEYS = {"count", "equals", "contains", "matches", "max_words"}
TRIAGE_KEYS = {"route", "patch_allowed", "ai_instructions"}


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
    issue: int | None  # GitHub issue number; None for a Jira scenario
    reset: bool
    timeout_min: int
    must_pass: bool
    approvals: list[Approval]
    expect: dict[str, Any]
    depends_on: str | None = None
    path: Path | None = None
    raw: dict[str, Any] = field(default_factory=dict)
    ticket: str | None = None  # Jira key (e.g. KAN-4); None for a GitHub scenario

    @property
    def source(self) -> str:
        return "jira" if self.ticket else "github"

    @property
    def agent(self) -> str:
        return JIRA_AGENT if self.ticket else AGENT_NAME

    @property
    def ref(self) -> str:
        """How the agent names the ticket: handoff `ticket` and the evidence card header (gh#1, KAN-4)."""
        return self.ticket or f"gh#{self.issue}"

    @property
    def plan_ref(self) -> str:
        """Field 2 of `check.py --plan`: the issue number or the Jira key."""
        return self.ticket or str(self.issue)

    @property
    def label(self) -> str:
        return f"Jira {self.ticket}" if self.ticket else f"issue #{self.issue}"

    @property
    def branch(self) -> str:
        if self.ticket:
            return ticket_names(self.ticket, TESTS_DIR)["branch"]
        return f"fix/issue-{self.issue}"

    @property
    def test_file(self) -> str:
        """The regression test the agent adds (the only file it may add under the tests dir)."""
        if self.ticket:
            return ticket_names(self.ticket, TESTS_DIR)["test_file"]
        return f"{TESTS_DIR}/test_issue_{self.issue}.py"

    @property
    def test_stem(self) -> str:
        return Path(self.test_file).stem


def _fail(path: Path, msg: str) -> ScenarioError:
    return ScenarioError(f"{path.name}: {msg}")


DEMO_FORKS_FILE = "demo-forks.txt"


def demo_forks(scenarios_dir: Path) -> set[str]:
    """Forks that carry the planted fixtures (#1-#7), lowercased.

    Scored scenarios and reset.sh run only on these."""
    try:
        lines = (Path(scenarios_dir) / DEMO_FORKS_FILE).read_text(encoding="utf-8").splitlines()
    except OSError:
        return set()
    return {ln.strip().lower() for ln in lines if ln.strip() and not ln.strip().startswith("#")}


def load_scenario(path: Path) -> Scenario:
    path = Path(path)
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise _fail(path, f"invalid YAML: {exc}") from exc
    if not isinstance(data, dict):
        raise _fail(path, "top level must be a mapping")
    for key in ("id", "title", "reset", "timeout_min", "must_pass", "approvals", "expect"):
        if key not in data:
            raise _fail(path, f"missing key {key!r}")
    sid = data["id"]
    if not isinstance(sid, str) or not ID_RE.match(sid) or path.stem != sid:
        raise _fail(path, f"id {sid!r} must match the file name")
    if ("issue" in data) == ("ticket" in data):
        raise _fail(path, "give exactly one of issue: <n> (GitHub) or ticket: <KEY> (Jira)")
    issue, ticket = data.get("issue"), data.get("ticket")
    if "issue" in data and (not isinstance(issue, int) or isinstance(issue, bool) or issue < 1):
        raise _fail(path, "issue must be a positive integer")
    if "ticket" in data:
        if JIRA is None:
            raise _fail(path, "a ticket scenario needs the jira: section in shipgate.yaml")
        if not isinstance(ticket, str) or not JIRA.key_re().match(ticket):
            raise _fail(path, f"ticket {ticket!r} must be a {JIRA.project}-<n> key")
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
    if isinstance(expect.get("triage"), dict) and set(expect["triage"]) - TRIAGE_KEYS:
        raise _fail(path, f"unknown expect.triage keys: {sorted(set(expect['triage']) - TRIAGE_KEYS)}")
    if "ticket_status" in expect:
        want = expect["ticket_status"]
        if ticket is None:
            raise _fail(path, "expect.ticket_status needs a ticket: (Jira) scenario")
        if not (isinstance(want, str) or (isinstance(want, list) and all(isinstance(w, str) for w in want))):
            raise _fail(path, "expect.ticket_status must be a status name or a list of them")
    depends_on = data.get("depends_on")
    if depends_on is not None and (not isinstance(depends_on, str) or not ID_RE.match(depends_on)):
        raise _fail(path, "depends_on must be a scenario ID")
    if FULL_REPO.lower() not in demo_forks(path.parent):
        raise _fail(
            path,
            f"the configured target {FULL_REPO!r} is not a demo fork listed in {DEMO_FORKS_FILE}; "
            "scored scenarios run only on a fork that carries the planted fixtures",
        )
    return Scenario(
        id=sid,
        title=str(data["title"]),
        issue=issue if ticket is None else None,
        reset=data["reset"],
        timeout_min=data["timeout_min"],
        must_pass=data["must_pass"],
        approvals=approvals,
        expect=expect,
        depends_on=depends_on,
        path=path,
        raw=data,
        ticket=ticket,
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
