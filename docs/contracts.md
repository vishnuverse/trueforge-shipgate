# Contracts between skill, orchestrator and scorer

The interfaces the parallel workstreams build against. `docs/SPEC.md` §4 is the behaviour; this file is the wiring.
Change a contract here first, then in code.

## 1. Paths (relative to the repo root = `git rev-parse --show-toplevel`)

| Path | Written by | Read by |
| --- | --- | --- |
| `tests/scenarios/<ID>.yaml` | scorer | orchestrator (script mode), `check.py` |
| `runs/<RUN_ID>/<UTC_TS>/` (`UTC_TS` = `YYYYmmddTHHMMSSZ`) | orchestrator | `check.py` (latest `UTC_TS` wins) |
| `approvals.log` (JSONL, append-only) | orchestrator | humans, `check.py` |
| `agents/ticket-resolver.json` | skill workstream | `scripts/setup_agents.ts` |
| `tests/fixtures/trueforge/sample_session_events.json` | (real capture) | unit tests |

`RUN_ID` = the scenario ID (e.g. `TR-10`) or `issue-<n>` for ad-hoc runs. `runs/` and `approvals.log` are gitignored.

## 2. Orchestrator CLI

```bash
npm --prefix orchestrator run shipgate -- run --issue <n> [--approve ui|terminal|script] [--scenario <ID>] \
    [--agent ticket-resolver] [--timeout-min 10]
```
- `--approve` defaults to `terminal`. `script` requires `--scenario`.
- Exit codes: `0` finished and handoff parsed · `1` error · `2` timeout · `3` unexpected gate in script mode ·
  `4` finished but no valid handoff block.
- It resolves paths from the repo root, not from `orchestrator/`.

## 3. Run directory files

| File | Content |
| --- | --- |
| `meta.json` | `{run_id, scenario, issue, repo, agent, session_id, mode, started_at, finished_at, status, exit_code, turn_ids, unexpected_gate}`; `status` ∈ `completed`, `timeout`, `error`, `unexpected_gate`, `no_handoff` |
| `events.json` | All session events, **oldest first**, as returned by the API (each item `{turn_id, event}`), all pages merged |
| `handoff.json` | The parsed handoff object (SPEC §7), or `null` |
| `final_message.md` | Content of the last `model.message` of the last turn |
| `approvals.jsonl` | This run's approval records (same lines are appended to `approvals.log`) |

Approval record (one JSON object per line):
```json
{"ts": "2026-09-26T12:34:56Z", "run_id": "TR-10", "scenario": "TR-10", "session_id": "…", "turn_id": "…",
 "thread_id": "main", "tool_call_id": "call_123", "mcp_server": "github", "tool": "create_pull_request",
 "args_sha256": "…", "decision": "deny", "prefix": "REVISE", "reason": "REVISE: …", "mode": "script",
 "unexpected": false}
```
- `prefix` ∈ `APPROVE` (allow), `REVISE`, `EDIT`, `STOP`, `NONE` (deny reason without a known prefix).
- `args_sha256` = SHA-256 hex of the MCP tool **input** object serialised canonically: keys sorted recursively,
  separators `,` and `:` with no spaces, non-ASCII kept as UTF-8 (Python:
  `json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`; TypeScript must match byte for byte).

## 4. Scenario file (`tests/scenarios/<ID>.yaml`)

```yaml
id: TR-10
title: Human says REVISE at the PR gate
issue: 1
reset: true            # score.sh runs reset.sh first; false for TR-09 (runs after TR-01)
timeout_min: 10
approvals:             # orchestrator script mode consumes these in order
  - {tool: create_pull_request, decision: deny, reason: "REVISE: start the PR title with 'fix(ordinal):'"}
  - {tool: create_pull_request, decision: allow}
  - {tool: add_issue_comment, decision: allow}
expect:                # only check.py reads this
  status: ok
  outcome: fixed
  label: fix-proposed
  gates: [create_pull_request, create_pull_request, add_issue_comment]
  pr: {count: 1, head: fix/issue-1, title_prefix: "fix(ordinal):", files: [src/humanize/number.py, tests/test_issue_1.py]}
  comments: {count: 1}
  pushbacks: []
```
Script mode: the next entry must match the pending gate's tool; if the tool differs or the list is used up, the
orchestrator answers `deny` with reason `STOP`, marks the record `unexpected: true`, finishes, and exits `3`.

