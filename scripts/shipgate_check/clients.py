"""Read-only clients for GitHub (REST) and TrueForge. Injectable so unit tests can fake them.

The GitHub client only ever issues GET requests and refuses any repo other than vishnuverse/humanize.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Protocol

import httpx

from .constants import AGENT_NAME, DEFAULT_TRUEFORGE_URL, OWNER, REPO


class SourceError(RuntimeError):
    """A read from GitHub or TrueForge failed."""


class RefusedRepo(ValueError):
    pass


class GitHubReader(Protocol):
    def viewer_login(self) -> str: ...
    def open_pulls(self, head_branch: str) -> list[dict[str, Any]]: ...
    def pull_files(self, number: int) -> list[dict[str, Any]]: ...
    def issue(self, number: int) -> dict[str, Any]: ...
    def issue_comments(self, number: int) -> list[dict[str, Any]]: ...
    def branch_exists(self, name: str) -> bool: ...
    def main_head(self) -> dict[str, Any]: ...  # {"sha": str, "date": iso str}


class TrueForgeReader(Protocol):
    def agent(self, name: str = AGENT_NAME) -> dict[str, Any] | None: ...


_NEXT = re.compile(r'<([^>]+)>;\s*rel="next"')


class GitHubClient:
    """GET-only GitHub REST client pinned to vishnuverse/humanize."""

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
