"""Triage MCP server (spec docs/superpowers/specs/2026-09-26-jev-triage-design.md).

One read-only tool, triage_ticket(issue_number): read the issue from vishnuverse/humanize, ask TypeSafe Jev
three questions, apply policy triage-v1, append an audit line, return the verdict. It never raises to the
agent: every failure is an `error` verdict with patch_allowed false (fail closed).

Run: uv run mcp/triage/server.py   -> http://127.0.0.1:8803/mcp (streamable HTTP). Keys come from the
environment or the repo's .env (TYPESAFE_API_KEY, optional GITHUB_PAT for reads) and never leave this process.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import github
import httpx
import jev
import policy
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

ROOT = Path(__file__).resolve().parents[2]
AUDIT_LOG = ROOT / "runs" / "triage.jsonl"
HOST, PORT = "127.0.0.1", 8803
AUDIT_KEYS = (
    "issue",
    "policy",
    "model",
    "probabilities",
    "in_scope",
    "ai_instructions",
    "route",
    "patch_allowed",
    "reasons",
    "error",
)


def read_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key.isidentifier():
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key] = value
    return out


def load_env(dotenv: Path, environ: Mapping[str, str]) -> dict[str, str]:
    """The process environment wins over .env."""
    return {**read_dotenv(dotenv), **dict(environ)}


def _audit(path: Path, verdict: dict[str, Any], latency_ms: int) -> None:
    entry = {"ts": datetime.now(UTC).isoformat(timespec="seconds")}
    entry |= {k: verdict.get(k) for k in AUDIT_KEYS}
    entry["latency_ms"] = latency_ms
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass  # the audit log must never cost a verdict; the session events still hold it


def triage(
    issue_number: int, *, client: httpx.Client, env: Mapping[str, str], audit_log: Path
) -> dict[str, Any]:
    start = time.monotonic()
    if issue_number < 1:
        verdict = policy.error_verdict(issue_number, "issue_number must be >= 1")
    else:
        try:
            issue = github.fetch_issue(issue_number, token=env.get("GITHUB_PAT") or None, client=client)
            answers, model = jev.ask(
                issue["title"], issue["body"], api_key=env.get("TYPESAFE_API_KEY") or None, client=client
            )
            verdict = policy.decide(issue_number, answers, model)
        except (github.IssueError, jev.JevError, policy.AnswerError) as exc:
            verdict = policy.error_verdict(issue_number, str(exc))
        except Exception as exc:  # noqa: BLE001 - fail closed on anything unexpected
            verdict = policy.error_verdict(issue_number, f"internal error ({type(exc).__name__})")
    _audit(Path(audit_log), verdict, round((time.monotonic() - start) * 1000))
    return verdict


def build_app(
    *, client: httpx.Client | None = None, env: Mapping[str, str] | None = None, audit_log: Path = AUDIT_LOG
) -> FastMCP:
    app = FastMCP("triage", host=HOST, port=PORT, streamable_http_path="/mcp")
    http = client if client is not None else httpx.Client()
    cfg = env if env is not None else load_env(ROOT / ".env", os.environ)

    @app.tool(
        annotations=ToolAnnotations(
            title="Triage a humanize ticket",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=True,
        )
    )
    def triage_ticket(issue_number: int) -> dict[str, Any]:
        """Classify issue <issue_number> of vishnuverse/humanize with TypeSafe Jev under policy triage-v1.

        Returns route, patch_allowed and card_line. Copy card_line verbatim into the evidence card. Read-only.
        """
        return triage(issue_number, client=http, env=cfg, audit_log=audit_log)

    return app


if __name__ == "__main__":
    build_app().run(transport="streamable-http")
