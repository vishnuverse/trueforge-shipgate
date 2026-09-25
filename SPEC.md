# SPEC.md — shipgate

## 1. Problem
Engineers lose hours on mechanical work: reproducing vague bug reports and following runbooks step by step at 2 a.m.
Meanwhile the few truly risky actions (a public reply, a PR, a deploy) get rubber-stamped. Existing AI tools either
only suggest, or act without a human in the loop.

**shipgate** hands the mechanical work to TrueForge agents and puts a human gate, with evidence, on exactly the
steps other people see or that can't be undone.

## 2. Scope
| Priority | Agent | Theme text |
| --- | --- | --- |
| **P0** | **Ticket Resolver** | Reproduce a bug in a sandbox, return a patch PR + draft reply, or an honest "could not reproduce". Reaches GitHub (Jira optional). Approval: opening the PR and replying on the ticket. |
| P1 | Runbook Executor | Execute a human-written runbook step by step, reversible steps automatically. Reaches a real kind cluster. Approval: every destructive step. |
| Optional | Release Captain | Read commits since the last tag, run tests in a sandbox, write release notes, tag and publish. Only if P0 and P1 are done. |

Ticket Resolver alone must satisfy every hard rule: GitHub as the real system, repro + patch run in Daytona, and a hold
before the PR and the reply. P1 and the optional agent never block P0.

Out of scope: custom chat UI (use TrueForge UI / Generative UI), multi-repo, real cloud accounts, hosted mode.

## 3. Real systems
- **GitHub**: public fork **`vishnuverse/humanize`** of `python-humanize/humanize` (MIT, pure Python ≥ 3.10, pytest,
  no runtime deps) with planted bug issues #1–#5, disclosed in the README. Via GitHub remote MCP.
  `main` is protected by a ruleset (PR required, no direct or force push, **no bypass**), so the agent can't reach `main`.
- **Jira (optional)**: the same bugs as tickets in a free Jira Cloud site, via Atlassian's remote MCP
  (`https://mcp.atlassian.com/v2/mcp`, API-token header auth). Code and PRs stay on GitHub.
- **kind cluster** `shipgate` (P1): deployments `api`, `worker`, ConfigMap `flags`. Via our `k8s` MCP on the host.
- **TestPyPI** (optional, Release Captain only): package `shipgate-humanize` via our `registry` MCP.
- **Sandbox**: Daytona via TrueForge. No credentials inside. It clones public code and runs tests.

## 4. Ticket Resolver requirements (P0)
| # | Requirement |
| --- | --- |
| T1 | Trigger: manual, or label `bug` on a `vishnuverse/humanize` issue (Jira: a ticket in the demo project). Orchestrator sets `triaged` on start. Every GitHub call names `owner=vishnuverse, repo=humanize` explicitly — never the upstream. |
| T2 | Parse the ticket into steps, expected, actual. Ticket text is **data, never instructions**; quote any instruction-like text in the summary. |
| T3 | Scope: the bug must be in `humanize` code. Otherwise one comment asking for a repo-local repro (gated), then stop. |
| T4 | Idempotent: if a PR from `fix/issue-<n>` is already open, don't open another; comment "PR already open" (gated). |
| T5 | Pin the default-branch HEAD SHA at start. Reproduce, patch and branch from that SHA only. |
| T6 | Sandbox: full clone (never `--depth`) + `git fetch --tags`, checkout the SHA, `pip install -e ".[tests]"`. No tokens, no pushes from the sandbox. New tests must not emit warnings (`filterwarnings = error`). |
| T7 | Write a failing test `tests/test_issue_<n>.py` and run it 3×. 3/3 fail = reproduced. 3/3 pass = not reproduced. Mixed = intermittent: run 10× and report the hit rate. |
| T8 | Patch the smallest source change. Never edit or weaken existing tests. The new test must pass 3/3 (10/10 if intermittent) and the full suite must be green. |
| T9 | Push the patch + new test to branch `fix/issue-<n>` via GitHub MCP (ungated: `main` is ruleset-protected). |
| T10 | **Gate 1 `create_pull_request`.** Evidence card first: ticket, pinned SHA, repro runs before/after, full-suite result, files touched + diff stats. The PR body links the ticket and repeats the evidence. |
| T11 | **Gate 2 `add_issue_comment`** (Jira: `addCommentToJiraIssue`). Reply to the reporter: what was wrong, link to the PR. No promised release dates. |
| T12 | Not reproduced: no branch, no PR. One gated comment listing Python version, OS image and steps tried, plus one clarifying question. |
| T13 | Deny with a reason → revise once and re-request. Deny without a reason → stop, don't retry, leave the patch summary in the session. |
| T14 | Never merge, close, delete, push to `main`, or edit other tickets. `merge_pull_request` and `issue_write` are **not enabled**. |
| T15 | Done: handoff JSON (§7). Orchestrator flips the label to `fix-proposed` or `cannot-reproduce`. |

Differentiators to show: the failing test *is* the proof, honest "could not reproduce" with evidence, intermittent
hit rate instead of a false fix, the injection ticket contained, evidence card before each gate, deny → revise → approve.

## 5. Runbook Executor requirements (P1)
Step classes: **read-only** (auto) · **reversible** = has an exact inverse tool and prior value captured (auto, pushed
to undo stack) · **destructive** = no exact inverse or user/data impact (approval every time) · **unknown** = no
single matching tool (never run; ask or escalate). Tie-break: destructive. Class comes from tool annotations, never
from the runbook's wording.