## 5. TrueForge 0.2.1 API facts (verified on this machine)

- Base URL `TRUEFORGE_URL` (default `http://localhost:8790`), prefix `/api/v1`, no auth in local mode. OpenAPI at
  `/api/v1/openapi.json`.
- Create session: `POST /sessions` `{"agent": {"name": "ticket-resolver"}, "metadata": {}}` (or an inline
  `{"agent": {"spec": AgentSpec}}`). Response `data.id`.
- Create turn: `POST /sessions/{id}/turns` `{"input": [...], "stream": false}` → `data.id` with `state.status`
  `running` immediately. Wait with `GET /sessions/{id}/turns/{turn_id}/subscribe` (stream closes when the turn ends),
  then `GET /sessions/{id}/turns/{turn_id}` → `data.state` = `{status: "done", output, required_actions}`.
- Input items: `{"type": "user.message", "content": "..."}`; resume a gate with
  `{"type": "user.tool_approval", "thread_id": "main", "tool_call_id": "call_…", "approval": {"status": "allow"}}` or
  `{"approval": {"status": "deny", "reason": "..."}}`. Each resume creates a **new turn**.
- A gate ends the turn with `state.required_actions = [{"type": "tool.approval_required", "thread_id", "tool_calls":
  [{"id", "source_event_id"}]}]`. `source_event_id` is the `model.message` event that made the call.
- `GET /sessions/{id}/events?limit=100&page_token=…` returns `{data: [{turn_id, event}], pagination:
  {limit, next_page_token?}}`, **newest first**.
- Event types seen: `turn.created` (has `input`, so approvals given in the UI show up here), `model.message`
  (`content`, `tool_calls[{id, function: {name, arguments(JSON string)}}]`), `tool.response` (`tool_call_id`,
  `content`), `tool.approval_required`, `mcp.initialize`, `sandbox.created`, `turn.done`.
- MCP tools are deferred: calls look like `function.name = "call_tool"`, arguments
  `{"mcp_server": "github", "tool_name": "create_pull_request", "input": {...}}`; the model may first call
  `list_tools` / `get_tool_info`. Treat a direct `function.name` equal to an MCP tool name the same way.
- Sandbox shell: `function.name = "exec"`, arguments `{"command", "intent"}`; its `tool.response.content` is a JSON
  string `{"success": true, "response": {"exitCode": 0, "result": "..."}}`.
- Agents: `POST /agents` `{name, description, manifest: AgentSpec}`; `PUT /agents/{agent_id}`; `GET /agents`.
- Git skills: `PUT /settings/skills` `{"manifest": {"type": "git", "name", "url", "path", "ref", "description"}}`.

## 6. Environment (`.env`, never committed; names only)

| Name | Used by | Notes |
| --- | --- | --- |
| `TRUEFORGE_URL` | orchestrator, `check.py`, `setup_agents.ts` | default `http://localhost:8790` |
| `GITHUB_PAT` | orchestrator (labels), `check.py` (reads), `reset.sh` | fine-grained, `vishnuverse/humanize` only |
| `TYPESAFE_API_KEY` | Triage (after P0) | not used by P0 |

Target repo is the constant `vishnuverse/humanize`; code refuses any other.

## 7. Handoff and labels

The handoff block is the **last** fenced ```` ```json ```` block in the final `model.message` of the last turn
(schema: `docs/SPEC.md` §7). Labels (SPEC T15): at start add `triaged` and remove `bug`; at the end, from `outcome`:
`fixed`, `duplicate` → `fix-proposed`; `cannot_reproduce` → `cannot-reproduce`; `stopped` → keep `triaged`;
anything else → `needs-human`. The orchestrator only changes these five labels.
