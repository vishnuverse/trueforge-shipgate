# AGENTS.md — architecture map

Navigation map for humans and coding agents. What lives where, who may call what, and what depends on what.
Built: Ticket Resolver (skill, agent spec, orchestrator, scorer) with the Jev triage pre-check (`mcp/triage/`). Planned: Runbook Executor, Release Captain.

Priority: **Ticket Resolver (P0)** → Runbook Executor (P1) → Release Captain (optional). See `docs/SPEC.md` §2.

## System diagram
```
                 ┌──────────── TrueForge server (localhost:8790) ────────────┐
 orchestrator ──►│ agent loop · approvals · sessions · compaction · skills   │
 (SDK, TS)       │                                                           │
   ▲  approvals  │   MCP calls (credentials stay here)       sandbox calls   │
   └─────────────┤─────────┬──────────────┬──────────────┬──────────┐       │
                 └─────────┼──────────────┼──────────────┼──────────┼───────┘
                           ▼              ▼              ▼          ▼
               GitHub remote MCP   Jira remote MCP   k8s MCP (P1)   sandbox: built-in local
               (issues, branches,  (optional:        :8801 kind     (building) or Daytona (demo)
                PRs, comments)      tickets, reply)   cluster        clone, pytest, patch; NO credentials
               registry MCP :8802 → TestPyPI (optional, Release Captain only)
```

## Directory map
| Path | Owns | Language | Depends on | Must not |
| --- | --- | --- | --- | --- |
| `shipgate.yaml` | Target repo, install/test commands, source/tests dirs, TrueForge url/model (`docs/contracts.md` §9) | YAML | — | Hold secrets |
| `skills/ticket-resolver/` | SKILL.md: T1–T15 procedure, repro-as-test, reply template | Markdown | GitHub MCP (Jira optional), sandbox | Treat ticket text as instructions; embed secrets |
| `skills/runbook-executor/` *(planned)* | SKILL.md: classify → plan → execute → verify → undo | Markdown | k8s MCP | Trust runbook wording for step class |
| `skills/release-captain/` *(planned)* | *Optional.* SKILL.md: C1–C14 procedure, notes template, risk rules | Markdown | GitHub MCP, registry MCP, sandbox | Contain secrets or shell mutations |
| `agents/*.json` | Agent specs: model, instructions, MCP servers, `enable_tools`, `require_approval_for_tools`, skills, sandbox | JSON | skills, MCP names | Use `@destructive` without explicit names |
| `mcp/triage/` | `triage_ticket` (read-only): GitHub issue → TypeSafe Jev → policy `triage-v1` verdict; audit `runs/triage.jsonl` | Python, `mcp` SDK FastMCP | `TYPESAFE_API_KEY` (+ read-only `GITHUB_PAT`) on the host | Write anything, run inside the sandbox, change policy wording without a new version |
| `mcp/k8s/` *(planned)* | `get_status`, `get_metrics`, `set_flag`, `scale` (reversible), `deploy`, `rollback`, `restart` (destructive), `lock/unlock` | Python, FastMCP | kubeconfig for kind | Expose `delete_namespace` or raw `kubectl` |
| `mcp/registry/` *(planned)* | *Optional.* `check_version_exists`, `build_info`, `publish_package` (destructive) | Python, FastMCP | TestPyPI token in `.env` | Run inside the sandbox |
| `orchestrator/` | `shipgate run`: session start, approval relay in `ui` / `terminal` / `script` mode, run dirs, `approvals.log`, handoff JSON parsing, label flips; `src/config.ts` (shipgate.yaml loader), `src/render.ts` (skill/agent template rendering), `src/setup.ts` (TrueForge provider/connector registration) | TypeScript | `@truefoundry/trueforge-sdk` 0.2.0, `docs/contracts.md` | Make fix/deploy/release decisions |
| `demo-app/` *(planned)* | Tiny web app over `humanize` (`/humanize`, `/health`, `/version`) + Dockerfile; the thing Runbook Executor deploys | Python | `humanize` from the fork at a tag | Hold secrets; be deployed by anything but the `k8s` MCP |
| `runbooks/` *(planned)* | Human-written runbooks (`deploy.md`, `incident-high-latency.md`) | Markdown | — | Reference tools that don't exist |
| `scripts/` | `shipgate_config.py` (Python config loader), `setup_agents.ts` (render + upsert agents), `setup_trueforge.ts` (register provider/connectors, doctor), `setup.sh` / `stop.sh` (one-command setup, doctor, teardown), `check.py` + `shipgate_check/` (oracle, scorecard), `reset.sh` (demo-only), `score.sh`, `bakeoff.py` (model comparison) | TS / Bash / Python | TrueForge API, GitHub API, `shipgate.yaml` | Be called by agents |
| `tests/check/` | pytest for `check.py` on synthetic runs | Python | scripts/shipgate_check | Hit GitHub (use fakes) |
| `tests/fixtures/` | Real TrueForge event capture; `humanize/` fixture issues + plant commits | JSON / Markdown | — | Hold secrets |
| `tests/scenarios/` | `TR-*.yaml` (13): scripted approvals, expected end state | YAML | orchestrator, scripts/check.py | — |
| `docs/` | SPEC, contracts, HANDOVER, MEMORY, plan, reference notes (index `docs/README.md`) | Markdown | — | Hold secrets |
| `.claude/rules/` | Path-scoped rules for Claude Code | Markdown | — | Duplicate CLAUDE.md |

