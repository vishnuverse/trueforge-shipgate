"""Seed and reset the Jira twins of the humanize fixture issues (Jira as a second ticket source).

  uv run python scripts/seed_jira.py [--yes] [--fixtures 1,3,7]  find or create one Task per fixture issue
  uv run python scripts/seed_jira.py reset KAN-4 [--yes]          labels to [bug, shipgate-gh-<n>], To Do

Dry run by default: reads Jira and prints the plan; --yes applies it. A fixture's twin is the ticket labelled
shipgate-gh-<n>, so seeding twice creates nothing the second time. Site, project and the open status come
from shipgate.yaml jira:; JIRA_EMAIL and JIRA_API_KEY from the environment or the env file (SHIPGATE_ENV_FILE,
else .env), read with scripts/shipgate_env.py, the same reader as the triage MCP. Failed calls print the
method, path and status code only, never a response body or a key. Reset never deletes comments: the scorer
counts only comments created after a run starts. Exit 0 ok, 1 a Jira call failed, 2 usage/config/refusal.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections.abc import Mapping
from contextlib import nullcontext
from pathlib import Path
from typing import Any, TextIO

import httpx
from shipgate_config import Config, ConfigError, JiraConfig, load_config
from shipgate_env import env_path, load_env

ROOT = Path(__file__).resolve().parents[1]
FIXTURES_DIR = ROOT / "tests" / "fixtures" / "humanize"
DEFAULT_FIXTURES = "1,3,7"
BASE_LABEL = "bug"
MARKER_RE = re.compile(r"^shipgate-gh-[1-9][0-9]*$")
TIMEOUT_S = 20.0
ISSUE_TYPE = "Task"  # team-managed KAN has Task/Story/Epic/Subtask, no Bug
FENCE_RE = re.compile(r"^```([A-Za-z0-9_+-]*)\s*$")
CODE_SPAN_RE = re.compile(r"`([^`]+)`")
BOLD_RE = re.compile(r"\*\*(.+?)\*\*")


class JiraError(RuntimeError):
    """A Jira call failed. The message holds the method, the path and the status code only."""


class Usage(RuntimeError):
    """Usage, config or refusal: exit 2."""


def marker(n: int) -> str:
    return f"shipgate-gh-{n}"


def key_number(key: str) -> int:
    tail = key.rsplit("-", 1)[-1]
    return int(tail) if tail.isdigit() else 0


# --- Markdown -> Jira wiki markup ---------------------------------------------------------------------


def _escape_braces(text: str) -> str:
    return re.sub(r"([{}])", r"\\\1", text)  # a bare { opens a wiki macro


def _inline(line: str) -> str:
    spans: list[str] = []

    def hold(m: re.Match[str]) -> str:
        spans.append("{{" + _escape_braces(m.group(1)) + "}}")
        return f"\x00{len(spans) - 1}\x00"

    text = CODE_SPAN_RE.sub(hold, line)
    text = BOLD_RE.sub(r"*\1*", _escape_braces(text))
    return re.sub(r"\x00(\d+)\x00", lambda m: spans[int(m.group(1))], text)


def md_to_wiki(md: str) -> str:
    """The fixture bodies' Markdown as Jira wiki markup: ```lang fences -> {code:lang}...{code}, `x` -> {{x}},
    **x** -> *x*. Code blocks are copied verbatim."""
    out: list[str] = []
    in_code = False
    for line in md.rstrip("\n").split("\n"):
        fence = FENCE_RE.match(line.strip())
        if fence and not in_code:
            out.append(f"{{code:{fence.group(1)}}}" if fence.group(1) else "{code}")
            in_code = True
        elif in_code and line.strip() == "```":
            out.append("{code}")
            in_code = False
        else:
            out.append(line if in_code else _inline(line))
    if in_code:
        out.append("{code}")
    return "\n".join(out)


# --- Jira REST ----------------------------------------------------------------------------------------


class Jira:
    def __init__(self, client: httpx.Client, *, site: str, email: str, token: str) -> None:
        self.client, self.site, self._auth = client, site, (email, token)

    def call(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
        ok: tuple[int, ...] = (200,),
    ) -> Any:
        try:
            r = self.client.request(
                method,
                f"https://{self.site}{path}",
                params=params,
                json=body,
                auth=self._auth,
                headers={"Accept": "application/json"},
                timeout=TIMEOUT_S,
            )
        except httpx.HTTPError as exc:
            raise JiraError(f"{method} {path}: transport error ({type(exc).__name__})") from exc
        if r.status_code not in ok:
            raise JiraError(f"{method} {path}: HTTP {r.status_code}")  # never echo the body
        if not r.content:
            return {}
        try:
            return r.json()
        except ValueError as exc:
            raise JiraError(f"{method} {path}: reply is not JSON") from exc

    def find_marked(self, project: str, n: int) -> list[str]:
        """Keys of the tickets labelled shipgate-gh-<n> in the project, lowest number first."""
        jql = f'project = {project} AND labels = "{marker(n)}"'
        data = self.call(
            "GET", "/rest/api/3/search/jql", params={"jql": jql, "fields": "summary", "maxResults": 50}
        )
        issues = data.get("issues") if isinstance(data, dict) else None
        keys = [i["key"] for i in issues or [] if isinstance(i, dict) and isinstance(i.get("key"), str)]
        return sorted(keys, key=key_number)

    def create(self, project: str, summary: str, description: str, labels: list[str]) -> str:
        fields = {
            "project": {"key": project},
            "issuetype": {"name": ISSUE_TYPE},
            "summary": summary,
            "description": description,
            "labels": labels,
        }
        data = self.call("POST", "/rest/api/2/issue", body={"fields": fields}, ok=(200, 201))
        key = data.get("key") if isinstance(data, dict) else None
        if not isinstance(key, str):
            raise JiraError("POST /rest/api/2/issue: reply has no key")
        return key

    def labels_and_status(self, key: str) -> tuple[list[str], str]:
        data = self.call("GET", f"/rest/api/2/issue/{key}", params={"fields": "labels,status"})
        fields = data.get("fields") if isinstance(data, dict) else None
        if not isinstance(fields, dict):
            raise JiraError(f"GET /rest/api/2/issue/{key}: reply is not an issue")
        labels = [x for x in fields.get("labels") or [] if isinstance(x, str)]
        status = fields.get("status")
        return labels, (str(status.get("name") or "") if isinstance(status, dict) else "")

    def edit_labels(self, key: str, add: list[str], remove: list[str]) -> None:
        ops = [{"add": x} for x in add] + [{"remove": x} for x in remove]
        self.call("PUT", f"/rest/api/3/issue/{key}", body={"update": {"labels": ops}}, ok=(200, 204))

    def transition_to(self, key: str, status: str) -> tuple[str, str]:
        """(transition id, target name) whose target status is `status` (by name, case-insensitive)."""
        data = self.call("GET", f"/rest/api/3/issue/{key}/transitions")
        for t in (data.get("transitions") if isinstance(data, dict) else None) or []:
            to = t.get("to") if isinstance(t, dict) else None
            name = to.get("name") if isinstance(to, dict) else None
            if isinstance(name, str) and name.casefold() == status.casefold() and t.get("id") is not None:
                return str(t["id"]), name
        raise JiraError(f"no transition of {key} leads to '{status}'")

    def transition(self, key: str, transition_id: str) -> None:
        self.call(
            "POST",
            f"/rest/api/3/issue/{key}/transitions",
            body={"transition": {"id": transition_id}},
            ok=(200, 204),
        )


# --- commands -----------------------------------------------------------------------------------------


def load_fixtures(root: Path = FIXTURES_DIR) -> dict[int, dict[str, str]]:
    data = json.loads((root / "fixtures.json").read_text(encoding="utf-8"))
    return {
        int(i["number"]): {"title": i["title"], "body": (root / i["body_file"]).read_text(encoding="utf-8")}
        for i in data["issues"]
    }


def parse_fixtures(spec: str, known: Mapping[int, Any]) -> list[int]:
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not re.fullmatch(r"[1-9][0-9]*", part):
            raise Usage(f"--fixtures: '{part}' is not a fixture number (e.g. --fixtures 1,3,7)")
        n = int(part)
        if n not in known:
            raise Usage(f"--fixtures: no fixture #{n} in tests/fixtures/humanize/fixtures.json")
        if n not in out:
            out.append(n)
    return out


def seed(
    jira: Jira,
    jc: JiraConfig,
    numbers: list[int],
    fixtures: Mapping[int, dict[str, str]],
    *,
    apply: bool,
    out: TextIO,
) -> int:
    if apply:
        print(f"seed_jira: seeding project {jc.project} on {jc.site}", file=out)
    else:
        print(f"seed_jira: DRY RUN for project {jc.project} on {jc.site} (pass --yes to apply)", file=out)
    keymap: list[str] = []
    for n in numbers:
        found = jira.find_marked(jc.project, n)
        if found:
            if len(found) > 1:
                print(f"  warn: {marker(n)} is on {', '.join(found)}; using {found[0]}", file=out)
            print(f"  exists: gh#{n} -> {found[0]}", file=out)
            keymap.append(f"gh#{n} -> {found[0]}")
            continue
        title = fixtures[n]["title"]
        labels = [BASE_LABEL, marker(n)]
        if not apply:
            print(f'  plan: create {ISSUE_TYPE} for gh#{n} "{title}" (labels {", ".join(labels)})', file=out)
            keymap.append(f"gh#{n} -> (created by --yes)")
            continue
        key = jira.create(jc.project, title, md_to_wiki(fixtures[n]["body"]), labels)
        print(f"  created: gh#{n} -> {key}", file=out)
        keymap.append(f"gh#{n} -> {key}")
    print("key map:", file=out)
    for line in keymap:
        print(f"  {line}", file=out)
    return 0


def reset(jira: Jira, jc: JiraConfig, key: str, *, apply: bool, out: TextIO) -> int:
    labels, status = jira.labels_and_status(key)
    markers = sorted({x for x in labels if MARKER_RE.match(x)}, key=key_number)
    if not markers:
        raise Usage(f"refusing: {key} has no shipgate-gh-<n> label, so it is not a seeded fixture ticket")
    want = [BASE_LABEL, *markers]
    add = [x for x in want if x not in labels]
    remove = sorted({x for x in labels if x not in want})
    # Look the transition up before any write, so a missing one changes nothing.
    move = jira.transition_to(key, jc.status_open) if status.casefold() != jc.status_open.casefold() else None
    if apply:
        print(f"seed_jira: resetting {key} on {jc.site}", file=out)
    else:
        print(f"seed_jira: DRY RUN reset of {key} on {jc.site} (pass --yes to apply)", file=out)
    changes = 0
    if add or remove:
        changes += 1
        if apply:
            jira.edit_labels(key, add, remove)
        desc = f"set labels on {key}: [{', '.join(sorted(labels))}] -> [{', '.join(want)}]"
        print(f"  {'done' if apply else 'plan'}: {desc}", file=out)
    if move is not None:
        changes += 1
        tid, target = move
        if apply:
            jira.transition(key, tid)
        print(f"  {'done' if apply else 'plan'}: move {key}: {status} -> {target}", file=out)
    print("  keep: comments (the scorer counts only comments created after a run starts)", file=out)
    if changes == 0:
        print(f"seed_jira: {key} is already reset", file=out)
    elif apply:
        print(f"seed_jira: {changes} change(s) applied", file=out)
    else:
        print(f"seed_jira: {changes} change(s) planned; run with --yes to apply", file=out)
    return 0


def _parser(prog: str) -> argparse.ArgumentParser:
    return argparse.ArgumentParser(
        prog=prog, description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )


def main(
    argv: list[str] | None = None,
    *,
    client: httpx.Client | None = None,
    config: Config | None = None,
    environ: Mapping[str, str] | None = None,
    out: TextIO | None = None,
    err: TextIO | None = None,
) -> int:
    argv = sys.argv[1:] if argv is None else argv
    out = out or sys.stdout
    err = err or sys.stderr
    environ = os.environ if environ is None else environ
    if argv and argv[0] == "reset":
        p = _parser("seed_jira.py reset")
        p.add_argument("key", help="ticket key, e.g. KAN-4")
        p.add_argument("--yes", action="store_true", help="apply (default: dry run)")
    else:
        p = _parser("seed_jira.py")
        p.add_argument("--yes", action="store_true", help="apply (default: dry run)")
        p.add_argument("--fixtures", default=DEFAULT_FIXTURES, help=f"default {DEFAULT_FIXTURES}")
    try:
        args = p.parse_args(argv[1:] if argv and argv[0] == "reset" else argv)
    except SystemExit as exc:
        return 0 if exc.code == 0 else 2
    try:
        cfg = config if config is not None else load_config()
        jc = cfg.jira
        if jc is None:
            raise Usage("refusing: shipgate.yaml has no jira: section")
        if argv and argv[0] == "reset":
            if not jc.key_re().fullmatch(args.key):
                raise Usage(f"refusing: '{args.key[:40]}' is not a ticket of project {jc.project}")
        else:
            fixtures = load_fixtures()
            numbers = parse_fixtures(args.fixtures, fixtures)
        env = load_env(env_path(environ), environ)
        email, token = env.get("JIRA_EMAIL") or "", env.get("JIRA_API_KEY") or ""
        if not email or not token:
            raise Usage(f"JIRA_EMAIL and JIRA_API_KEY must be set (environment or {env_path(environ)})")
        with nullcontext(client) if client is not None else httpx.Client() as http:
            jira = Jira(http, site=jc.site, email=email, token=token)
            if argv and argv[0] == "reset":
                return reset(jira, jc, args.key, apply=args.yes, out=out)
            return seed(jira, jc, numbers, fixtures, apply=args.yes, out=out)
    except (Usage, ConfigError) as exc:
        print(f"seed_jira: {exc}", file=err)
        return 2
    except JiraError as exc:
        print(f"seed_jira: FAILED: {exc}", file=err)
        return 1


if __name__ == "__main__":
    sys.exit(main())
