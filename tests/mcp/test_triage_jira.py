"""triage_jira_ticket: the Jira client and the second tool (same Jev path as GitHub). MockTransport only."""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path

import httpx
import jira
import policy
import pytest
import server
from shipgate_config import Config, JiraConfig

SITE = "developertunnel.atlassian.net"
EMAIL, TOKEN = "dev@example.test", "jira-token-not-real"
ENV = {"TYPESAFE_API_KEY": "test-key-not-real", "JIRA_EMAIL": EMAIL, "JIRA_API_KEY": TOKEN}
JIRA = JiraConfig(
    site=SITE, cloud_id="ce61dd8b-2e04-4815-9b7b-60a570df782b", project="KAN",
    status_start="In Progress", status_review="In Review", status_open="To Do",
)  # fmt: skip
BASE = Config(
    repo="vishnuverse/humanize", default_branch="main", description="humanize is a Python library.",
    install="x", test="y", source_dir="src/humanize", tests_dir="tests",
    trueforge_url="http://localhost:8790", model="m",
)  # fmt: skip
CFG = Config(**{**BASE.__dict__, "jira": JIRA})
TICKET = {
    "id": "10003",
    "key": "KAN-4",
    "fields": {
        "summary": "ordinal(12) returns '12nd' instead of '12th'",
        "description": "{{humanize.ordinal(12)}} returns {{12nd}}.\n\n*Expected:* {{12th}}",
    },
}


def jev_reply() -> dict:
    p = dict.fromkeys(policy.ROUTE_CRITERIA, 0.0) | {"defect": 0.96, "works_as_documented": 0.04}
    return {
        "answers": {
            "route": {"type": "choice", "choice": "defect", "probabilities": p, "confidence": 0.9},
            "in_scope": {"type": "noul", "noul": 0.93},
            "ai_instructions": {"type": "noul", "noul": 0.02},
        },
        "model": "jev-1.13.0",
    }


class World:
    """Jira + TypeSafe behind one MockTransport; records every request."""

    def __init__(self, ticket: dict | None = None, jira_status: int = 200):
        self.ticket = TICKET if ticket is None else ticket
        self.jira_status = jira_status
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.host == SITE:
            return httpx.Response(self.jira_status, json=self.ticket)
        return httpx.Response(200, json=jev_reply())

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler))


def one(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def fetch(key: str = "KAN-4", status: int = 200, body: object = None, **kw) -> dict[str, str]:
    reply = TICKET if body is None else body
    args = {"site": SITE, "email": EMAIL, "token": TOKEN} | kw
    return jira.fetch_issue(key, client=one(lambda r: httpx.Response(status, json=reply)), **args)


# --- jira.py -----------------------------------------------------------------------------------------


def test_fetch_issue_reads_v2_with_basic_auth_on_the_configured_site() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=TICKET)

    got = jira.fetch_issue("KAN-4", site=SITE, email=EMAIL, token=TOKEN, client=one(handler))
    assert got == {"title": TICKET["fields"]["summary"], "body": TICKET["fields"]["description"]}
    [req] = seen
    assert req.method == "GET"
    assert req.url.scheme == "https" and req.url.host == SITE and req.url.path == "/rest/api/2/issue/KAN-4"
    assert req.url.params["fields"] == "summary,description"
    basic = base64.b64encode(f"{EMAIL}:{TOKEN}".encode()).decode()
    assert req.headers["Authorization"] == f"Basic {basic}"


def test_fetch_issue_null_description_becomes_empty() -> None:
    reply = {**TICKET, "fields": {"summary": "s", "description": None}}
    assert fetch(body=reply) == {"title": "s", "body": ""}


def test_fetch_issue_404_names_the_ticket() -> None:
    with pytest.raises(jira.IssueError, match=r"^ticket KAN-99 not found$"):
        fetch("KAN-99", status=404, body={"errorMessages": ["Issue does not exist"]})


