# SPEC.md — shipgate

## 1. Problem
Releases and routine ops stall on humans doing mechanical work (reading commits, rerunning tests, writing notes,
following runbooks), while the few truly risky actions get rubber-stamped. Existing tools are either fully automatic
(semantic-release), gate on a PR merge rather than the exact artifact (release-please, changesets), or only
suggest (most AI SRE tools).

**shipgate** hands the mechanical work to TrueForge agents and puts a human gate — with evidence — on exactly the
irreversible steps.

## 2. Scope
| Priority | Agent | Theme text |
| --- | --- | --- |
| P0 | Release Captain | Read commits since the last tag, run tests in a sandbox, write release notes. Reaches GitHub and a package registry. Approval: tagging and publishing. |
| P1 (stretch) | Runbook Executor | Execute a human-written runbook step by step, reversible steps automatically. Reaches your infrastructure. Approval: every destructive step. |
| P2 (only with 4 people) | Ticket Resolver | Reproduce a bug in a sandbox, return a patch + draft reply or "could not reproduce". |

Out of scope: custom chat UI (use TrueForge UI / Generative UI), multi-repo, real cloud accounts, hosted mode.

## 3. Real systems
- **GitHub**: public demo repo `tinyshop` (Python 3.12 + pytest), seeded tags/PRs. Via GitHub remote MCP.
- **TestPyPI**: package `shipgate-tinyshop`. Via our `registry` MCP (token held server-side).
- **kind cluster** `shipgate` (stretch): deployment `api`, `worker`, ConfigMap `flags`. Via our `k8s` MCP.
- **Sandbox**: Daytona via TrueForge. No credentials inside.

## 4. Release Captain requirements
| # | Requirement |
| --- | --- |
| C1 | Trigger: manual, `needs-release` label, or weekly schedule (schedule = dry run, never gates). |
| C2 | Last tag = highest semver tag reachable from `main`; ignore `-rc.N` unless pre-release; no tags → propose `v0.1.0` and ask. |
| C3 | Range = `git log <last_tag>..HEAD`; every commit appears in notes (else under "Other"). |
| C4 | Pin HEAD SHA at start; test/tag/publish only that SHA; drift → abort. |
| C5 | Fresh sandbox clone at SHA; full test suite run twice; both green. |
| C6 | `python -m build`; install wheel in clean venv; import smoke test. |
| C7 | Semver: breaking → major (minor if <1.0); `feat` → minor; `fix`/`perf` → patch; only docs/chore/ci → no release. |
| C8 | Notes: Breaking (with migration), Features, Fixes, Other; every line cites PR/commit; contributors; test evidence. |
| C9 | Gate 1 `create_tag(name, sha)` — prompt shows tag, SHA, commit count, test runs, bump reason. |
| C10 | Gate 2 `publish_package(version)` — prompt shows package, version, registry, files + sha256. |
| C11 | Order: tag → publish → GitHub Release. Publish only if tag points at pinned SHA. |
| C12 | Abort on red/flaky tests, version exists in registry, tag exists, SHA drift, or any deny. No further changes. |
| C13 | Never force-push, delete/move tags, re-publish a version, publish untagged SHA. |
| C14 | Done: tag on tested SHA, package on TestPyPI, GitHub Release with notes, CHANGELOG updated, handoff JSON, label `ready-to-deploy`. |

Differentiators to show: risk score per PR (migrations/auth/deps/untested files), flaky-test triage, evidence card
(Generative UI) before each gate, deny-with-reason → agent revises → approve.

## 5. Runbook Executor requirements (stretch)
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

## 6. Handoff contract
Each agent's final message ends with exactly one fenced JSON block:
```json
{"stage": "release|deploy|resolve", "status": "ok|aborted|failed|noop",
 "repo": "owner/tinyshop", "sha": "…", "version": "1.3.1",
 "release_url": "…", "prs": [12, 14], "approvals": [{"tool": "create_tag", "decision": "allow"}],
 "reason": "one line"}
```
Orchestrator parses only this block. Labels: `needs-release → ready-to-deploy → deployed` (or `rolled-back`).

## 7. Constraints
- 7-hour build window; team ≤ 4; nothing pre-built; AI use disclosed.
- TrueForge local mode on localhost only (no login). Remote (HTTP/SSE) MCP servers only.
- Schedules minimum hourly; scheduled runs must not reach a gate.
- Cost: OpenAI credits provided; report tokens/cost per run in demo.

## 8. Acceptance (demo-ready)
- RC-01, RC-03, RC-05, RC-12, RC-14 pass via `scripts/check.py`.
- One full live run: commits → sandbox tests → notes → evidence card → deny once → revise → approve tag → approve
  publish → package visible on TestPyPI.
- README runs on a fresh laptop.
- Stretch: RE-01, RE-02, RE-03 pass on kind.

## 9. Scenario IDs
Full test tables live in README.md (RC-01…RC-18, RE-01…RE-18, E2E-01…E2E-09). Machine-readable versions go in
`tests/scenarios/<ID>.yaml` (setup, chaos, expected approvals, expected end state).
