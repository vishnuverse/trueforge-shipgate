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