@pytest.mark.parametrize("status", [401, 403])
def test_fetch_issue_rejected_token_is_clear_and_leaks_nothing(status: int) -> None:
    with pytest.raises(jira.IssueError) as exc:
        fetch(status=status, body={"message": f"token {TOKEN} bad"})
    assert str(exc.value) == f"Jira token rejected (HTTP {status})"
    assert TOKEN not in str(exc.value) and EMAIL not in str(exc.value)


def test_fetch_issue_other_http_error_and_transport_error() -> None:
    with pytest.raises(jira.IssueError, match=r"^Jira HTTP 500$"):
        fetch(status=500, body={})

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(jira.IssueError, match=r"^Jira transport error \(ConnectError\)$"):
        jira.fetch_issue("KAN-4", site=SITE, email=EMAIL, token=TOKEN, client=one(boom))


@pytest.mark.parametrize("kw", [{"email": None}, {"token": None}, {"email": ""}])
def test_fetch_issue_without_credentials_makes_no_request(kw: dict) -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=TICKET)

    args = {"site": SITE, "email": EMAIL, "token": TOKEN} | kw
    with pytest.raises(jira.IssueError, match=r"^JIRA_EMAIL / JIRA_API_KEY not set$"):
        jira.fetch_issue("KAN-4", client=one(handler), **args)
    assert calls == []


def test_fetch_issue_refuses_a_non_key_and_a_moved_ticket() -> None:
    for bad in ("KAN-4/../../myself", "KAN-4\n"):
        with pytest.raises(jira.IssueError, match=r"not a Jira issue key"):
            fetch(bad)
    with pytest.raises(jira.IssueError, match=r"KAN-4 now lives at another key"):
        fetch(body={**TICKET, "key": "OPS-1"})


def test_fetch_issue_rejects_non_issue_replies() -> None:
    with pytest.raises(jira.IssueError, match=r"^Jira reply is not an issue$"):
        fetch(body=["x"])
    with pytest.raises(jira.IssueError, match=r"^Jira reply is not JSON$"):
        jira.fetch_issue(
            "KAN-4", site=SITE, email=EMAIL, token=TOKEN, client=one(lambda r: httpx.Response(200, text="<x"))
        )


# --- server: triage_jira ----------------------------------------------------------------------------


def run(w: World, tmp_path: Path, key: str = "KAN-4", config: Config = CFG, env: dict | None = None, **kw):
    env = ENV if env is None else env
    return server.triage_jira(
        key, client=w.client(), env=env, audit_log=tmp_path / "t.jsonl", config=config, **kw
    )


def test_happy_path_same_jev_path_and_a_clean_audit_line(tmp_path: Path) -> None:
    w = World()
    v = run(w, tmp_path, summary="ordinal(12) gives 12nd, not 12th.")
    assert v["issue"] == "KAN-4" and v["route"] == "defect" and v["patch_allowed"] is True
    assert v["context_sha"] == server.context_sha(CFG.description)
    jira_req, jev_req = w.requests
    assert jira_req.url.host == SITE and jira_req.url.path == "/rest/api/2/issue/KAN-4"
    sent = json.loads(jev_req.content)["state"]
    assert sent["repository"] == CFG.description
    assert sent["ticket"]["title"] == TICKET["fields"]["summary"]
    assert sent["ticket"]["body"].startswith("Summary: ordinal(12) gives 12nd, not 12th.\n\nExcerpt of the")
    assert TICKET["fields"]["description"] in sent["ticket"]["body"]
    line = (tmp_path / "t.jsonl").read_text()
    entry = json.loads(line)
    assert entry["issue"] == "KAN-4" and entry["route"] == "defect" and set(entry) >= set(server.AUDIT_KEYS)
    for text in (*ENV.values(), TICKET["fields"]["summary"]):
        assert text not in line


