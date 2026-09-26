"""scripts/seed_jira.py: seed the Jira twins of the fixture issues and reset one. A fake Jira behind
httpx.MockTransport; nothing here reaches the network or reads a real .env."""

from __future__ import annotations

import base64
import io
import json
import re
from pathlib import Path

import httpx
import pytest
import seed_jira
from shipgate_config import Config, JiraConfig

SITE = "developertunnel.atlassian.net"
EMAIL, TOKEN = "dev@example.test", "jira-token-not-real"
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
STATUSES = {"11": "To Do", "21": "In Progress", "31": "In Review", "41": "Done"}


class FakeJira:
    """Just enough of Jira Cloud REST for seed_jira.py; records every request."""

    def __init__(self, issues: dict[str, dict] | None = None, fail: int | None = None) -> None:
        self.issues = issues if issues is not None else {}
        self.fail = fail
        self.requests: list[httpx.Request] = []
        self.next = 10

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert request.url.host == SITE
        if self.fail:
            return httpx.Response(self.fail, json={"errorMessages": [f"secret-ish body {TOKEN}"]})
        path, method = request.url.path, request.method
        if method == "GET" and path == "/rest/api/3/search/jql":
            label = re.search(r'labels = "([^"]+)"', request.url.params["jql"]).group(1)
            hits = [{"id": "1", "key": k} for k, v in self.issues.items() if label in v["labels"]]
            return httpx.Response(200, json={"issues": hits, "isLast": True})
        if method == "POST" and path == "/rest/api/2/issue":
            f = json.loads(request.content)["fields"]
            key = f"KAN-{self.next}"
            self.next += 1
            self.issues[key] = {"labels": list(f["labels"]), "status": "To Do"}
            return httpx.Response(201, json={"id": "100", "key": key, "self": "x"})
        m = re.fullmatch(r"/rest/api/[23]/issue/(KAN-\d+)(/transitions)?", path)
        if not m or m.group(1) not in self.issues:
            return httpx.Response(404, json={})
        issue = self.issues[m.group(1)]
        if m.group(2) and method == "GET":
            ts = [{"id": i, "name": n, "to": {"name": n}} for i, n in STATUSES.items()]
            return httpx.Response(200, json={"transitions": ts})
        if m.group(2) and method == "POST":
            issue["status"] = STATUSES[json.loads(request.content)["transition"]["id"]]
            return httpx.Response(204)
        if method == "GET":
            fields = {"labels": issue["labels"], "status": {"name": issue["status"]}}
            return httpx.Response(200, json={"key": m.group(1), "fields": fields})
        if method == "PUT":
            for op in json.loads(request.content)["update"]["labels"]:
                if "add" in op and op["add"] not in issue["labels"]:
                    issue["labels"].append(op["add"])
                if "remove" in op and op["remove"] in issue["labels"]:
                    issue["labels"].remove(op["remove"])
            return httpx.Response(204)
        return httpx.Response(405)

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handler))

    def writes(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.method != "GET"]


def run(fake: FakeJira, *argv: str, tmp_path: Path, config: Config = CFG, creds: bool = True):
    environ = {"SHIPGATE_ENV_FILE": str(tmp_path / "absent.env")}  # never the developer's .env
    if creds:
        environ |= {"JIRA_EMAIL": EMAIL, "JIRA_API_KEY": TOKEN}
    out, err = io.StringIO(), io.StringIO()
    code = seed_jira.main(list(argv), client=fake.client(), config=config, environ=environ, out=out, err=err)
    return code, out.getvalue(), err.getvalue()


def kan4(labels: list[str] | None = None, status: str = "To Do") -> dict[str, dict]:
    return {"KAN-4": {"labels": labels or ["bug", "shipgate-gh-1"], "status": status}}


# --- Markdown -> wiki ----------------------------------------------------------------------------------


def test_md_to_wiki_converts_fences_code_spans_and_bold() -> None:
    md = (
        "`humanize.ordinal(12)` returns `12nd`.\n\n**Steps**\n```python\nx = `a` **b**\n```\n\n"
        "**Expected:** `12th`\n"
    )
    assert seed_jira.md_to_wiki(md) == (
        "{{humanize.ordinal(12)}} returns {{12nd}}.\n\n*Steps*\n{code:python}\nx = `a` **b**\n{code}\n\n"
        "*Expected:* {{12th}}"
    )


def test_md_to_wiki_plain_fence_unclosed_fence_and_braces() -> None:
    assert seed_jira.md_to_wiki("```\nraw\n```") == "{code}\nraw\n{code}"
    assert seed_jira.md_to_wiki("```sh\necho") == "{code:sh}\necho\n{code}"
    assert seed_jira.md_to_wiki("`{% load humanize %}` and {x}") == "{{\\{% load humanize %\\}}} and \\{x\\}"
    assert seed_jira.md_to_wiki("**bold `code` inside**") == "*bold {{code}} inside*"


