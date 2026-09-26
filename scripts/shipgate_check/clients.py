"""Read-only clients for GitHub (REST), Jira Cloud (REST) and TrueForge. Injectable so unit tests can fake
them.

The GitHub client only ever issues GET requests and refuses any repo other than the shipgate.yaml target; the
Jira client only ever issues GET requests to the shipgate.yaml jira: site and refuses keys outside its
project.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Protocol

import httpx

from .constants import AGENT_NAME, DEFAULT_TRUEFORGE_URL, JIRA, OWNER, REPO


class SourceError(RuntimeError):
    """A read from GitHub, Jira or TrueForge failed."""


class RefusedRepo(ValueError):
    pass


class RefusedTicket(RefusedRepo):
    """A Jira site or ticket key outside the shipgate.yaml jira: section."""


class GitHubReader(Protocol):
    def viewer_login(self) -> str: ...
    def open_pulls(self, head_branch: str) -> list[dict[str, Any]]: ...
    def pull_files(self, number: int) -> list[dict[str, Any]]: ...
    def issue(self, number: int) -> dict[str, Any]: ...
    def issue_comments(self, number: int) -> list[dict[str, Any]]: ...
    def branch_exists(self, name: str) -> bool: ...
    def main_head(self) -> dict[str, Any]: ...  # {"sha": str, "date": iso str}


class JiraReader(Protocol):
    def myself(self) -> str: ...  # the API token's accountId
    def issue(self, key: str) -> dict[str, Any]: ...  # {"key", "status": name, "labels": [str]}
    def comments(
        self, key: str
    ) -> list[dict[str, Any]]: ...  # [{"id", "author": accountId, "created", "body"}]


class TrueForgeReader(Protocol):
    def agent(self, name: str = AGENT_NAME) -> dict[str, Any] | None: ...


_NEXT = re.compile(r'<([^>]+)>;\s*rel="next"')


class GitHubClient:
    """GET-only GitHub REST client pinned to the shipgate.yaml target."""

    def __init__(
        self,
        token: str,
        owner: str = OWNER,
        repo: str = REPO,
        base_url: str = "https://api.github.com",
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if (owner.lower(), repo.lower()) != (OWNER, REPO):
            raise RefusedRepo(f"refusing {owner}/{repo}: check.py only reads {OWNER}/{REPO}")
        if not token:
            raise SourceError("GITHUB_PAT is not set (use --offline to skip GitHub checks)")
        self._prefix = f"/repos/{OWNER}/{REPO}"
        self._http = httpx.Client(
            base_url=base_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "shipgate-check",
            },
            timeout=20.0,
            transport=transport,
        )

    def _request(
        self, url: str, params: dict[str, Any] | None, allow_404: bool = False
    ) -> httpx.Response | None:
        """The only way this client talks to GitHub: a GET."""
        try:
            resp = self._http.get(url, params=params)
        except httpx.HTTPError as exc:
            raise SourceError(f"GitHub GET {url}: {exc}") from exc
        if allow_404 and resp.status_code == 404:
            return None
        if resp.status_code >= 400:
            raise SourceError(f"GitHub GET {url}: HTTP {resp.status_code}")
        return resp

    @staticmethod
    def _json(resp: httpx.Response) -> Any:
        try:
            return resp.json()
        except ValueError as exc:
            raise SourceError(f"GitHub GET {resp.request.url}: response is not JSON") from exc

    def _get(self, path: str, params: dict[str, Any] | None = None, allow_404: bool = False) -> Any:
        resp = self._request(path, params, allow_404)
        return None if resp is None else self._json(resp)

    def _get_all(self, path: str, params: dict[str, Any] | None = None) -> list[Any]:
        items: list[Any] = []
        url: str | None = path
        query: dict[str, Any] | None = dict(params or {}, per_page=100)
        while url:
            resp = self._request(url, query)
            data = self._json(resp)
            if isinstance(data, list):
                items.extend(data)
            match = _NEXT.search(resp.headers.get("link", ""))
            url, query = (match.group(1), None) if match else (None, None)
        return items

    def viewer_login(self) -> str:
        return str(self._get("/user").get("login", ""))

    def open_pulls(self, head_branch: str) -> list[dict[str, Any]]:
        return self._get_all(f"{self._prefix}/pulls", {"state": "open", "head": f"{OWNER}:{head_branch}"})

    def pull_files(self, number: int) -> list[dict[str, Any]]:
        return self._get_all(f"{self._prefix}/pulls/{int(number)}/files")

    def issue(self, number: int) -> dict[str, Any]:
        return self._get(f"{self._prefix}/issues/{int(number)}")

    def issue_comments(self, number: int) -> list[dict[str, Any]]:
        return self._get_all(f"{self._prefix}/issues/{int(number)}/comments")

    def branch_exists(self, name: str) -> bool:
        return self._get(f"{self._prefix}/branches/{name}", allow_404=True) is not None

    def main_head(self) -> dict[str, Any]:
        data = self._get(f"{self._prefix}/commits/main")
        commit = (data or {}).get("commit") or {}
        date = (commit.get("committer") or {}).get("date") or (commit.get("author") or {}).get("date")
        return {"sha": (data or {}).get("sha", ""), "date": date}


def adf_text(node: Any) -> str:
    """Plain text of an Atlassian Document Format body (the REST v3 comment body).

    Text nodes are kept; a link mark's href is appended in <> unless the text already shows it (the agent's
    markdown `[PR](https://github.com/...)` becomes text "PR" with a link mark); inline/block cards give their
    URL; mentions their text; hard breaks and block nodes a newline."""
    if isinstance(node, list):
        return "".join(adf_text(n) for n in node)
    if not isinstance(node, dict):
        return ""
    kind = node.get("type")
    attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
    if kind == "text":
        text = str(node.get("text") or "")
        for mark in node.get("marks") or []:
            if not isinstance(mark, dict) or mark.get("type") != "link":
                continue
            href = (mark.get("attrs") or {}).get("href")
            if isinstance(href, str) and href and href not in text:
                text += f" <{href}>"
        return text
    if kind == "hardBreak":
        return "\n"
    if kind in ("inlineCard", "blockCard", "embedCard"):
        return str(attrs.get("url") or "")
    if kind in ("mention", "emoji", "status"):
        return str(attrs.get("text") or "")
    inner = adf_text(node.get("content") or [])
    if kind in ("paragraph", "heading", "listItem", "codeBlock", "blockquote", "rule", "tableRow"):
        return inner + "\n"
    return inner


class JiraClient:
    """GET-only Jira Cloud REST client pinned to the shipgate.yaml jira: site and project.

    Basic auth with JIRA_EMAIL + JIRA_API_KEY (from .env via load_dotenv). Endpoints:
      GET /rest/api/3/myself                                 -> accountId (whose comments are this run's)
      GET /rest/api/2/issue/{key}?fields=status,labels       -> status.name, labels
      GET /rest/api/3/issue/{key}/comment (startAt paging)   -> author.accountId, created, body (ADF,
                                                                flattened with adf_text)
    """

    PAGE = 100

    def __init__(
        self,
        email: str,
        token: str,
        site: str | None = None,
        project: str | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if JIRA is None:
            raise SourceError("shipgate.yaml has no jira: section")
        site, project = (site or JIRA.site).lower(), project or JIRA.project
        if (site, project) != (JIRA.site, JIRA.project):
            raise RefusedTicket(f"refusing {site} {project}: check.py only reads {JIRA.site} {JIRA.project}")
        if not email or not token:
            raise SourceError("JIRA_EMAIL / JIRA_API_KEY are not set (use --offline to skip Jira checks)")
        self._key_re = JIRA.key_re()
        self._http = httpx.Client(
            base_url=f"https://{JIRA.site}",
            auth=httpx.BasicAuth(email, token),
            headers={"Accept": "application/json", "User-Agent": "shipgate-check"},
            timeout=20.0,
            transport=transport,
        )

    def _key(self, key: str) -> str:
        if not isinstance(key, str) or not self._key_re.match(key):
            raise RefusedTicket(f"refusing {key!r}: check.py only reads {JIRA.project}-<n> tickets")
        return key

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        """The only way this client talks to Jira: a GET."""
        try:
            resp = self._http.get(path, params=params)
        except httpx.HTTPError as exc:
            raise SourceError(f"Jira GET {path}: {exc}") from exc
        if resp.status_code >= 400:
            raise SourceError(f"Jira GET {path}: HTTP {resp.status_code}")
        try:
            return resp.json()
        except ValueError as exc:
            raise SourceError(f"Jira GET {path}: response is not JSON") from exc

    def myself(self) -> str:
        account = (self._get("/rest/api/3/myself") or {}).get("accountId")
        if not isinstance(account, str) or not account:
            raise SourceError("Jira GET /rest/api/3/myself: no accountId")
        return account

    def issue(self, key: str) -> dict[str, Any]:
        data = self._get(f"/rest/api/2/issue/{self._key(key)}", {"fields": "status,labels"}) or {}
        fields = data.get("fields") or {}
        labels = [lb for lb in fields.get("labels") or [] if isinstance(lb, str)]
        return {
            "key": data.get("key", key),
            "status": (fields.get("status") or {}).get("name"),
            "labels": labels,
        }

    def comments(self, key: str) -> list[dict[str, Any]]:
        path = f"/rest/api/3/issue/{self._key(key)}/comment"
        out: list[dict[str, Any]] = []
        start = 0
        for _ in range(50):
            page = self._get(path, {"startAt": start, "maxResults": self.PAGE, "orderBy": "created"}) or {}
            items = [c for c in page.get("comments") or [] if isinstance(c, dict)]
            for c in items:
                body = c.get("body")
                out.append(
                    {
                        "id": c.get("id"),
                        "author": (c.get("author") or {}).get("accountId"),
                        "created": c.get("created"),
                        "body": body if isinstance(body, str) else adf_text(body).strip(),
                    }
                )
            start += len(items)
            total = page.get("total")
            if not items or not isinstance(total, int) or start >= total:
                break
        return out


class TrueForgeClient:
    """GET-only reader for saved agents (`GET /api/v1/agents`)."""

    def __init__(self, base_url: str | None = None, transport: httpx.BaseTransport | None = None) -> None:
        self.base_url = (base_url or DEFAULT_TRUEFORGE_URL).rstrip("/")
        self._http = httpx.Client(base_url=self.base_url, timeout=10.0, transport=transport)

    def agents(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        token: str | None = None
        for _ in range(50):
            params: dict[str, Any] = {"limit": 100}
            if token:
                params["page_token"] = token
            try:
                resp = self._http.get("/api/v1/agents", params=params)
            except httpx.HTTPError as exc:
                raise SourceError(f"TrueForge unreachable at {self.base_url}: {exc}") from exc
            if resp.status_code >= 400:
                raise SourceError(f"TrueForge GET /api/v1/agents: HTTP {resp.status_code}")
            body = resp.json()
            out.extend(a for a in body.get("data") or [] if isinstance(a, dict))
            token = (body.get("pagination") or {}).get("next_page_token")
            if not token:
                break
        return out

    def agent(self, name: str = AGENT_NAME) -> dict[str, Any] | None:
        for a in self.agents():
            if a.get("name") == name:
                return a
        return None


def load_dotenv(path: Path) -> None:
    """Minimal `.env` reader: KEY=VALUE lines; never overrides variables already set."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if key and key not in os.environ:
            os.environ[key] = value