@pytest.mark.parametrize(
    "key",
    ["kan-4", "KAN-0", "OPS-4", "KAN-4 ", "KAN-4\n", "KAN-", "https://evil.example/KAN-4", "KAN-4/../x"],
)
def test_bad_key_is_an_error_verdict_without_any_http_call(tmp_path: Path, key: str) -> None:
    w = World()
    v = run(w, tmp_path, key=key)
    assert v["route"] == "error" and v["patch_allowed"] is False
    assert v["error"] == "ticket_key must be a KAN key such as KAN-1"
    assert w.requests == []


def test_overlong_bad_key_is_capped_in_verdict_and_audit(tmp_path: Path) -> None:
    v = run(World(), tmp_path, key="X" * 5_000)
    assert v["issue"] == "X" * 40
    assert json.loads((tmp_path / "t.jsonl").read_text())["issue"] == "X" * 40


def test_no_jira_section_fails_closed_without_http(tmp_path: Path) -> None:
    w = World()
    v = run(w, tmp_path, config=BASE)
    assert v["route"] == "error" and v["error"] == "no jira: section in shipgate.yaml" and w.requests == []


def test_jira_errors_fail_closed(tmp_path: Path) -> None:
    assert run(World(jira_status=404), tmp_path)["error"] == "ticket KAN-4 not found"
    assert run(World(jira_status=401), tmp_path)["error"] == "Jira token rejected (HTTP 401)"
    w = World()
    v = run(w, tmp_path, env={"TYPESAFE_API_KEY": "k"})
    assert v["error"] == "JIRA_EMAIL / JIRA_API_KEY not set" and w.requests == []


def test_jira_tool_registered_only_with_a_jira_section(tmp_path: Path) -> None:
    kw = {"client": World().client(), "env": ENV, "audit_log": tmp_path / "t.jsonl"}
    [only] = asyncio.run(server.build_app(config=BASE, **kw).list_tools())
    assert only.name == "triage_ticket"
    tools = {t.name: t for t in asyncio.run(server.build_app(config=CFG, **kw).list_tools())}
    assert set(tools) == {"triage_ticket", "triage_jira_ticket"}
    t = tools["triage_jira_ticket"]
    a = t.annotations
    assert (a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint) == (True, False, True, True)
    assert a.title == "Triage a KAN Jira ticket"
    assert t.inputSchema["required"] == ["ticket_key"]
    assert t.inputSchema["properties"]["ticket_key"]["type"] == "string"
    assert t.inputSchema["properties"]["summary"]["type"] == "string"
    assert "KAN-1" in t.description and "Read-only." in t.description


def test_jira_tool_call_returns_the_structured_verdict(tmp_path: Path) -> None:
    w = World()
    app = server.build_app(client=w.client(), env=ENV, audit_log=tmp_path / "t.jsonl", config=CFG)
    content, structured = asyncio.run(
        app.call_tool("triage_jira_ticket", {"ticket_key": "KAN-4", "summary": "s"})
    )
    assert structured["issue"] == "KAN-4" and structured["route"] == "defect"
    assert json.loads(content[0].text) == structured
    assert [r.url.host for r in w.requests] == [SITE, "api.typesafe.ai"]


# --- smoke ------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("argv", "want"),
    [
        (["--smoke", "1"], 1),
        (["--smoke", "12"], 12),
        (["--smoke", "KAN-4"], "KAN-4"),
        (["--smoke", "AB2-10"], "AB2-10"),
        (["--smoke", "kan-4"], None),
        (["--smoke", "KAN4"], None),
        (["--smoke", "KAN-4\n"], None),
        (["--smoke", "1\n"], None),
        (["--smoke", "²"], None),
        (["--smoke"], None),
        (["--smoke", "1", "2"], None),
        (["--other", "1"], None),
    ],
)
def test_smoke_target_accepts_issue_numbers_and_jira_keys(argv: list[str], want: int | str | None) -> None:
    assert server.smoke_target(argv) == want


def test_main_rejects_a_bad_smoke_argument(capsys: pytest.CaptureFixture[str]) -> None:
    assert server.main(["--smoke", "nope"]) == 2
    assert "usage" in capsys.readouterr().err
