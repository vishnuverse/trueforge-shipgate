"""Triage MCP server (spec docs/superpowers/specs/2026-09-26-jev-triage-design.md).

Read-only tool triage_ticket(issue_number, summary): read the issue from the configured target repo
(shipgate.yaml target.repo), send TypeSafe Jev the title, the agent's short summary and the start of the body
(never the full ticket), ask three questions, apply policy triage-v1, append an audit line, return the
verdict. With a jira: section in shipgate.yaml a second tool, triage_jira_ticket(ticket_key, summary), reads
the ticket from the configured Jira site and project instead and takes the same Jev path. Neither raises to
the agent: every failure is an `error` verdict with patch_allowed false (fail closed).

Run: uv run mcp/triage/server.py   -> http://127.0.0.1:8803/mcp (streamable HTTP). Keys come from the
environment or the env file (SHIPGATE_ENV_FILE, else the repo's .env): TYPESAFE_API_KEY, optional GITHUB_PAT
for reads, JIRA_EMAIL + JIRA_API_KEY for Jira. They never leave this process.
Smoke: uv run mcp/triage/server.py --smoke 1   (or --smoke KAN-4)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import github
import httpx
import jev
import jira
import policy
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))  # shipgate_config and shipgate_env live in scripts/
from shipgate_config import Config, ConfigError, load_config  # noqa: E402
from shipgate_env import env_path, load_env  # noqa: E402

AUDIT_LOG = ROOT / "runs" / "triage.jsonl"
HOST, PORT = "127.0.0.1", 8803
AUDIT_KEYS = (
    "issue",
    "policy",
    "context_sha",
    "model",
    "probabilities",
    "in_scope",
    "ai_instructions",
    "route",
    "patch_allowed",
    "reasons",
    "error",
)
SMOKE_ISSUE_RE = re.compile(r"^[0-9]+$")
SMOKE_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]+-[0-9]+$")
USAGE = "usage: server.py [--smoke <issue number> | --smoke <JIRA-KEY>]"


def context_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


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


def _triage(
    ticket: int | str,
    fetch: Callable[[], dict[str, str]],
    *,
    invalid: str | None,
    client: httpx.Client,
    env: Mapping[str, str],
    audit_log: Path,
    config: Config,
    summary: str | None,
) -> dict[str, Any]:
    """Shared path of both tools: fetch -> Jev -> policy -> audit. `invalid` fails closed before any I/O."""
    start = time.monotonic()
    if invalid is not None:
        verdict = policy.error_verdict(ticket, invalid)
    else:
        try:
            issue = fetch()
            answers, model = jev.ask(
                issue["title"],
                jev.ticket_text(issue["body"], summary),
                context=config.description,
                api_key=env.get("TYPESAFE_API_KEY") or None,
                client=client,
            )
            verdict = policy.decide(ticket, answers, model)
        except (github.IssueError, jira.IssueError, jev.JevError, policy.AnswerError) as exc:
            verdict = policy.error_verdict(ticket, str(exc))
        except Exception as exc:  # noqa: BLE001 - fail closed on anything unexpected
            verdict = policy.error_verdict(ticket, f"internal error ({type(exc).__name__})")
    verdict["context_sha"] = context_sha(config.description)
    _audit(Path(audit_log), verdict, round((time.monotonic() - start) * 1000))
    return verdict


def triage(
    issue_number: int,
    *,
    client: httpx.Client,
    env: Mapping[str, str],
    audit_log: Path,
    config: Config,
    summary: str | None = None,
) -> dict[str, Any]:
    """GitHub issue <issue_number> of shipgate.yaml target.repo."""
    return _triage(
        issue_number,
        lambda: github.fetch_issue(
            issue_number, repo=config.repo, token=env.get("GITHUB_PAT") or None, client=client
        ),
        invalid="issue_number must be >= 1" if issue_number < 1 else None,
        client=client,
        env=env,
        audit_log=audit_log,
        config=config,
        summary=summary,
    )


def triage_jira(
    ticket_key: str,
    *,
    client: httpx.Client,
    env: Mapping[str, str],
    audit_log: Path,
    config: Config,
    summary: str | None = None,
) -> dict[str, Any]:
    """Jira ticket <ticket_key> of shipgate.yaml jira.project, read from jira.site (never a caller's site)."""
    key = ticket_key if isinstance(ticket_key, str) else str(ticket_key)
    jc = config.jira
    invalid: str | None = None
    if jc is None:
        invalid = "no jira: section in shipgate.yaml"
    elif not jc.key_re().fullmatch(key):  # fullmatch: `$` alone would let "KAN-4\n" through
        invalid = f"ticket_key must be a {jc.project} key such as {jc.project}-1"
    if invalid is not None:
        key = key[:40]  # a caller's arbitrary text never goes whole into the verdict or the audit log

    def fetch() -> dict[str, str]:
        assert jc is not None  # `invalid` is set when it is None
        return jira.fetch_issue(
            key,
            site=jc.site,
            email=env.get("JIRA_EMAIL") or None,
            token=env.get("JIRA_API_KEY") or None,
            client=client,
        )

    return _triage(
        key,
        fetch,
        invalid=invalid,
        client=client,
        env=env,
        audit_log=audit_log,
        config=config,
        summary=summary,
    )


def build_app(
    *,
    client: httpx.Client | None = None,
    env: Mapping[str, str] | None = None,
    audit_log: Path = AUDIT_LOG,
    config: Config | None = None,
) -> FastMCP:
    app = FastMCP("triage", host=HOST, port=PORT, streamable_http_path="/mcp", log_level="WARNING")
    http = client if client is not None else httpx.Client()
    cfg = env if env is not None else load_env(env_path(), os.environ)
    target = config if config is not None else load_config()

    @app.tool(
        annotations=ToolAnnotations(
            title=f"Triage a {target.name} ticket",
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=True,
        )
    )
    def triage_ticket(issue_number: int, summary: str = "") -> dict[str, Any]:
        """Classify issue <issue_number> of the configured target repo with TypeSafe Jev under policy
        triage-v1.

        summary: your own 1-2 sentence summary of the ticket (function, input, expected vs actual output),
        at most 600 characters. Jev gets the title, this summary and the first 1000 characters of the
        ticket body, never the full ticket. Returns route, patch_allowed and card_line. Copy card_line
        verbatim into the evidence card. Read-only.
        """
        return triage(issue_number, client=http, env=cfg, audit_log=audit_log, config=target, summary=summary)

    if target.jira is not None:
        project = target.jira.project

        @app.tool(
            description=(
                f"Classify Jira ticket <ticket_key> of project {project} (for example {project}-1) with "
                "TypeSafe Jev under policy triage-v1. Only keys of that project on the configured Jira site "
                "are read.\n\n"
                "summary: your own 1-2 sentence summary of the ticket (function, input, expected vs actual "
                "output), at most 600 characters. Jev gets the title, this summary and the first 1000 "
                "characters of the ticket description, never the full ticket. Returns route, patch_allowed "
                "and card_line. Copy card_line verbatim into the evidence card. Read-only."
            ),
            annotations=ToolAnnotations(
                title=f"Triage a {project} Jira ticket",
                readOnlyHint=True,
                destructiveHint=False,
                idempotentHint=True,
                openWorldHint=True,
            ),
        )
        def triage_jira_ticket(ticket_key: str, summary: str = "") -> dict[str, Any]:
            return triage_jira(
                ticket_key, client=http, env=cfg, audit_log=audit_log, config=target, summary=summary
            )

    return app


def smoke_target(argv: list[str]) -> int | str | None:
    """`--smoke 1` -> 1, `--smoke KAN-4` -> "KAN-4"; None for anything else."""
    if len(argv) == 2 and argv[0] == "--smoke":
        if SMOKE_ISSUE_RE.fullmatch(argv[1]):
            return int(argv[1])
        if SMOKE_KEY_RE.fullmatch(argv[1]):
            return argv[1]
    return None


def smoke(ticket: int | str) -> int:
    """setup.sh --smoke: one real triage call (GitHub or Jira, then TypeSafe), printing the verdict without
    secrets."""
    try:
        cfg = load_config()
    except ConfigError as exc:
        print(f"triage: {exc}", file=sys.stderr)
        return 2
    env = load_env(env_path(), os.environ)
    with httpx.Client() as client:
        if isinstance(ticket, int):
            v = triage(ticket, client=client, env=env, audit_log=AUDIT_LOG, config=cfg)
            where = f"#{ticket} on {cfg.repo}"
        else:
            v = triage_jira(ticket, client=client, env=env, audit_log=AUDIT_LOG, config=cfg)
            where = f"{ticket} on {cfg.jira.site if cfg.jira else 'Jira (no jira: section)'}"
    print(f"triage {where}: {v['route']} · {v['card_line']}")
    return 1 if v["route"] == "error" else 0


def main(argv: list[str]) -> int:
    if not argv:
        build_app().run(transport="streamable-http")
        return 0
    ticket = smoke_target(argv)
    if ticket is None:
        print(USAGE, file=sys.stderr)
        return 2
    return smoke(ticket)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
