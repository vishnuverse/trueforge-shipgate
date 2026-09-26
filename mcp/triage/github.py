"""Read one issue of the configured target repo for the triage MCP (spec §3-4). Read-only."""

from __future__ import annotations

import httpx

API = "https://api.github.com"
TIMEOUT_S = 15.0


class IssueError(RuntimeError):
    """The issue could not be read. The message holds no secrets."""


def fetch_issue(n: int, *, repo: str, token: str | None, client: httpx.Client) -> dict[str, str]:
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        r = client.get(f"{API}/repos/{repo}/issues/{n}", headers=headers, timeout=TIMEOUT_S)
    except httpx.HTTPError as exc:
        raise IssueError(f"GitHub transport error ({type(exc).__name__})") from exc
    if r.status_code == 404:
        raise IssueError(f"issue #{n} not found")
    if r.status_code != 200:
        raise IssueError(f"GitHub HTTP {r.status_code}")
    try:
        data = r.json()
    except ValueError as exc:
        raise IssueError("GitHub reply is not JSON") from exc
    if not isinstance(data, dict):
        raise IssueError("GitHub reply is not an issue")
    if "pull_request" in data:
        raise IssueError(f"#{n} is a pull request")
    return {"title": str(data.get("title") or ""), "body": str(data.get("body") or "")}
