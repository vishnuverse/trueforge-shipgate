"""Read one ticket of the configured Jira project for the triage MCP. Read-only.

REST v2 on purpose: it returns `description` as a plain string (wiki markup) instead of an ADF tree, so the
same Jev path as GitHub issues applies. The site comes from shipgate.yaml jira.site, never from the caller.
"""

from __future__ import annotations

import re

import httpx

TIMEOUT_S = 15.0
KEY_RE = re.compile(r"^[A-Z][A-Z0-9]+-[1-9][0-9]*$")  # the server checks the configured project first


class IssueError(RuntimeError):
    """The ticket could not be read. The message holds no secrets."""


def fetch_issue(
    key: str, *, site: str, email: str | None, token: str | None, client: httpx.Client
) -> dict[str, str]:
    if not KEY_RE.fullmatch(key):  # fullmatch: `$` alone would let "KAN-4\n" through
        raise IssueError("not a Jira issue key")
    if not email or not token:
        raise IssueError("JIRA_EMAIL / JIRA_API_KEY not set")
    try:
        r = client.get(
            f"https://{site}/rest/api/2/issue/{key}",
            params={"fields": "summary,description"},
            headers={"Accept": "application/json"},
            auth=(email, token),
            timeout=TIMEOUT_S,
        )
    except httpx.HTTPError as exc:
        raise IssueError(f"Jira transport error ({type(exc).__name__})") from exc
    if r.status_code in (401, 403):
        raise IssueError(f"Jira token rejected (HTTP {r.status_code})")
    if r.status_code == 404:
        raise IssueError(f"ticket {key} not found")
    if r.status_code != 200:
        raise IssueError(f"Jira HTTP {r.status_code}")
    try:
        data = r.json()
    except ValueError as exc:
        raise IssueError("Jira reply is not JSON") from exc
    fields = data.get("fields") if isinstance(data, dict) else None
    if not isinstance(fields, dict):
        raise IssueError("Jira reply is not an issue")
    got = data.get("key")
    if isinstance(got, str) and got != key:  # Jira answers a moved ticket under its new key
        raise IssueError(f"ticket {key} now lives at another key")
    return {"title": str(fields.get("summary") or ""), "body": str(fields.get("description") or "")}
