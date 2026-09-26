"""TypeSafe and GitHub clients of the triage MCP (spec §4). httpx.MockTransport stands in for both."""

from __future__ import annotations

import json

import github
import httpx
import jev
import policy
import pytest

ISSUE = {
    "number": 1,
    "title": "ordinal(12) returns 12nd",
    "body": "Expected 12th, got 12nd.",
    "state": "open",
}
PROBS = dict.fromkeys(policy.ROUTE_CRITERIA, 0.0) | {"defect": 0.96, "works_as_documented": 0.04}
ANSWERS = {
    "route": {"type": "choice", "choice": "defect", "probabilities": PROBS, "confidence": 0.95},
    "in_scope": {"type": "noul", "noul": 0.93},
    "ai_instructions": {"type": "noul", "noul": 0.02},
}
KEY = "test-key-not-real"


def client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


# --- GitHub -----------------------------------------------------------------------------------------


def test_fetch_issue_reads_only_our_repo_with_the_token() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=ISSUE)

    got = github.fetch_issue(1, token="test-pat-not-real", client=client(handler))
    assert got == {"title": ISSUE["title"], "body": ISSUE["body"]}
    [req] = seen
    assert req.method == "GET"
    assert str(req.url) == "https://api.github.com/repos/vishnuverse/humanize/issues/1"
    assert req.headers["Authorization"] == "Bearer test-pat-not-real"


def test_fetch_issue_without_token_sends_no_auth() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=ISSUE)

    github.fetch_issue(1, token=None, client=client(handler))
    assert "Authorization" not in seen[0].headers


def test_fetch_issue_null_body_becomes_empty() -> None:
    got = github.fetch_issue(
        1, token=None, client=client(lambda r: httpx.Response(200, json={**ISSUE, "body": None}))
    )
    assert got == {"title": ISSUE["title"], "body": ""}


def test_fetch_issue_404() -> None:
    with pytest.raises(github.IssueError, match=r"issue #99 not found"):
        github.fetch_issue(99, token=None, client=client(lambda r: httpx.Response(404, json={})))


def test_fetch_issue_rejects_pull_requests() -> None:
    pr = {**ISSUE, "pull_request": {"url": "x"}}
    with pytest.raises(github.IssueError, match=r"#1 is a pull request"):
        github.fetch_issue(1, token=None, client=client(lambda r: httpx.Response(200, json=pr)))


def test_fetch_issue_transport_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(github.IssueError, match=r"GitHub transport error \(ConnectError\)"):
        github.fetch_issue(1, token=None, client=client(handler))


# --- TypeSafe ---------------------------------------------------------------------------------------


def test_ask_sends_pinned_model_questions_and_truncated_body() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200, json={"answers": ANSWERS, "model": "jev-1.13.0", "usage": {"input_tokens": 1}}
        )

    answers, model = jev.ask("t", "x" * 30_000, api_key=KEY, client=client(handler))
    assert answers == ANSWERS and model == "jev-1.13.0"
    [req] = seen
    assert req.method == "POST" and str(req.url) == jev.URL == "https://api.typesafe.ai/v1/systemone"
    assert req.headers["Authorization"] == f"Bearer {KEY}"
    sent = json.loads(req.content)
    assert sent["model"] == "jev-1.13.0"
    assert sent["questions"] == json.loads(json.dumps(policy.QUESTIONS))
    assert sent["state"]["repository"] == policy.CONTEXT
    assert (
        sent["state"]["ticket"]["title"] == "t"
        and len(sent["state"]["ticket"]["body"]) == jev.MAX_BODY == 20_000
    )


def test_ask_retries_once_on_timeout_then_succeeds() -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(200, json={"answers": ANSWERS, "model": "jev-1.13.0"})

    assert jev.ask("t", "b", api_key=KEY, client=client(handler))[0] == ANSWERS
    assert len(calls) == 2


def test_ask_gives_up_after_two_timeouts() -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(jev.JevError, match=r"^TypeSafe timeout$"):
        jev.ask("t", "b", api_key=KEY, client=client(handler))
    assert len(calls) == 2


def test_ask_retries_5xx_once() -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(503, json={})

    with pytest.raises(jev.JevError, match=r"^TypeSafe HTTP 503$"):
        jev.ask("t", "b", api_key=KEY, client=client(handler))
    assert len(calls) == 2


def test_ask_does_not_retry_4xx_and_never_leaks_the_key() -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(401, json={"error": "bad key"})

    with pytest.raises(jev.JevError) as exc:
        jev.ask("t", "b", api_key=KEY, client=client(handler))
    assert str(exc.value) == "TypeSafe HTTP 401" and KEY not in str(exc.value)
    assert len(calls) == 1


def test_ask_without_key_makes_no_request() -> None:
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={})

    with pytest.raises(jev.JevError, match=r"^TYPESAFE_API_KEY not set$"):
        jev.ask("t", "b", api_key=None, client=client(handler))
    assert calls == []


@pytest.mark.parametrize(
    ("response", "message"),
    [
        (httpx.Response(200, json={"model": "jev-1.13.0"}), "TypeSafe reply has no answers"),
        (httpx.Response(200, text="<html>"), "TypeSafe reply is not JSON"),
    ],
)
def test_ask_rejects_bad_replies(response: httpx.Response, message: str) -> None:
    with pytest.raises(jev.JevError, match=f"^{message}$"):
        jev.ask("t", "b", api_key=KEY, client=client(lambda r: response))
