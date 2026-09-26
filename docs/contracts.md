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
    [--agent ticket-resolver] [--timeout-min N]
```
- `--approve` defaults to `terminal`. `script` requires `--scenario`.
- `--timeout-min` defaults to the scenario's `timeout_min`, else 60 in `ui` / `terminal` (the deadline keeps running
  while a person reads an approval card).
- Exit codes: `0` finished and handoff parsed · `1` error · `2` timeout · `3` unexpected gate in script mode ·
  `4` finished but no valid handoff block.
- It resolves paths from the repo root, not from `orchestrator/`.

## 3. Run directory files

| File | Content |
| --- | --- |
| `meta.json` | `{run_id, scenario, issue, repo, agent, session_id, mode, started_at, finished_at, status, exit_code, turn_ids, unexpected_gate, nudges, ...}`; `status` ∈ `completed`, `timeout`, `error`, `unexpected_gate`, `no_handoff`; `nudges` = fixed "continue" messages sent (0–2, SPEC §4.5) |
| `events.json` | All session events, **oldest first**, as returned by the API (each item `{turn_id, event}`), all pages merged |
| `handoff.json` | The parsed handoff object (SPEC §7), or `null` |
| `final_message.md` | Content of the last `model.message` of the last turn |
| `approvals.jsonl` | This run's approval records (same lines are appended to `approvals.log`) |
| `check.json` | Written by `check.py <ID>` when it grades online: the grade at run time. `check.py --all` reuses it because later scenarios reset the fork; `--all --regrade` grades live instead. Re-running `check.py <ID>` after a reset overwrites it |

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
repo: drax0945/humanize      # must equal shipgate.yaml's target.repo; check.py refuses a mismatch
reset: true            # score.sh runs reset.sh first; false for TR-09 (runs after TR-01)
timeout_min: 15
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

- Base URL: `shipgate.yaml` `trueforge.url`, overridden by env `TRUEFORGE_URL` (§6); prefix `/api/v1`, no auth in
  local mode. OpenAPI at `/api/v1/openapi.json`.
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
| `TRUEFORGE_URL` | orchestrator, `setup.sh`, `setup_agents.ts`, `setup_trueforge.ts`, `check.py` | optional; env `TRUEFORGE_URL` overrides `shipgate.yaml` `trueforge.url` when set (the orchestrator also reads it from `.env`, `setup.sh` from the environment only; `check.py` falls back to `http://localhost:8790` instead) |
| `GITHUB_PAT` | `setup.sh` / `setup_trueforge.ts` (registers the `github` connector), orchestrator (labels), `check.py` (reads), `reset.sh` | fine-grained, scoped to `shipgate.yaml`'s `target.repo` only |
| `OPENROUTER_API_KEY` | `setup.sh` / `setup_trueforge.ts` (registers the `openrouter` model provider) | never sent to the sandbox |
| `TYPESAFE_API_KEY` | triage MCP (`mcp/triage/server.py`) | read on the host only; never in the sandbox |
| `SHIPGATE_CONFIG` | both config loaders (`shipgate_config.py`, `orchestrator/src/config.ts`) | overrides the `shipgate.yaml` path; not a secret |
| `SHIPGATE_ENV_FILE` | `setup.sh`, `setup_trueforge.ts` | overrides the `.env` path (tests use a temp file) |
| `SHIPGATE_PID_DIR` | `setup.sh`, `stop.sh` | overrides `runs/pids` (tests use a temp dir) |

Target repo comes from `shipgate.yaml`'s `target.repo` (demo: `drax0945/humanize`); every component refuses any
other repo.

## 7. Handoff and labels

The handoff block is the **last** fenced ```` ```json ```` block in the final `model.message` of the last turn
(schema: `docs/SPEC.md` §7). Labels (SPEC T15): at start add `triaged` and remove `bug`; at the end, from `outcome`:
`fixed`, `duplicate` → `fix-proposed`; `cannot_reproduce` → `cannot-reproduce`; `stopped` → keep `triaged`;
anything else → `needs-human`. The orchestrator only changes these five labels.

## 8. Triage MCP (`triage_ticket`)

Server `triage` at `http://127.0.0.1:8803/mcp` (`uv run mcp/triage/server.py`), policy `triage-v1`. Contract (from
`docs/superpowers/specs/2026-09-26-jev-triage-design.md` §4, verbatim):

- Annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.
  Not gated; it is listed in `enable_tools` only.
- Input: `{"issue_number": int, "summary": str}`. `issue_number` must be ≥ 1; `summary` is optional (the agent's own
  1-2 sentence summary, capped at 600 characters). The repo comes from `shipgate.yaml` and can't be passed in.
- Jev never gets the full ticket: `state.ticket.body` = `Summary: <summary>` plus the first 1,000 characters of the
  issue body (`jev.ticket_text`). Without a summary, only the excerpt. The questions and classes are unchanged.
- Output is always a JSON object; the tool never raises to the agent:

```json
{
  "policy": "triage-v1",
  "issue": 3,
  "route": "uncertain",
  "patch_allowed": false,
  "top": {"class": "defect", "p": 0.52},
  "runner_up": {"class": "works_as_documented", "p": 0.44},
  "margin": 0.08,
  "probabilities": {"defect": 0.52, "works_as_documented": 0.44, "other_project": 0.02, "docs": 0.0,
                    "security": 0.0, "needs_info": 0.01, "other": 0.01},
  "in_scope": 0.37,
  "ai_instructions": 0.02,
  "reasons": ["margin 0.08 < 0.20"],
  "card_line": "uncertain: defect 0.52 vs works_as_documented 0.44 · in_scope 0.37 · patch held",
  "model": "jev-1.13.0",
  "error": null
}
```

- `route` is one of: `defect`, `docs`, `works_as_documented`, `other_project`, `security`, `needs_info`, `other`,
  `uncertain`, `error`.
- On error (TypeSafe HTTP, timeout, bad shape, missing key; GitHub 404, a pull request, a transport error) the tool
  returns `route: "error"`, `patch_allowed: false`, `error: "<short reason, no secrets>"`, null numbers, and a
  `card_line` of the form `error (<reason>) · patch held`.
- Timeouts: GitHub 15 s; TypeSafe 45 s with one retry on a timeout or 5xx.
- The ticket body is cut to 20,000 characters before it is sent.
- The key is read from `TYPESAFE_API_KEY` in the host environment (loaded from `.env`) and never appears in output or
  logs.
- **Audit:** one JSON line per call in `runs/triage.jsonl` with `ts`, `issue`, `policy`, `model`, `probabilities`,
  `in_scope`, `ai_instructions`, `route`, `patch_allowed`, `reasons`, `error` and `latency_ms`. It never holds ticket
  text or keys. The session events are the primary record; this log survives resets.

Registered with: `PUT /api/v1/settings/mcp-servers` `{"manifest": {"type": "remote", "name": "triage", "url":
"http://127.0.0.1:8803/mcp", "description": "Jev triage pre-check (triage-v1), read-only"}}`. TrueForge must run with
`OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'` (its SSRF guard blocks loopback by default).

## 9. shipgate.yaml

Committed at the repo root with the demo values. A user edits it for their repo. It holds no secrets.

```yaml
target:
  repo: drax0945/humanize             # owner/name; the only repo any component may touch
  default_branch: main
  description: >-                     # context for Jev triage (≤ 500 chars): what the package is and is not
    humanize is a Python library (drax0945/humanize) with functions such as ordinal, intcomma, intword,
    naturalsize, naturaltime, naturalday and naturaldate. It is not Django's django.contrib.humanize.
python:
  install: '.venv/bin/pip install -q --disable-pip-version-check -e ".[tests]"'   # run after `python3 -m venv .venv`
  test: ".venv/bin/python -m pytest -q -p no:cacheprovider --benchmark-disable --color=no"
  source_dir: src/humanize            # fixes may change only files under this directory
  tests_dir: tests                    # the regression test is <tests_dir>/test_issue_<n>.py
trueforge:
  url: http://localhost:8790
  model: openrouter/deepseek-v4-flash
```

**Validation rules**, the same in both loaders:
- unknown keys are an error
- `repo` matches `^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`
- `source_dir` and `tests_dir` are relative, have no `..` and no leading `/`
- `install` and `test` are non-empty and contain no backtick, because they are inserted in backticks
- `description` is 1–500 characters
- `default_branch` is non-empty
- `trueforge.url` is http(s)

Each error names the file and the key.
