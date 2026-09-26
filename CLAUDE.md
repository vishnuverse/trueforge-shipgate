# CLAUDE.md — trueforge-shipgate

Hackathon project for TrueFoundry "Agents That Act" (Sat 26 Sep 2026, build window 12:00–19:00 IST).
Agents run on **TrueForge** (open-source agent harness). Primary agent: **Ticket Resolver**. Next: **Runbook Executor**. Optional: **Release Captain**.

Read first: `README.md` (what it is, how to run) → `docs/SPEC.md` (design) → `docs/HANDOVER.md` (where we are) →
`AGENTS.md` (repo map) → `docs/contracts.md` (interfaces between skill, orchestrator and scorer).
Decisions and learned facts live in `docs/MEMORY.md`. Doc index: `docs/README.md`. Path-specific rules load from `.claude/rules/`.

## Non-negotiable hackathon rules

> [!IMPORTANT]
> **Organisers' submission checklist** (full table at the top of `README.md`):
> 1. **Qualifying test:** an agent on TrueForge with the harness visibly working (real tool reached, code run in the sandbox, pause before anything irreversible). If it would work as well as a text box, it doesn't qualify.
> 2. **One job, finished.** One narrow task end to end beats three half-built features.
> 3. **Film the approval moment:** show where the code ran and the agent stopping to ask.
> 4. **Public repo, README works on another laptop,** AI assistants named.
> 5. **Only our own accounts, data and keys.** No keys in the repo, screenshots or demo video.
>
> **Scoring (100):** harness doing the work **30** (qualifying; a prompt with a wrapper scores ~0) · it actually runs **25** · where it stops **20** · a job worth handing over **15** · demo clarity **10**. Details in `docs/research-and-plan.md` → Judging.

- TrueForge must do the work: agent loop, MCP tool calls, sandbox runs and approval holds. No custom agent loop.
- Reach a **real system** (GitHub; Jira optional; local kind cluster; TestPyPI only for Release Captain). **No mocks** of the target system.
- Code the agent writes runs in a **TrueForge sandbox**: the built-in local sandbox while building (automatic with `npx`
  when no Daytona key is set), **Daytona** for scenario runs and the demo once the key arrives. 0.2.1 has no Docker or
  Kubernetes sandbox.
- Every action other people see or that can't be undone stops for a human: opening a PR, replying on a ticket, deploy, rollback, tagging, publishing, delete.
- Nothing built before 12:00 on the day. Disclose AI assistance in README.