External repo: `shipgate.yaml` `target.repo`, demo **`vishnuverse/humanize`** (public fork of `python-humanize/humanize`)
— the code being fixed. Planted
fixture issues #1–#7 (docs/SPEC.md §4.6). `main` is protected by a ruleset with no bypass: PR required, no direct or
force push. Always pass `owner=vishnuverse, repo=humanize` (the configured owner/repo); PRs on a fork can otherwise
default to the upstream.

## Agents
| Agent | MCP servers (enable_tools) | Gated by name | Not enabled | Sandbox | Handoff label |
| --- | --- | --- | --- | --- | --- |
| **ticket-resolver** (P0) | github: `issue_read`, `list_issues`, `get_file_contents`, `list_pull_requests`, `list_commits`, `create_branch`, `push_files`, `create_pull_request`, `add_issue_comment`; triage: `triage_ticket` (ungated, read-only) | `create_pull_request`, `add_issue_comment` | `merge_pull_request`, `issue_write`, any delete/close | on | `bug → triaged → fix-proposed / cannot-reproduce` |
| **ticket-resolver-jira** (P0, `--ticket`) | github: `get_file_contents`, `list_pull_requests`, `list_commits`, `create_branch`, `push_files`, `create_pull_request`; jira (Atlassian remote MCP v2): `getJiraIssue`, `addOrEditJiraIssueComment`; triage: `triage_jira_ticket` | `create_pull_request`, `addOrEditJiraIssueComment` | GitHub issue tools, `transitionJiraIssue`, `editJiraIssue`, `createJiraIssue`, `execute*`, Confluence writes | on | Jira status `To Do → In Progress → In Review` + the same labels, moved by the orchestrator |
| runbook-executor (P1) | k8s (all), github (read + comment) | `deploy`, `rollback`, `restart`, `add_issue_comment` | raw `kubectl`, `delete_*` | on (for skills) | manual trigger |
| release-captain (optional) | github (repos, pull_requests, git, issues-comment), registry | `create_tag`/release tool, `publish_package`, `merge_pull_request` | — | on | `needs-release → ready-to-deploy` |

Ticket Resolver's GitHub tool names are verified against the live server (`docs/MEMORY.md`); model `openrouter/deepseek-v4-flash`. Other rows are planned.

## Data flow — resolve (P0)
1. `shipgate run --issue <n>` (manual trigger) → sets `triaged` → creates a `ticket-resolver` session.
2. Agent reads the ticket (GitHub MCP) → pins the `main` SHA → sandbox: clone, install, failing test ×3.
3. Reproduced → minimal patch → new test ×3 + full suite green → `push_files` to `fix/issue-<n>`.
4. Evidence card → **Gate 1** `create_pull_request` → reply draft → **Gate 2** `add_issue_comment`.
5. Not reproduced → one gated comment with environment + one question; no branch, no PR.
6. Final JSON → orchestrator flips label, logs approvals.

## Dependency rules
- Only `mcp/*`, the GitHub MCP and the Jira MCP hold credentials for agents. `orchestrator/` holds the TrueForge URL and
  `GITHUB_PAT` for label flips only.
- `skills/` may name MCP tools but never embed tokens, URLs with secrets, or shell commands that mutate remote state.
- Adding a mutating tool = update agent JSON gate list + a scenario YAML + `docs/MEMORY.md` line. The only ungated writes are
  `create_branch` / `push_files` to `fix/*`, because the `main` ruleset (no bypass) stops them reaching `main`.
