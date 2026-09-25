"""Handoff JSON extraction and schema check (SPEC §7, contracts §7).

Hand-written: no jsonschema dependency."""

from __future__ import annotations

import json
import re
from typing import Any

from .constants import (
    DECISIONS,
    FULL_REPO,
    OUTCOMES,
    PRECHECK_OUTCOMES,
    PUSHBACK_AGAINST,
    STAGE,
    STATUSES,
)

# Same rule as orchestrator/src/protocol.ts: a one-line "```json {...}```" block is accepted too.
_JSON_FENCE = re.compile(r"```json(?![A-Za-z0-9_])[ \t]*\r?\n?(.*?)```", re.DOTALL | re.IGNORECASE)
_SHA = re.compile(r"^[0-9a-f]{7,40}$")
_PR_URL = re.compile(rf"^https://github\.com/{re.escape(FULL_REPO)}/pull/\d+$")


class HandoffParseError(ValueError):
    pass


def extract_handoff(message: str | None) -> Any:
    """The handoff is the LAST fenced ```json block of the final model.message."""
    if not message:
        raise HandoffParseError("final message is empty")
    blocks = _JSON_FENCE.findall(message)
    if not blocks:
        raise HandoffParseError("no ```json block in the final message")
    try:
        return json.loads(blocks[-1])
    except ValueError as exc:
        raise HandoffParseError(f"last ```json block is not valid JSON: {exc}") from exc


def _str_or_none(value: Any) -> bool:
    return value is None or isinstance(value, str)


def validate_handoff(h: Any, issue: int | None = None) -> list[str]:
    """Return a list of schema problems (empty = valid)."""
    if not isinstance(h, dict):
        return [f"handoff is {type(h).__name__}, not an object"]
    errs: list[str] = []
    required = (
        "stage",
        "status",
        "outcome",
        "repo",
        "sha",
        "ticket",
        "branch",
        "pr_url",
        "repro",
        "attempts",
        "pushbacks",
        "approvals",
        "reason",
    )
    missing = [k for k in required if k not in h]
    if missing:
        errs.append("missing keys: " + ", ".join(missing))
    if "stage" in h and h["stage"] != STAGE:
        errs.append(f"stage={h['stage']!r}, want {STAGE!r}")
    if "status" in h and h["status"] not in STATUSES:
        errs.append(f"status={h['status']!r} not in {'|'.join(STATUSES)}")
    outcome = h.get("outcome")
    if "outcome" in h and outcome not in OUTCOMES:
        errs.append(f"outcome={outcome!r} not a known outcome")
    if "repo" in h and h["repo"] != FULL_REPO:
        errs.append(f"repo={h['repo']!r}, want {FULL_REPO!r}")
    if "sha" in h:
        sha = h["sha"]
        if sha is None:
            if outcome not in PRECHECK_OUTCOMES:
                errs.append("sha is null (only allowed for pre-check outcomes)")
        elif not isinstance(sha, str) or not _SHA.match(sha):
            errs.append(f"sha={sha!r} is not a 7-40 char lowercase hex SHA")
    if "ticket" in h:
        ticket = h["ticket"]
        if not isinstance(ticket, str) or not re.fullmatch(r"gh#\d+", ticket):
            errs.append(f"ticket={ticket!r}, want 'gh#<n>'")
        elif issue is not None and ticket != f"gh#{issue}":
            errs.append(f"ticket={ticket!r}, want 'gh#{issue}'")
    if "branch" in h and not _str_or_none(h["branch"]):
        errs.append("branch must be a string or null")
    if "pr_url" in h:
        pr_url = h["pr_url"]
        if not _str_or_none(pr_url):
            errs.append("pr_url must be a string or null")
        elif pr_url is not None and not _PR_URL.match(pr_url):
            errs.append(f"pr_url={pr_url!r} is not a {FULL_REPO} pull URL")
    if outcome == "fixed":
        if issue is not None and h.get("branch") != f"fix/issue-{issue}":
            errs.append(f"outcome fixed but branch={h.get('branch')!r}, want 'fix/issue-{issue}'")
        if not h.get("pr_url"):
            errs.append("outcome fixed but pr_url is empty")
    repro = h.get("repro")
    if "repro" in h:
        if not isinstance(repro, dict):
            errs.append("repro must be an object")
        else:
            for k in ("before", "after", "suite", "hit_rate"):
                if k not in repro:
                    errs.append(f"repro.{k} missing")
                elif not _str_or_none(repro[k]):
                    errs.append(f"repro.{k} must be a string or null")
    if "attempts" in h:
        attempts = h["attempts"]
        if not isinstance(attempts, list):
            errs.append("attempts must be a list")
        else:
            for i, a in enumerate(attempts):
                if not isinstance(a, dict):
                    errs.append(f"attempts[{i}] is not an object")
                    continue
                if not isinstance(a.get("n"), int) or isinstance(a.get("n"), bool):
                    errs.append(f"attempts[{i}].n must be an integer")
                files = a.get("files")
                if not isinstance(files, list) or not all(isinstance(f, str) for f in files):
                    errs.append(f"attempts[{i}].files must be a list of paths")
    if "pushbacks" in h:
        pbs = h["pushbacks"]
        if not isinstance(pbs, list):
            errs.append("pushbacks must be a list")
        else:
            for i, p in enumerate(pbs):
                if not isinstance(p, dict):
                    errs.append(f"pushbacks[{i}] is not an object")
                    continue
                if p.get("against") not in PUSHBACK_AGAINST:
                    errs.append(
                        f"pushbacks[{i}].against={p.get('against')!r} not in ticket|approver|evidence"
                    )
                for k in ("rule", "detail"):
                    if not isinstance(p.get(k), str):
                        errs.append(f"pushbacks[{i}].{k} must be a string")
    if "approvals" in h:
        aps = h["approvals"]
        if not isinstance(aps, list):
            errs.append("approvals must be a list")
        else:
            for i, a in enumerate(aps):
                if not isinstance(a, dict):
                    errs.append(f"approvals[{i}] is not an object")
                    continue
                if not isinstance(a.get("tool"), str):
                    errs.append(f"approvals[{i}].tool must be a string")
                if a.get("decision") not in DECISIONS:
                    errs.append(f"approvals[{i}].decision={a.get('decision')!r} not allow|deny")
    if "reason" in h and not isinstance(h["reason"], str):
        errs.append("reason must be a string")
    return errs
