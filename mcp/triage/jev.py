"""TypeSafe Jev client for the triage MCP (spec §4-5): one POST /v1/systemone per ticket, one retry."""

from __future__ import annotations

from typing import Any

import httpx
import policy

URL = "https://api.typesafe.ai/v1/systemone"
TIMEOUT_S = 45.0
MAX_BODY = 20_000


class JevError(RuntimeError):
    """TypeSafe gave no usable answer (no key, HTTP error, timeout, bad shape). No secrets in the message."""


def ask(
    title: str, body: str, *, context: str, api_key: str | None, client: httpx.Client
) -> tuple[dict[str, Any], str | None]:
    """Returns (answers, model). Retries once on a timeout, a transport error or a 5xx."""
    if not api_key:
        raise JevError("TYPESAFE_API_KEY not set")
    payload = {
        "state": {"repository": context, "ticket": {"title": title, "body": body[:MAX_BODY]}},
        "model": policy.MODEL,
        "questions": policy.QUESTIONS,
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    last = "TypeSafe not reached"
    for _ in range(2):
        try:
            r = client.post(URL, json=payload, headers=headers, timeout=TIMEOUT_S)
        except httpx.TimeoutException:
            last = "TypeSafe timeout"
            continue
        except httpx.HTTPError as exc:
            last = f"TypeSafe transport error ({type(exc).__name__})"
            continue
        if r.status_code >= 500:
            last = f"TypeSafe HTTP {r.status_code}"
            continue
        if r.status_code != 200:
            raise JevError(f"TypeSafe HTTP {r.status_code}")
        try:
            data = r.json()
        except ValueError as exc:
            raise JevError("TypeSafe reply is not JSON") from exc
        if not isinstance(data, dict) or not isinstance(data.get("answers"), dict):
            raise JevError("TypeSafe reply has no answers")
        model = data.get("model")
        return data["answers"], model if isinstance(model, str) else None
    raise JevError(last)
