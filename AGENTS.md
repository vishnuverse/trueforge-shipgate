# AGENTS.md — architecture map

Navigation map for humans and coding agents. What lives where, who may call what, and what depends on what.
(Planned layout — directories are created on hackathon day.)

## System diagram
```
                 ┌──────────── TrueForge server (localhost:8790) ────────────┐
 orchestrator ──►│ agent loop · approvals · sessions · compaction · skills   │
 (SDK, TS)       │                                                           │
   ▲  approvals  │   MCP calls (credentials stay here)       sandbox calls   │
   └─────────────┤──────────────┬───────────────┬──────────────┐            │
                 └──────────────┼───────────────┼──────────────┼────────────┘
                                ▼               ▼              ▼
                    GitHub remote MCP    registry MCP     k8s MCP (stretch)     Daytona sandbox
                    (tags, PRs, issues)  :8802 TestPyPI   :8801 kind cluster    (clone, pytest, build;
                                                                                 NO credentials)
```

## Directory map
| Path | Owns | Language | Depends on | Must not |
| --- | --- | --- | --- | --- |
| `skills/release-captain/` | SKILL.md: C1–C14 procedure, notes template, risk rules | Markdown | GitHub MCP, registry MCP, sandbox | Contain secrets or shell mutations |
| `skills/runbook-executor/` | SKILL.md: classify → plan → execute → verify → undo | Markdown | k8s MCP | Trust runbook wording for step class |
| `agents/*.json` | Agent specs: model, instructions, MCP servers, `enable_tools`, `require_approval_for_tools`, skills, sandbox | JSON | skills, MCP names | Use `@destructive` without explicit names |
| `mcp/registry/` | `check_version_exists`, `build_info`, `publish_package` (destructive) | Python, FastMCP | TestPyPI token in `.env` | Run inside the sandbox |
| `mcp/k8s/` | `get_status`, `get_metrics`, `set_flag`, `scale` (reversible), `deploy`, `rollback`, `restart` (destructive), `lock/unlock` | Python, FastMCP | kubeconfig for kind | Expose `delete_namespace` or raw `kubectl` |
| `orchestrator/` | Label polling, session start, approval relay, `approvals.log`, handoff JSON parsing | TypeScript | `@truefoundry/trueforge-sdk` | Make release/deploy decisions |
| `runbooks/` | Human-written runbooks (`deploy.md`, `incident-high-latency.md`) | Markdown | — | Reference tools that don't exist |
| `scripts/` | `setup_agents.ts` (upsert agents), `reset.sh` (reset repo/cluster), `check.py` (oracle) | TS / Bash / Python | GitHub API, TestPyPI, kubectl | Be called by agents |
| `tests/mcp/` | pytest for our MCP servers | Python | mcp/* | Hit real TestPyPI (use dry-run flag) |
| `tests/scenarios/` | `RC-*.yaml`, `RE-*.yaml`: setup, chaos, expected approvals, expected end state | YAML | scripts/check.py | — |
| `.claude/rules/` | Path-scoped rules for Claude Code | Markdown | — | Duplicate CLAUDE.md |

External repo: **`tinyshop`** (public GitHub) — the code being released. Seeded with tag `v1.3.0`, conventional-commit PRs,
one test-breaking PR, one flaky test, one high-risk untested change.

## Agents
| Agent | MCP servers (enable_tools) | Gated by name | Sandbox | Skill | Handoff label |
| --- | --- | --- | --- | --- | --- |
| release-captain | github (repos, pull_requests, git, issues-comment), registry | `create_tag`/release tool, `publish_package`, `merge_pull_request` | on | release-captain | `needs-release → ready-to-deploy` |
| runbook-executor | k8s (all), github (read + comment) | `deploy`, `rollback`, `restart`, `add_issue_comment` | on (for skills) | runbook-executor | `ready-to-deploy → deployed / rolled-back` |

## Data flow — release
1. Orchestrator sees `needs-release` → creates session for `release-captain`.
2. Agent: last tag + commit range (GitHub MCP) → pin SHA → sandbox clone/test ×2/build → notes + risk.
3. Evidence card → **Gate 1** `create_tag` → **Gate 2** `publish_package` → GitHub Release.
4. Final JSON → orchestrator flips label, logs approvals.

## Dependency rules
- Only `mcp/*` and the GitHub MCP hold credentials. `orchestrator/` holds only the TrueForge URL.
- `skills/` may name MCP tools but never embed tokens, URLs with secrets, or shell commands that mutate remote state.
- Adding a mutating tool = update agent JSON gate list + a scenario YAML + `MEMORY.md` line.
