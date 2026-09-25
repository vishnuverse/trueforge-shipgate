# CLAUDE.md — trueforge-shipgate

Hackathon project for TrueFoundry "Agents That Act" (Sat 26 Sep 2026, build window 12:00–19:00 IST).
Agents run on **TrueForge** (open-source agent harness). Primary agent: **Ticket Resolver**. Next: **Runbook Executor**. Optional: **Release Captain**.

Read first: `SPEC.md` (what we build) → `IMPLEMENTATION_PLAN.md` (phases, who does what) → `HANDOVER.md` (where we are) → `AGENTS.md` (repo map).
Decisions and learned facts live in `MEMORY.md`. Path-specific rules load from `.claude/rules/`.

## Non-negotiable hackathon rules

> [!IMPORTANT]
> **Organisers' submission checklist** (full table at the top of `README.md`):
> 1. **Qualifying test:** an agent on TrueForge with the harness visibly working (real tool reached, code run in the sandbox, pause before anything irreversible). If it would work as well as a text box, it doesn't qualify.
> 2. **One job, finished.** One narrow task end to end beats three half-built features.
> 3. **Film the approval moment:** show where the code ran and the agent stopping to ask.
> 4. **Public repo, README works on another laptop,** AI assistants named.
> 5. **Only our own accounts, data and keys.** No keys in the repo, screenshots or demo video.
>
> **Scoring (100):** harness doing the work **30** (qualifying; a prompt with a wrapper scores ~0) · it actually runs **25** · where it stops **20** · a job worth handing over **15** · demo clarity **10**. Details in `README.md` → Judging.

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
5. **Orchestrator never decides.** It starts sessions, relays approvals and parses the final JSON handoff block. Judgement stays in the agent + skill.
6. MCP servers we write run on the TrueForge host (localhost), speak streamable HTTP, and set `readOnlyHint` / `destructiveHint` on every tool.
7. **Target repo = fork `vishnuverse/humanize`; its `main` is protected by a ruleset with no bypass** (PR required, no direct or force push). Agents never get `merge_pull_request` or `issue_write`, and always pass `owner=vishnuverse, repo=humanize` (never the upstream `python-humanize`).
8. **Clone with full history and tags** (`git fetch --tags`, never `--depth`). The version comes from git tags (hatch-vcs); a shallow or tagless clone builds as `0.1.dev1`.

## Layout (short — full map in AGENTS.md)
```
skills/            git-backed TrueForge skills (SKILL.md per agent)
agents/            agent specs (JSON) registered via API
mcp/k8s/           FastMCP wrapper over kubectl for kind (P1)
mcp/registry/      FastMCP server: TestPyPI publish, token server-side (optional)
orchestrator/      TypeScript, @truefoundry/trueforge-sdk: sessions + approvals
demo-app/          tiny web app over humanize that Runbook Executor deploys to kind (P1)
runbooks/          human-written runbooks (markdown)
scripts/           setup, reset, check (test oracle)
tests/             pytest for MCP servers + scenario specs (TR-*, RE-*, RC-*)
```

## Setup (once)
```bash
node -v                      # need >= 22.14
python3 -V                   # 3.12
cp .env.example .env         # fill keys; never commit .env
npx @truefoundry/trueforge@0.2.1            # UI + API on http://localhost:8790
uv sync                                       # python deps for mcp/ and scripts/
npm --prefix orchestrator install
```
Configure in TrueForge UI (Settings): model provider, GitHub MCP
(`https://api.githubcopilot.com/mcp/`, header `Authorization: Bearer $GITHUB_PAT`), custom MCPs below.
Sandbox: nothing to configure for the built-in local sandbox; for the demo add Daytona under Sandbox providers
(key needs Snapshot-create).

## Run
```bash
kind create cluster --name shipgate           # P1 only
uv run mcp/k8s/server.py                      # :8801  k8s MCP (P1; needs kind cluster)
uv run mcp/registry/server.py                 # :8802  registry MCP (optional, Release Captain only)
npx tsx scripts/setup_agents.ts               # upsert agents from agents/*.json
npm --prefix orchestrator run start           # polls labels, runs agents, prompts approvals in terminal
```

## Test
```bash
uv run pytest tests/mcp -q                    # unit tests for our MCP servers
bash scripts/reset.sh                         # reset vishnuverse/humanize issues/PRs/branches + cluster
uv run python scripts/check.py TR-01          # assert final GitHub/cluster state for one scenario
uv run python scripts/check.py --all          # every scenario in tests/scenarios/*.yaml
```
Always run `reset.sh` before a scenario. A scenario passes only if `check.py` prints PASS and `approvals.log`
matches the scenario's expected approvals list exactly.

## Conventions
- Python 3.12, FastMCP, `ruff` format; TypeScript strict, `tsx` to run.
- TrueForge versions are pinned exactly: server `@truefoundry/trueforge@0.2.1`, SDK `@truefoundry/trueforge-sdk@0.2.0`
  (`npm i --save-exact`, no `^`). Bump only on purpose, and change every doc that names the version.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`) — Release Captain relies on them.
- Every agent ends its final message with one fenced ```json handoff block (schema in SPEC.md §7).
- Secrets only via `.env`; `.env.example` lists names, never values.
- Keep skills short and procedural; put domain rules in `.claude/rules/` for us, in `skills/*/SKILL.md` for the agent.

## When working in this repo
- Before coding: check `HANDOVER.md`; after a work block: update it (done / blocked / next).
- New architectural decision → one line in `MEMORY.md` with date and reason.
- Adding a tool that mutates anything → add it to the agent's `require_approval_for_tools` list AND a scenario test.
  Only exception: `create_branch` / `push_files` to `fix/*`, safe because the `main` ruleset has no bypass.
- Do not add features outside SPEC.md scope during the event. Narrow and working beats broad and broken.
- Demo time matters: never leave Daytona sandboxes running; pause schedules unless demoing.
