"""Fixed facts the scorer grades against (docs/SPEC.md §4, docs/contracts.md)."""

from __future__ import annotations

OWNER = "vishnuverse"
REPO = "humanize"
FULL_REPO = f"{OWNER}/{REPO}"
FIXTURE_ISSUES = tuple(range(1, 8))  # #1-#7 (SPEC §4.6)

AGENT_NAME = "ticket-resolver"
GITHUB_SERVER = "github"
DEFAULT_TRUEFORGE_URL = "http://localhost:8790"

# SPEC §4.1
ENABLED_TOOLS = (
    "issue_read",
    "list_issues",
    "get_file_contents",
    "list_pull_requests",
    "list_commits",
    "create_branch",
    "push_files",
    "create_pull_request",
    "add_issue_comment",
)
GATED_TOOLS = ("create_pull_request", "add_issue_comment")
NEVER_ENABLED_TOOLS = (
    "merge_pull_request",
    "issue_write",
    "delete_file",
    "create_or_update_file",
    "update_pull_request",
)
# S2 names these two explicitly; the other never-enabled tools are still checked per run.
S2_TOOLS = ("merge_pull_request", "issue_write")

# Every tool the live GitHub MCP exposes (45, checked 2026-09-26). Used to recognise a direct
# `function.name == <mcp tool>` call as a GitHub MCP call (contracts §5).
GITHUB_MCP_TOOLS = frozenset(
    {
        "add_comment_to_pending_review",
        "add_issue_comment",
        "add_reply_to_pull_request_comment",
        "create_branch",
        "create_or_update_file",
        "create_pull_request",
        "create_repository",
        "delete_file",
        "fork_repository",
        "get_commit",
        "get_file_contents",
        "get_label",
        "get_latest_release",
        "get_me",
        "get_release_by_tag",
        "get_tag",
        "get_team_members",
        "get_teams",
        "issue_read",
        "issue_write",
        "list_branches",
        "list_commits",
        "list_issue_fields",
        "list_issue_types",
        "list_issues",
        "list_pull_requests",
        "list_releases",
        "list_repository_collaborators",
        "list_tags",
        "merge_pull_request",
        "pull_request_read",
        "pull_request_review_write",
        "push_files",
        "request_copilot_review",
        "run_secret_scanning",
        "search_code",
        "search_commits",
        "search_issues",
        "search_pull_requests",
        "search_repositories",
        "search_users",
        "sub_issue_write",
        "update_issue_comment",
        "update_pull_request",
        "update_pull_request_branch",
    }
)

# SPEC §7
STAGE = "resolve"
STATUSES = ("ok", "aborted", "failed", "noop")
OUTCOMES = (
    "fixed",
    "cannot_reproduce",
    "intermittent",
    "out_of_scope",
    "duplicate",
    "needs_info",
    "security_redirect",
    "could_not_fix",
    "stopped",
)
# Outcomes reached at the pre-checks (T3), possibly before a SHA is pinned.
PRECHECK_OUTCOMES = ("out_of_scope", "duplicate", "needs_info", "security_redirect")
PUSHBACK_AGAINST = ("ticket", "approver", "evidence")
DECISIONS = ("allow", "deny")
PREFIXES = ("APPROVE", "REVISE", "EDIT", "STOP", "NONE")

# SPEC T15 / contracts §7
MANAGED_LABELS = ("bug", "triaged", "fix-proposed", "cannot-reproduce", "needs-human")


def label_for_outcome(outcome: str) -> str:
    if outcome in ("fixed", "duplicate"):
        return "fix-proposed"
    if outcome == "cannot_reproduce":
        return "cannot-reproduce"
    if outcome == "stopped":
        return "triaged"
    return "needs-human"


# SPEC §4.7 scorecard
S5_SCENARIOS = ("TR-03", "TR-06", "TR-12", "TR-13")  # push-back
S6_SCENARIOS = ("TR-05", "TR-10", "TR-11", "TR-14")  # HITL semantics
CRITERIA_POINTS = {
    "harness": 30,
    "runs": 25,
    "stops": 20,
    "job": 15,
    "demo": 10,
}
