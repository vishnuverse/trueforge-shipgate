"""Parse a TrueForge session's events (oldest first, items `{turn_id, event}`) into a timeline.

Shapes follow docs/contracts.md §5 and tests/fixtures/trueforge/sample_session_events.json:
- `model.message`: `content`, `tool_calls[{id, function: {name, arguments (JSON string)}}]`
- `tool.response`: `tool_call_id`, `content`
  (for `exec`: a JSON string `{success, response: {exitCode, result}}`)
- `tool.approval_required`: `tool_calls[{id, source_event_id}]`
- `turn.created`: `input[]`; a gate answer is
  `{type: user.tool_approval, tool_call_id, approval: {status, reason}}`
- MCP tools are deferred: `function.name == "call_tool"` with `{mcp_server, tool_name, input}`; a direct
  `function.name` equal to a GitHub MCP tool name is treated the same way (input = the arguments), and so is
  a direct Jira tool name (server `jira`, see constants.JIRA_MCP_TOOLS) and `triage_jira_ticket` (server
  `triage`).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from .canonical import args_sha256
from .constants import (
    GITHUB_MCP_TOOLS,
    GITHUB_SERVER,
    JIRA_GENERIC_TOOLS,
    JIRA_MCP_TOOLS,
    JIRA_SERVER,
    TRIAGE_JIRA_TOOL,
    TRIAGE_SERVER,
)

_ATLASSIAN_NAME = re.compile(r"Jira|Confluence")


@dataclass
class ToolCall:
    id: str
    index: int  # position of the model.message in the event list
    turn_id: str | None
    event_id: str | None
    function: str  # raw function name (exec, call_tool, list_tools, ...)
    arguments: dict[str, Any] | None
    mcp_server: str | None = None  # set for MCP calls
    tool: str = ""  # effective tool name: MCP tool_name, else the function name
    input: dict[str, Any] | None = None  # MCP tool input

    @property
    def is_mcp(self) -> bool:
        return self.mcp_server is not None

    @property
    def is_github(self) -> bool:
        return self.mcp_server == GITHUB_SERVER

    @property
    def is_jira(self) -> bool:
        return self.mcp_server == JIRA_SERVER

    @property
    def args_sha256(self) -> str | None:
        return args_sha256(self.input) if self.input is not None else None

    @property
    def command(self) -> str:
        if self.function == "exec" and self.arguments:
            cmd = self.arguments.get("command")
            return cmd if isinstance(cmd, str) else ""
        return ""


@dataclass
class ToolResponse:
    tool_call_id: str
    index: int
    content: Any

    @property
    def text(self) -> str:
        return self.content if isinstance(self.content, str) else json.dumps(self.content)

    @property
    def is_denial(self) -> bool:
        return "User denied tool call" in self.text

    @property
    def is_error(self) -> bool:
        data = _loads(self.content)
        if isinstance(data, dict):
            return "error" in data or data.get("isError") is True or data.get("is_error") is True
        return self.text.lstrip().lower().startswith("error")


@dataclass
class ApprovalRequest:
    index: int
    event_id: str | None
    tool_call_ids: list[str]


@dataclass
class Decision:
    tool_call_id: str
    index: int  # position of the turn.created event carrying the answer
    turn_id: str | None
    status: str  # allow | deny
    reason: str | None

    @property
    def prefix(self) -> str:
        return decision_prefix(self.status, self.reason)


@dataclass
class ExecRun:
    call: ToolCall
    response: ToolResponse | None
    exit_code: int | None
    output: str

    @property
    def command(self) -> str:
        return self.call.command

    @property
    def index(self) -> int:
        return self.call.index


@dataclass
class Gate:
    request: ApprovalRequest
    call: ToolCall | None
    tool_call_id: str
    decision: Decision | None

    @property
    def tool(self) -> str:
        return self.call.tool if self.call else "?"


@dataclass
class Timeline:
    items: list[dict[str, Any]] = field(default_factory=list)
    calls: list[ToolCall] = field(default_factory=list)
    responses: dict[str, ToolResponse] = field(default_factory=dict)
    approval_requests: list[ApprovalRequest] = field(default_factory=list)
    decisions: list[Decision] = field(default_factory=list)
    messages: list[tuple[int, str]] = field(default_factory=list)  # (index, non-empty content)
    total_tokens: int = 0

    @property
    def calls_by_id(self) -> dict[str, ToolCall]:
        return {c.id: c for c in self.calls}

    def mcp_calls(self, tool: str | None = None, server: str | None = GITHUB_SERVER) -> list[ToolCall]:
        out = []
        for c in self.calls:
            if not c.is_mcp or (server is not None and c.mcp_server != server):
                continue
            if tool is None or c.tool == tool:
                out.append(c)
        return out

    def exec_runs(self) -> list[ExecRun]:
        runs = []
        for c in self.calls:
            if c.function != "exec":
                continue
            resp = self.responses.get(c.id)
            exit_code, output = parse_exec_content(resp.content if resp else None)
            runs.append(ExecRun(call=c, response=resp, exit_code=exit_code, output=output))
        return runs

    def decision_for(self, tool_call_id: str, after: int = -1) -> Decision | None:
        for d in self.decisions:
            if d.tool_call_id == tool_call_id and d.index > after:
                return d
        return None

    def gates(self) -> list[Gate]:
        """One entry per gated tool call, in the order TrueForge paused on them."""
        by_id = self.calls_by_id
        out = []
        for req in self.approval_requests:
            for cid in req.tool_call_ids:
                out.append(
                    Gate(
                        request=req,
                        call=by_id.get(cid),
                        tool_call_id=cid,
                        decision=self.decision_for(cid, req.index),
                    )
                )
        return out

    def succeeded(self, call: ToolCall) -> bool:
        """The call ran and its response is not an error or a denial."""
        resp = self.responses.get(call.id)
        return resp is not None and not resp.is_denial and not resp.is_error

    def last_content_before(self, index: int) -> str | None:
        last = None
        for i, content in self.messages:
            if i > index:
                break
            last = content
        return last

    def last_message_content(self) -> str | None:
        return self.messages[-1][1] if self.messages else None


def _loads(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str):
        return None
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return None


def decision_prefix(status: str, reason: str | None) -> str:
    """HITL protocol (SPEC §4.5): allow = APPROVE; deny reason prefix REVISE:/EDIT:/STOP; empty = STOP."""
    if status == "allow":
        return "APPROVE"
    text = (reason or "").strip()
    if not text:
        return "STOP"
    upper = text.upper()
    if upper.startswith("REVISE:"):
        return "REVISE"
    if upper.startswith("EDIT:"):
        return "EDIT"
    if re.match(r"STOP\b", upper):
        return "STOP"
    return "NONE"


def parse_exec_content(content: Any) -> tuple[int | None, str]:
    """`{"success": bool, "response": {"exitCode": int, "result": str}}` -> (exit code, output)."""
    data = _loads(content)
    if not isinstance(data, dict):
        return None, content if isinstance(content, str) else ""
    resp = data.get("response")
    if isinstance(resp, dict):
        code = resp.get("exitCode")
        out = resp.get("result")
        if not isinstance(out, str):
            out = "" if out is None else json.dumps(out)
        if isinstance(code, bool) or not isinstance(code, int):
            code = None if data.get("success", True) else 1
        return code, out
    if data.get("success") is False:
        return 1, str(data.get("error", ""))
    return None, ""


def _event(item: Any) -> tuple[str | None, dict[str, Any]]:
    if isinstance(item, dict) and isinstance(item.get("event"), dict):
        return item.get("turn_id"), item["event"]
    if isinstance(item, dict):
        return item.get("turn_id"), item
    return None, {}


def _normalise_call(tc: dict[str, Any], index: int, turn_id: str | None, event_id: str | None) -> ToolCall:
    fn = tc.get("function") or {}
    name = fn.get("name") or ""
    raw = fn.get("arguments")
    args = _loads(raw) if raw is not None else {}
    if not isinstance(args, dict):
        args = None
    call = ToolCall(
        id=str(tc.get("id") or ""),
        index=index,
        turn_id=turn_id,
        event_id=event_id,
        function=name,
        arguments=args,
        tool=name,
    )
    if name == "call_tool" and args is not None:
        call.mcp_server = str(args.get("mcp_server") or "")
        call.tool = str(args.get("tool_name") or "")
        inp = args.get("input")
        if isinstance(inp, str):  # some models send the input as a JSON string
            inp = _loads(inp)
        call.input = inp if isinstance(inp, dict) else {}
    elif name in GITHUB_MCP_TOOLS:
        info = tc.get("tool_info") or {}
        call.mcp_server = str(info.get("mcp_server") or info.get("server") or GITHUB_SERVER)
        call.input = args if args is not None else {}
    else:
        info = tc.get("tool_info") or {}
        named = info.get("mcp_server") or info.get("server")
        jira = (
            name in JIRA_MCP_TOOLS
            or bool(_ATLASSIAN_NAME.search(name))
            or (name in JIRA_GENERIC_TOOLS and named == JIRA_SERVER)
        )
        if jira or name == TRIAGE_JIRA_TOOL:
            call.mcp_server = str(named or (JIRA_SERVER if jira else TRIAGE_SERVER))
            call.input = args if args is not None else {}
    return call


def parse_events(items: list[Any]) -> Timeline:
    tl = Timeline(items=list(items))
    for index, item in enumerate(items):
        turn_id, ev = _event(item)
        etype = ev.get("type")
        if etype == "model.message":
            content = ev.get("content")
            if isinstance(content, str) and content.strip():
                tl.messages.append((index, content))
            for tc in ev.get("tool_calls") or []:
                if isinstance(tc, dict):
                    tl.calls.append(_normalise_call(tc, index, turn_id, ev.get("id")))
        elif etype == "tool.response":
            cid = str(ev.get("tool_call_id") or "")
            if cid and cid not in tl.responses:
                tl.responses[cid] = ToolResponse(tool_call_id=cid, index=index, content=ev.get("content"))
        elif etype == "tool.approval_required":
            ids = [
                str(t.get("id")) for t in ev.get("tool_calls") or [] if isinstance(t, dict) and t.get("id")
            ]
            tl.approval_requests.append(
                ApprovalRequest(index=index, event_id=ev.get("id"), tool_call_ids=ids)
            )
        elif etype == "turn.created":
            for inp in ev.get("input") or []:
                if not isinstance(inp, dict) or inp.get("type") != "user.tool_approval":
                    continue
                approval = inp.get("approval") or {}
                tl.decisions.append(
                    Decision(
                        tool_call_id=str(inp.get("tool_call_id") or ""),
                        index=index,
                        turn_id=turn_id,
                        status=str(approval.get("status") or ""),
                        reason=approval.get("reason"),
                    )
                )
        elif etype == "turn.done":
            metrics = ((ev.get("state") or {}).get("metrics")) or {}
            total = metrics.get("total_tokens")
            if isinstance(total, int):
                tl.total_tokens += total
    return tl


# --- pytest output --------------------------------------------------------------------------------

_SUMMARY_LINE = re.compile(r"^.*\bin \d+(?:\.\d+)?s\b.*$", re.MULTILINE)
_COUNT = re.compile(r"(\d+) (failed|passed|errors?|skipped|xfailed|xpassed|deselected)\b")


def pytest_outcome(run: ExecRun) -> str:
    """`pass` | `fail` (assertion failures) | `error` (collection/import errors) | `none` | `unknown`.

    Parsed from pytest's summary lines when present (robust to `| tail`), else from the exit code
    (pytest: 0 passed, 1 tests failed, 2+ interrupted/usage/collection errors, 5 no tests)."""
    failed = errors = passed = 0
    seen = False
    for line in _SUMMARY_LINE.findall(run.output or ""):
        counts = _COUNT.findall(line)
        if not counts:
            continue
        seen = True
        for num, kind in counts:
            n = int(num)
            if kind == "failed":
                failed += n
            elif kind.startswith("error"):
                errors += n
            elif kind == "passed":
                passed += n
    if seen:
        if failed:
            return "fail"
        if errors:
            return "error"
        return "pass" if passed else "none"
    if run.exit_code is None:
        return "unknown"
    return {0: "pass", 1: "fail", 5: "none"}.get(run.exit_code, "error")