## Architecture boundaries (do not cross)
1. **Sandbox holds no credentials.** No GitHub push token, no TestPyPI token, no kubeconfig in the sandbox. It only clones public code and runs tests/builds.
   The built-in local sandbox runs on this Mac. In our test it could not read `~/Documents` (so not this repo's `.env`) or
   the keychain, but it is still the host: use it for building, Daytona for the demo.
2. **Only MCP tools touch real systems.** Branch, PR and comment = GitHub MCP (Jira replies = Jira MCP). Infra = `k8s` MCP. Publish = our `registry` MCP (optional). Never shell out from the sandbox to mutate anything.
3. **Gated tools are listed by name** in `require_approval_for_tools`. Never rely on `@destructive` alone — unannotated tools run ungated.
4. **Pinned SHA.** Ticket Resolver reproduces, patches and branches from one pinned `main` SHA; Release Captain tests, tags and publishes the same commit. SHA drift = abort.
5. **Orchestrator never decides.** It starts sessions, relays approvals and parses the final JSON handoff block. Its only
   other message is a fixed, capped (2) "continue" nudge when a turn ends with no gate and no handoff (SPEC §4.5).
   Judgement stays in the agent + skill.
6. MCP servers we write run on the TrueForge host (localhost), speak streamable HTTP, and set `readOnlyHint` / `destructiveHint` on every tool.
7. **Target repo = fork `vishnuverse/humanize`; its `main` is protected by a ruleset with no bypass** (PR required, no direct or force push). Agents never get `merge_pull_request` or `issue_write`, and always pass `owner=vishnuverse, repo=humanize` (never the upstream `python-humanize`).
8. **Clone with full history and tags** (`git fetch --tags`, never `--depth`). The version comes from git tags (hatch-vcs); a shallow or tagless clone builds as `0.1.dev1`.

## Layout (short — full map in AGENTS.md)
```
skills/ticket-resolver/  SKILL.md: the agent's procedure (delivered inline; repo is private)
agents/                  agent specs (JSON), registered by scripts/setup_agents.ts
orchestrator/            TypeScript on @truefoundry/trueforge-sdk: sessions, approvals (ui/terminal/script), run dirs, labels
scripts/                 setup_agents.ts, check.py + shipgate_check/ (oracle, scorecard), reset.sh, score.sh, bakeoff.py
tests/                   scenarios/TR-*.yaml, check/ (scorer unit tests), fixtures/ (TrueForge events, humanize issues)
docs/                    SPEC, contracts, HANDOVER, MEMORY, plan, reference notes (index: docs/README.md)
```
Planned, not built yet: `mcp/k8s/` + `runbooks/` + `demo-app/` (Runbook Executor, P1), Triage MCP on TypeSafe, `mcp/registry/`.

## Setup (once)
```bash
node -v                      # need >= 22.14
python3 -V; uv --version     # 3.12 via uv
cp .env.example .env         # fill keys; never commit .env
SERVER_EXECUTION_TIMEOUT_SECONDS=1200 npx --yes @truefoundry/trueforge@0.2.1   # UI + API on :8790; turn limit 20 min
uv sync                                       # python deps for scripts/
npm --prefix orchestrator ci
```
Configure in TrueForge UI (Settings), keys pasted by a human:
- Models → Add Custom Provider `openrouter`: base URL `https://openrouter.ai/api/v1`, model `deepseek-v4-flash` =
  `deepseek/deepseek-v4-flash` (fallback `glm-5-3-flash` = `z-ai/glm-5.3-flash`).
- Connectors → `github` (`https://api.githubcopilot.com/mcp/`, header `Authorization: Bearer <GITHUB_PAT>`).
- Sandbox: nothing for the built-in local sandbox; for the demo add Daytona under Sandbox providers (Snapshot-create).

## Run
```bash
npx --yes tsx scripts/setup_agents.ts --inline-skill                     # upsert agents/*.json with SKILL.md inlined
npm --prefix orchestrator run shipgate -- run --issue 1 --approve terminal   # or --approve ui (approve in the TrueForge UI)
```

## Test
```bash
uv run pytest tests/check -q                  # scorer unit tests
npm --prefix orchestrator test                # orchestrator unit tests (+ run typecheck)
scripts/reset.sh                              # dry run: what would be reset on vishnuverse/humanize (--yes to apply)
scripts/score.sh TR-01                        # reset → run in script mode → check.py TR-01
uv run python scripts/check.py --all          # every scenario's grade saved at run time + scorecard (--regrade = live)
```
A scenario passes only if `check.py` prints no FAIL; it checks events, `approvals.jsonl` and the real GitHub state.

## Conventions
- Python 3.12, `ruff` format (line length 110); TypeScript strict, `tsx` to run.
- TrueForge versions are pinned exactly: server `@truefoundry/trueforge@0.2.1`, SDK `@truefoundry/trueforge-sdk@0.2.0`
  (`npm i --save-exact`, no `^`). Bump only on purpose, and change every doc that names the version.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`) — Release Captain relies on them.
- Every agent ends its final message with one fenced ```json handoff block (schema in docs/SPEC.md §7).
- Secrets only via `.env`; `.env.example` lists names, never values.
- Keep skills short and procedural; put domain rules in `.claude/rules/` for us, in `skills/*/SKILL.md` for the agent.

## When working in this repo
- Before coding: check `docs/HANDOVER.md`; after a work block: update it (done / blocked / next).
- New architectural decision → one line in `docs/MEMORY.md` with date and reason.
- Adding a tool that mutates anything → add it to the agent's `require_approval_for_tools` list AND a scenario test.
  Only exception: `create_branch` / `push_files` to `fix/*`, safe because the `main` ruleset has no bypass.
- Do not add features outside docs/SPEC.md scope during the event. Narrow and working beats broad and broken.
- Demo time matters: never leave Daytona sandboxes running; pause schedules unless demoing.