def test_every_fixture_body_converts_without_markdown_left() -> None:
    for n, fx in seed_jira.load_fixtures().items():
        wiki = seed_jira.md_to_wiki(fx["body"])
        assert "```" not in wiki and "**" not in wiki, n


# --- seed ---------------------------------------------------------------------------------------------


def test_seed_dry_run_reports_existing_plans_missing_and_writes_nothing(tmp_path: Path) -> None:
    fake = FakeJira(kan4())
    code, out, _ = run(fake, tmp_path=tmp_path)
    assert code == 0
    assert "DRY RUN" in out and "exists: gh#1 -> KAN-4" in out
    assert "plan: create Task for gh#3" in out and "plan: create Task for gh#7" in out
    assert "key map:\n  gh#1 -> KAN-4\n" in out
    assert fake.writes() == []
    jqls = [r.url.params["jql"] for r in fake.requests]
    assert jqls == [f'project = KAN AND labels = "shipgate-gh-{n}"' for n in (1, 3, 7)]


def test_seed_yes_creates_tasks_with_wiki_body_and_marker_labels(tmp_path: Path) -> None:
    fake = FakeJira(kan4())
    code, out, _ = run(fake, "--yes", tmp_path=tmp_path)
    assert code == 0
    posts = fake.writes()
    assert [str(r.url) for r in posts] == [f"https://{SITE}/rest/api/2/issue"] * 2
    fixtures = seed_jira.load_fixtures()
    f3 = json.loads(posts[0].content)["fields"]
    assert f3 == {
        "project": {"key": "KAN"},
        "issuetype": {"name": "Task"},
        "summary": fixtures[3]["title"],
        "description": seed_jira.md_to_wiki(fixtures[3]["body"]),
        "labels": ["bug", "shipgate-gh-3"],
    }
    assert json.loads(posts[1].content)["fields"]["labels"] == ["bug", "shipgate-gh-7"]
    assert "key map:\n  gh#1 -> KAN-4\n  gh#3 -> KAN-10\n  gh#7 -> KAN-11\n" in out
    basic = base64.b64encode(f"{EMAIL}:{TOKEN}".encode()).decode()
    assert all(r.headers["Authorization"] == f"Basic {basic}" for r in fake.requests)
    assert TOKEN not in out and EMAIL not in out


def test_seed_is_idempotent(tmp_path: Path) -> None:
    fake = FakeJira(kan4())
    run(fake, "--yes", tmp_path=tmp_path)
    created = len(fake.writes())
    code, out, _ = run(fake, "--yes", "--fixtures", "1,3,7", tmp_path=tmp_path)
    assert code == 0 and len(fake.writes()) == created == 2
    assert "created" not in out and "exists: gh#3 -> KAN-10" in out


def test_seed_only_the_requested_fixtures(tmp_path: Path) -> None:
    fake = FakeJira()
    code, out, _ = run(fake, "--yes", "--fixtures", "2,2", tmp_path=tmp_path)
    assert code == 0 and len(fake.writes()) == 1 and "gh#2 -> KAN-10" in out


@pytest.mark.parametrize("spec", ["99", "1,x", "0", "", "-1"])
def test_seed_rejects_unknown_or_malformed_fixtures(tmp_path: Path, spec: str) -> None:
    fake = FakeJira()
    code, _, err = run(fake, "--fixtures", spec, tmp_path=tmp_path)
    assert code == 2 and "--fixtures" in err and fake.requests == []


# --- reset --------------------------------------------------------------------------------------------


def test_reset_dry_run_plans_labels_and_status_without_writing(tmp_path: Path) -> None:
    fake = FakeJira(kan4(["bug", "fix-proposed", "shipgate-gh-1", "triaged"], status="In Review"))
    code, out, _ = run(fake, "reset", "KAN-4", tmp_path=tmp_path)
    assert code == 0
    labels = "[bug, fix-proposed, shipgate-gh-1, triaged] -> [bug, shipgate-gh-1]"
    assert f"plan: set labels on KAN-4: {labels}" in out
    assert "plan: move KAN-4: In Review -> To Do" in out
    assert "keep: comments" in out and "2 change(s) planned" in out
    assert fake.writes() == []


