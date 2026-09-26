"""The agent spec and skill carry the triage contract (spec 2026-09-26-jev-triage-design §6)."""

from __future__ import annotations

import json

from conftest import REPO_ROOT

SPEC = json.loads((REPO_ROOT / "agents" / "ticket-resolver.json").read_text())
SKILL = (REPO_ROOT / "skills" / "ticket-resolver" / "SKILL.md").read_text()


def test_agent_enables_triage_ungated_and_no_web_tools() -> None:
    servers = {s["name"]: s for s in SPEC["manifest"]["mcp_servers"]}
    assert servers["triage"] == {
        "name": "triage",
        "enable_tools": ["triage_ticket"],
        "require_approval_for_tools": [],
    }
    assert servers["github"]["require_approval_for_tools"] == ["create_pull_request", "add_issue_comment"]
    assert SPEC["manifest"]["config"]["web_search"] == {"enabled": False}


def test_skill_calls_triage_first_and_obeys_it() -> None:
    for needle in (
        'mcp_server "triage", tool_name "triage_ticket"',
        "<investigate_only>",
        "</investigate_only>",
        "Triage (triage-v1) : <card_line",
        "| policy_blocked |",
        "could_not_fix | policy_blocked | stopped",
    ):
        assert needle in SKILL, needle


def test_skill_never_falls_through_to_step_7_while_held() -> None:
    """Final review: 6b's "Else step 7" sent an investigate-only agent that trusted its test into the fix."""
    step6b = SKILL[SKILL.index("6b. Contract check") : SKILL.index("\n7. Fix")]
    assert "Else: in <investigate_only> mode, policy_blocked" in step6b
    step7 = SKILL[SKILL.index("\n7. Fix") : SKILL.index("\n8. Evidence check")]
    assert "If TRIAGE patch_allowed is false: never fix" in step7
    held = SKILL[SKILL.index("<investigate_only>\nApplies") : SKILL.index("</investigate_only>")]
    assert "your first test or the rewrite" in held and "k/10" in held


# ---------- ticket-resolver-jira: Jira ticket, code and PR on the GitHub target ----------

JIRA_SPEC = json.loads((REPO_ROOT / "agents" / "ticket-resolver-jira.json").read_text())
JIRA_SKILL = (REPO_ROOT / "skills" / "ticket-resolver-jira" / "SKILL.md").read_text()
# Tools the Jira agent must never have: Jira writes other than one comment, Confluence, the generic operation
# runners (they would bypass per-tool gating), and the GitHub issue tools (tickets live in Jira).
NEVER_ENABLED = {
    "transitionJiraIssue",
    "editJiraIssue",
    "createJiraIssue",
    "addGraphContext",
    "createConfluenceContent",
    "updateConfluenceContent",
    "discover",
    "search",
    "executeRead",
    "executeWrite",
    "executeDestructive",
    "issue_read",
    "list_issues",
    "add_issue_comment",
    "issue_write",
    "merge_pull_request",
}
# Every enabled tool that writes somewhere people see must be gated by name. create_branch / push_files to
# fix/* are the documented exception (the default branch ruleset has no bypass).
WRITES = {"create_pull_request", "addOrEditJiraIssueComment"}


def test_jira_agent_gates_every_write_by_name() -> None:
    assert JIRA_SPEC["name"] == "ticket-resolver-jira"
    assert JIRA_SPEC["requires"] == "jira"
    servers = {s["name"]: s for s in JIRA_SPEC["manifest"]["mcp_servers"]}
    assert set(servers) == {"github", "jira", "triage"}
    assert servers["github"] == {
        "name": "github",
        "enable_tools": [
            "get_file_contents",
            "list_pull_requests",
            "list_commits",
            "create_branch",
            "push_files",
            "create_pull_request",
        ],
        "require_approval_for_tools": ["create_pull_request"],
    }
    assert servers["jira"] == {
        "name": "jira",
        "enable_tools": ["getJiraIssue", "addOrEditJiraIssueComment"],
        "require_approval_for_tools": ["addOrEditJiraIssueComment"],
    }
    assert servers["triage"] == {
        "name": "triage",
        "enable_tools": ["triage_jira_ticket"],
        "require_approval_for_tools": [],
    }
    for s in servers.values():
        assert set(s["require_approval_for_tools"]) <= set(s["enable_tools"]), s["name"]
        assert WRITES & set(s["enable_tools"]) <= set(s["require_approval_for_tools"]), s["name"]
        assert not NEVER_ENABLED & set(s["enable_tools"]), s["name"]
    assert JIRA_SPEC["manifest"]["skills"] == [{"name": "ticket-resolver-jira", "preload": False}]


def test_jira_agent_shares_the_github_agents_model_and_config() -> None:
    assert JIRA_SPEC["manifest"]["model"] == SPEC["manifest"]["model"]
    assert JIRA_SPEC["manifest"]["config"] == SPEC["manifest"]["config"]
    config = JIRA_SPEC["manifest"]["config"]
    assert config["web_search"] == {"enabled": False}
    assert config["dynamic_sub_agents"] == {"enabled": False}
    assert config["ask_user_questions"] == {"enabled": False}
    assert config["sandbox"] == {"enabled": True} and config["iteration_limit"] == 90


def test_jira_skill_calls_jira_triage_and_obeys_it() -> None:
    for needle in (
        'mcp_server "triage", tool_name "triage_jira_ticket"',
        "triage_jira_ticket {ticket_key: KEY, summary: SUMMARY}",
        'getJiraIssue {cloudId: CLOUD_ID, issueIdOrKey: KEY, responseContentFormat: "markdown"}',
        "addOrEditJiraIssueComment {cloudId: CLOUD_ID, issueIdOrKey: KEY, commentBody: <reply>,",
        'contentFormat: "markdown"}',
        "<investigate_only>",
        "</investigate_only>",
        "Triage (triage-v1) : <card_line",
        "| policy_blocked |",
        "could_not_fix | policy_blocked | stopped",
        "EVIDENCE · KEY · {{repo}} @ <sha7>",
        "Fixes KEY (TICKET_URL)",
        "fix: <what now works> (KEY)",
        'head: "{{owner}}:BRANCH"',
        'ticket "KEY"',
    ):
        assert needle in JIRA_SKILL, needle
    step6b = JIRA_SKILL[JIRA_SKILL.index("6b. Contract check") : JIRA_SKILL.index("\n7. Fix")]
    assert "Else: in <investigate_only> mode, policy_blocked" in step6b
    step7 = JIRA_SKILL[JIRA_SKILL.index("\n7. Fix") : JIRA_SKILL.index("\n8. Evidence check")]
    assert "If TRIAGE patch_allowed is false: never fix" in step7
    held = JIRA_SKILL[
        JIRA_SKILL.index("<investigate_only>\nApplies") : JIRA_SKILL.index("</investigate_only>")
    ]
    assert "your first test or the rewrite" in held and "k/10" in held
    assert "addOrEditJiraIssueComment" in held and "create_pull_request" in held


def test_jira_skill_never_edits_a_comment_or_touches_github_issues() -> None:
    lines = [line for line in JIRA_SKILL.splitlines() if "commentId" in line]
    assert lines and all("never" in line.lower() for line in lines), lines
    for bad in ("issue_read", "add_issue_comment", "list_issues", "gh#", "fix/issue-", "test_issue_"):
        assert bad not in JIRA_SKILL, bad
    for tool in NEVER_ENABLED - {"issue_read", "list_issues", "add_issue_comment", "search", "discover"}:
        assert tool not in JIRA_SKILL, tool