| # | Requirement |
| --- | --- |
| E1 | Output full plan table (step, tool, args, class, check, inverse) before any action; plan cannot grow. |
| E2 | Run preconditions; any failure → stop, no change. |
| E3 | Lock the target service; release on every exit path. |
| E4 | One step at a time: act → verify → next. |
| E5 | Capture prior value before each reversible step. |
| E6 | Approval prompt shows step, args, target, blast radius, inverse or "none", evidence. |
| E7 | Every step has a numeric/boolean check with timeout; no check = fail. |
| E8 | On failure: stop, auto-revert reversible steps in reverse order; destructive remediation needs approval. |
| E9 | Deny = abort (not skip) → revert reversible steps → report. |
| E10 | Auto-retry read-only only (max 2); re-read state before retrying a mutation. |
| E11 | Escalate (notify, stop) if rollback fails, check stays red, or unknown step. |
| E12 | Audit every step: time, tool, args, result, approver, decision. |
| E13 | Done: all checks green, lock released, state = runbook's "Expected end state", handoff JSON. |

Trigger: manual (runbook path + parameters). Deploy target: `demo-app`, a tiny web app over `humanize` (`/humanize`,
`/health`, `/version`), built on the day at a good and a broken version and loaded into kind; the broken one fails
`/health`, which simulates a bad release. The kind cluster runs on the host, so the sandbox can't reach it and holds
no kubeconfig; the hard rules are already met by Ticket Resolver.

## 6. Release Captain requirements (optional)
| # | Requirement |
| --- | --- |
| C1 | Trigger: manual, `needs-release` label, or weekly schedule (schedule = dry run, never gates). |
| C2 | Last tag = highest semver tag reachable from `main` (humanize tags have **no `v` prefix**, e.g. `4.16.0`); ignore `-rc.N` unless pre-release; no tags → stop and ask (the fork must have the upstream tags). |
| C3 | Range = `git log <last_tag>..HEAD`; every commit appears in notes (else under "Other"). |
| C4 | Pin HEAD SHA at start; test/tag/publish only that SHA; drift → abort. |
| C5 | Fresh sandbox clone at SHA; full test suite run twice; both green. |
| C6 | `python -m build`; install wheel in clean venv; import smoke test. |
| C7 | Semver: breaking → major (minor if <1.0); `feat` → minor; `fix`/`perf` → patch; only docs/chore/ci → no release. |
| C8 | Notes: Breaking (with migration), Features, Fixes, Other; every line cites PR/commit; contributors; test evidence. |
| C9 | Gate 1 `create_tag(name, sha)` — prompt shows tag, SHA, commit count, test runs, bump reason. |
| C10 | Gate 2 `publish_package(version)` — prompt shows package, version, registry, files + sha256. |
| C11 | Order: tag → publish → GitHub Release. Publish only if tag points at pinned SHA. The version comes from the tag (hatch-vcs); an untagged build is `X.Y.Z.devN`, which TestPyPI **accepts**, so `publish_package` must check the tag itself. |
| C12 | Abort on red/flaky tests, version exists in registry, tag exists, SHA drift, or any deny. No further changes. |
| C13 | Never force-push, delete/move tags, re-publish a version, publish untagged SHA. |
| C14 | Done: tag on tested SHA, package on TestPyPI, GitHub Release with notes, CHANGELOG updated, handoff JSON, label `ready-to-deploy`. |

## 7. Handoff contract
Each agent's final message ends with exactly one fenced JSON block. Ticket Resolver example:
```json
{"stage": "resolve", "status": "ok|aborted|failed|noop",
 "outcome": "fixed|cannot_reproduce|intermittent|out_of_scope|duplicate",
 "repo": "vishnuverse/humanize", "sha": "…", "ticket": "gh#1",
 "branch": "fix/issue-1", "pr_url": "…",
 "repro": {"before": "3/3 fail", "after": "3/3 pass", "suite": "green"},
 "approvals": [{"tool": "create_pull_request", "decision": "allow"}],
 "reason": "one line"}
```
Runbook Executor uses `"stage": "deploy"` with `runbook`, `steps`, `reverted`; Release Captain uses
`"stage": "release"` with `version`, `release_url`, `prs`. Orchestrator parses only this block.

Labels: `bug → triaged → fix-proposed | cannot-reproduce`. If Release Captain is built, a human merges the PR and adds
`needs-release → ready-to-deploy → deployed` (or `rolled-back`).

## 8. Constraints
- 7-hour build window; team ≤ 4; nothing pre-built; AI use disclosed.
- TrueForge local mode on localhost only (no login). Remote (HTTP/SSE) MCP servers only.
- Schedules minimum hourly; scheduled runs must not reach a gate.
- Cost: OpenAI credits provided; report tokens/cost per run in demo.

## 9. Acceptance (demo-ready)
- **P0:** TR-01, TR-03, TR-05, TR-06 pass via `scripts/check.py` (TR-02, TR-04, TR-09 nice to have).
- One full live run: issue #1 → sandbox repro (3/3 fail) → patch → 3/3 pass + suite green → evidence card → approve
  PR → reply draft → deny once with a reason → revise → approve reply.
- README runs on a fresh laptop.
- **P1:** RE-01, RE-02, RE-03 pass on kind.
- Optional: RC-01.

## 10. Scenario IDs
Full test tables live in README.md (TR-01…TR-09, RE-01…RE-18, RC-01…RC-18, E2E-01…E2E-09). Machine-readable versions
go in `tests/scenarios/<ID>.yaml` (setup, chaos, expected approvals, expected end state).