def test_reset_yes_sends_label_ops_and_the_to_do_transition(tmp_path: Path) -> None:
    fake = FakeJira(kan4(["triaged", "needs-human", "shipgate-gh-1", "custom"], status="In Progress"))
    code, out, _ = run(fake, "reset", "KAN-4", "--yes", tmp_path=tmp_path)
    assert code == 0 and "2 change(s) applied" in out
    put, post = fake.writes()
    assert put.method == "PUT" and put.url.path == "/rest/api/3/issue/KAN-4"
    assert json.loads(put.content) == {
        "update": {
            "labels": [{"add": "bug"}, {"remove": "custom"}, {"remove": "needs-human"}, {"remove": "triaged"}]
        }
    }
    assert post.method == "POST" and post.url.path == "/rest/api/3/issue/KAN-4/transitions"
    assert json.loads(post.content) == {"transition": {"id": "11"}}
    assert sorted(fake.issues["KAN-4"]["labels"]) == ["bug", "shipgate-gh-1"]
    assert fake.issues["KAN-4"]["status"] == "To Do"
    assert not any("comment" in r.url.path for r in fake.requests)


def test_reset_of_a_clean_ticket_changes_nothing(tmp_path: Path) -> None:
    fake = FakeJira(kan4())
    code, out, _ = run(fake, "reset", "KAN-4", "--yes", tmp_path=tmp_path)
    assert code == 0 and "already reset" in out and fake.writes() == []


@pytest.mark.parametrize("key", ["OPS-4", "kan-4", "KAN-0", "KAN-4\n", "KAN-4/../x"])
def test_reset_refuses_keys_outside_the_project_without_any_call(tmp_path: Path, key: str) -> None:
    fake = FakeJira(kan4())
    code, _, err = run(fake, "reset", key, "--yes", tmp_path=tmp_path)
    assert code == 2 and "refusing" in err and "KAN" in err and fake.requests == []


def test_reset_refuses_a_ticket_without_a_marker_label(tmp_path: Path) -> None:
    fake = FakeJira(kan4(["bug", "triaged"]))
    code, _, err = run(fake, "reset", "KAN-4", "--yes", tmp_path=tmp_path)
    assert code == 2 and "not a seeded fixture ticket" in err and fake.writes() == []


def test_reset_without_a_transition_to_the_open_status_changes_nothing(tmp_path: Path) -> None:
    fake = FakeJira(kan4(["bug", "shipgate-gh-1", "triaged"], status="In Review"))
    cfg = Config(**{**CFG.__dict__, "jira": JiraConfig(**{**JIRA.__dict__, "status_open": "Backlog"})})
    code, _, err = run(fake, "reset", "KAN-4", "--yes", tmp_path=tmp_path, config=cfg)
    assert code == 1 and "no transition of KAN-4 leads to 'Backlog'" in err and fake.writes() == []


# --- refusals and failures ----------------------------------------------------------------------------


@pytest.mark.parametrize("argv", [(), ("--yes",), ("reset", "KAN-4", "--yes")])
def test_refuses_without_a_jira_section(tmp_path: Path, argv: tuple[str, ...]) -> None:
    fake = FakeJira(kan4())
    code, _, err = run(fake, *argv, tmp_path=tmp_path, config=BASE)
    assert code == 2 and "no jira: section" in err and fake.requests == []


def test_missing_credentials_is_a_usage_error_without_any_call(tmp_path: Path) -> None:
    fake = FakeJira(kan4())
    code, _, err = run(fake, "--yes", tmp_path=tmp_path, creds=False)
    assert code == 2 and "JIRA_EMAIL and JIRA_API_KEY" in err and fake.requests == []


def test_credentials_come_from_the_env_file(tmp_path: Path) -> None:
    env_file = tmp_path / "jira.env"
    env_file.write_text(f'export JIRA_EMAIL="{EMAIL}"\nJIRA_API_KEY={TOKEN}\n')
    fake = FakeJira(kan4())
    out, err = io.StringIO(), io.StringIO()
    code = seed_jira.main(
        [], client=fake.client(), config=CFG, environ={"SHIPGATE_ENV_FILE": str(env_file)}, out=out, err=err
    )
    assert code == 0, err.getvalue()
    basic = base64.b64encode(f"{EMAIL}:{TOKEN}".encode()).decode()
    assert fake.requests[0].headers["Authorization"] == f"Basic {basic}"


@pytest.mark.parametrize("argv", [(), ("reset", "KAN-4")])
def test_failed_call_prints_the_status_only(tmp_path: Path, argv: tuple[str, ...]) -> None:
    fake = FakeJira(kan4(), fail=401)
    code, out, err = run(fake, *argv, tmp_path=tmp_path)
    assert code == 1 and "HTTP 401" in err
    for secret in (TOKEN, EMAIL, "secret-ish body"):
        assert secret not in out + err
