"""Triage MCP server (spec §4): fetch -> ask -> decide -> audit; never raises; read-only tool."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import policy
import server
from shipgate_config import Config

ENV = {"TYPESAFE_API_KEY": "test-key-not-real", "GITHUB_PAT": "test-pat-not-real"}
CFG = Config(
    repo="drax0945/humanize", default_branch="main", description="humanize is a Python library.",
    install="x", test="y", source_dir="src/humanize", tests_dir="tests",
    trueforge_url="http://localhost:8790", model="m",
)  # fmt: skip
ISSUE = {
    "number": 1,
    "title": "ordinal(12) returns 12nd",
    "body": "Expected 12th, got 12nd.",
    "state": "open",
}


def probs(**p: float) -> dict[str, float]:
    return dict.fromkeys(policy.ROUTE_CRITERIA, 0.0) | p


def jev_reply(route_probs: dict[str, float], in_scope: float = 0.93, ai: float = 0.02) -> dict:
    return {
        "answers": {
            "route": {"type": "choice", "choice": "x", "probabilities": route_probs, "confidence": 0.9},
            "in_scope": {"type": "noul", "noul": in_scope},
            "ai_instructions": {"type": "noul", "noul": ai},
        },
        "model": "jev-1.13.0",
        "usage": {"input_tokens": 1500},
    }


class World:
    """GitHub + TypeSafe behind one httpx.MockTransport; records every request."""

    def __init__(
        self, issue=None, reply=None, jev_status: int = 200, gh_status: int = 200, boom: bool = False
    ):
        self.issue = issue if issue is not None else ISSUE
        self.reply = reply if reply is not None else jev_reply(probs(defect=0.96, works_as_documented=0.04))
        self.jev_status, self.gh_status, self.boom = jev_status, gh_status, boom
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.boom:
            raise RuntimeError("unexpected")
        if request.url.host == "api.github.com":
            return httpx.Response(self.gh_status, json=self.issue)
        return httpx.Response(self.jev_status, json=self.reply)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler))

    def hosts(self) -> list[str]:
        return [r.url.host for r in self.requests]


def run(w: World, tmp_path: Path, n: int = 1, env: dict | None = None) -> dict:
    return server.triage(
        n, client=w.client(), env=ENV if env is None else env, audit_log=tmp_path / "t.jsonl", config=CFG
    )


def test_happy_path_returns_verdict_and_one_clean_audit_line(tmp_path: Path) -> None:
    v = run(World(), tmp_path)
    assert v["route"] == "defect" and v["patch_allowed"] is True and v["model"] == "jev-1.13.0"
    lines = (tmp_path / "t.jsonl").read_text().splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert set(entry) == {"ts", *server.AUDIT_KEYS, "latency_ms"}
    assert entry["route"] == "defect" and entry["policy"] == "triage-v1"
    for secret_or_text in (*ENV.values(), ISSUE["title"], ISSUE["body"]):
        assert secret_or_text not in lines[0]


def test_typesafe_error_gives_error_verdict_without_the_key(tmp_path: Path) -> None:
    v = run(World(jev_status=401), tmp_path)
    assert v["route"] == "error" and v["patch_allowed"] is False and v["error"] == "TypeSafe HTTP 401"
    assert v["card_line"] == "error (TypeSafe HTTP 401) · patch held"
    blob = json.dumps(v) + (tmp_path / "t.jsonl").read_text()
    assert all(secret not in blob for secret in ENV.values())


def test_missing_key_never_calls_typesafe(tmp_path: Path) -> None:
    w = World()
    v = run(w, tmp_path, env={"GITHUB_PAT": "test-pat-not-real"})
    assert v["error"] == "TYPESAFE_API_KEY not set" and v["patch_allowed"] is False
    assert w.hosts() == ["api.github.com"]


def test_malformed_answers_fail_closed(tmp_path: Path) -> None:
    bad = jev_reply({"defect": 1.0})  # six classes missing
    v = run(World(reply=bad), tmp_path)
    assert v["route"] == "error" and v["patch_allowed"] is False and "route classes" in v["error"]


def test_github_404_fails_closed(tmp_path: Path) -> None:
    v = run(World(gh_status=404), tmp_path)
    assert v["route"] == "error" and v["error"] == "issue #1 not found"


def test_non_positive_issue_makes_no_request(tmp_path: Path) -> None:
    w = World()
    v = run(w, tmp_path, n=0)
    assert v["route"] == "error" and v["error"] == "issue_number must be >= 1" and w.requests == []


def test_unexpected_exception_fails_closed(tmp_path: Path) -> None:
    v = run(World(boom=True), tmp_path)
    assert v["route"] == "error" and v["error"] == "internal error (RuntimeError)"


def test_unwritable_audit_log_still_returns_the_verdict(tmp_path: Path) -> None:
    # tmp_path is a directory: open() fails
    v = server.triage(1, client=World().client(), env=ENV, audit_log=tmp_path, config=CFG)
    assert v["route"] == "defect"


def test_tool_is_read_only_and_takes_one_integer(tmp_path: Path) -> None:
    app = server.build_app(client=World().client(), env=ENV, audit_log=tmp_path / "t.jsonl", config=CFG)
    [tool] = asyncio.run(app.list_tools())
    assert tool.name == "triage_ticket"
    a = tool.annotations
    assert (a.readOnlyHint, a.destructiveHint, a.idempotentHint, a.openWorldHint) == (True, False, True, True)
    assert tool.inputSchema["required"] == ["issue_number"]
    assert tool.inputSchema["properties"]["issue_number"]["type"] == "integer"


def test_tool_title_names_the_configured_repo(tmp_path: Path) -> None:
    cfg = Config(**{**CFG.__dict__, "repo": "acme/widgets"})
    app = server.build_app(client=World().client(), env=ENV, audit_log=tmp_path / "t.jsonl", config=cfg)
    [tool] = asyncio.run(app.list_tools())
    assert tool.annotations.title == "Triage a widgets ticket"


def test_tool_call_returns_structured_verdict_and_json_text(tmp_path: Path) -> None:
    app = server.build_app(client=World().client(), env=ENV, audit_log=tmp_path / "t.jsonl", config=CFG)
    content, structured = asyncio.run(app.call_tool("triage_ticket", {"issue_number": 1}))
    assert structured["route"] == "defect" and structured["policy"] == "triage-v1"
    assert json.loads(content[0].text) == structured


def test_app_binds_loopback_8803_at_mcp() -> None:
    app = server.build_app(client=World().client(), env=ENV, config=CFG)
    assert (app.settings.host, app.settings.port, app.settings.streamable_http_path) == (
        "127.0.0.1",
        8803,
        "/mcp",
    )


def test_env_file_parsing_and_precedence(tmp_path: Path) -> None:
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        '# comment\nTYPESAFE_API_KEY="from-file"\nGITHUB_PAT=abc\n\nNOT A LINE\nEMPTY=\n'
        'export EXPORTED_KEY="exp-value"\n'
    )
    assert server.read_dotenv(dotenv) == {
        "TYPESAFE_API_KEY": "from-file",
        "GITHUB_PAT": "abc",
        "EMPTY": "",
        "EXPORTED_KEY": "exp-value",
    }
    env = server.load_env(dotenv, {"GITHUB_PAT": "from-env"})
    assert env["GITHUB_PAT"] == "from-env" and env["TYPESAFE_API_KEY"] == "from-file"
    assert server.read_dotenv(tmp_path / "missing.env") == {}


def test_verdict_and_audit_carry_the_context_sha(tmp_path: Path) -> None:
    v = run(World(), tmp_path)
    assert v["context_sha"] == server.context_sha(CFG.description) and len(v["context_sha"]) == 12
    entry = json.loads((tmp_path / "t.jsonl").read_text())
    assert entry["context_sha"] == v["context_sha"]
    assert run(World(jev_status=401), tmp_path)["context_sha"] == v["context_sha"]  # error verdicts too


def test_issue_and_context_come_from_the_config(tmp_path: Path) -> None:
    w = World()
    cfg = Config(**{**CFG.__dict__, "repo": "acme/widgets", "description": "widgets is a Python package."})
    server.triage(1, client=w.client(), env=ENV, audit_log=tmp_path / "t.jsonl", config=cfg)
    gh, ts = w.requests
    assert gh.url.path == "/repos/acme/widgets/issues/1"
    assert json.loads(ts.content)["state"]["repository"] == "widgets is a Python package."


def test_app_logs_at_warning_level() -> None:
    assert server.build_app(client=World().client(), env=ENV, config=CFG).settings.log_level == "WARNING"


def test_jev_gets_title_summary_and_excerpt_not_the_full_body(tmp_path: Path) -> None:
    long_issue = {**ISSUE, "body": "Expected 12th, got 12nd. " + "detail " * 2_000}
    w = World(issue=long_issue)
    v = server.triage(
        1,
        client=w.client(),
        env=ENV,
        audit_log=tmp_path / "t.jsonl",
        config=CFG,
        summary="ordinal(12) gives 12nd, not 12th.",
    )
    assert v["route"] == "defect"
    [jev_req] = [r for r in w.requests if r.url.host != "api.github.com"]
    ticket = json.loads(jev_req.content)["state"]["ticket"]
    assert ticket["title"] == ISSUE["title"]
    assert ticket["body"].startswith("Summary: ordinal(12) gives 12nd, not 12th.\n\nExcerpt of the ticket:\n")
    assert long_issue["body"] not in ticket["body"] and len(ticket["body"]) < 1_200


def test_tool_accepts_an_optional_summary(tmp_path: Path) -> None:
    w = World()
    app = server.build_app(client=w.client(), env=ENV, audit_log=tmp_path / "t.jsonl", config=CFG)
    [tool] = asyncio.run(app.list_tools())
    assert tool.inputSchema["properties"]["summary"]["type"] == "string"
    _, structured = asyncio.run(app.call_tool("triage_ticket", {"issue_number": 1, "summary": "s"}))
    assert structured["route"] == "defect"
    [jev_req] = [r for r in w.requests if r.url.host != "api.github.com"]
    assert json.loads(jev_req.content)["state"]["ticket"]["body"].startswith("Summary: s\n")
