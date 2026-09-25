# CLAUDE.md — trueforge-shipgate

Hackathon project for TrueFoundry "Agents That Act" (Sat 26 Sep 2026, build window 12:00–19:00 IST).
Agents run on **TrueForge** (open-source agent harness). Primary agent: **Release Captain**. Stretch: **Runbook Executor**.

Read first: `SPEC.md` (what we build) → `IMPLEMENTATION_PLAN.md` (phases, who does what) → `HANDOVER.md` (where we are) → `AGENTS.md` (repo map).
Decisions and learned facts live in `MEMORY.md`. Path-specific rules load from `.claude/rules/`.

## Non-negotiable hackathon rules
- TrueForge must do the work: agent loop, MCP tool calls, sandbox runs and approval holds. No custom agent loop.
- Reach a **real system** (GitHub, TestPyPI, local kind cluster). **No mocks** of the target system.
- Code the agent writes runs in the **Daytona sandbox** (the only sandbox TrueForge supports).
- Every destructive action stops for a human: tagging, publishing, deploy, rollback, delete.
- Nothing built before 12:00 on the day. Disclose AI assistance in README.

## Architecture boundaries (do not cross)
1. **Sandbox holds no credentials.** No GitHub push token, no TestPyPI token, no kubeconfig in the sandbox. It only clones public code and runs tests/builds.
2. **Only MCP tools touch real systems.** Tag = GitHub MCP. Publish = our `registry` MCP. Infra = `k8s` MCP. Never shell out from the sandbox to mutate anything.
3. **Gated tools are listed by name** in `require_approval_for_tools`. Never rely on `@destructive` alone — unannotated tools run ungated.
4. **Pinned SHA.** Test, tag and publish the same commit. SHA drift = abort.
5. **Orchestrator never decides.** It starts sessions, relays approvals and parses the final JSON handoff block. Judgement stays in the agent + skill.
6. MCP servers we write run on the TrueForge host (localhost), speak streamable HTTP, and set `readOnlyHint` / `destructiveHint` on every tool.

## Layout (short — full map in AGENTS.md)
```
skills/            git-backed TrueForge skills (SKILL.md per agent)
agents/            agent specs (JSON) registered via API
mcp/registry/      FastMCP server: TestPyPI publish (token server-side)
mcp/k8s/           FastMCP wrapper over kubectl for kind (stretch)
orchestrator/      TypeScript, @truefoundry/trueforge-sdk: sessions + approvals
runbooks/          human-written runbooks (markdown)
scripts/           setup, reset, check (test oracle)
tests/             pytest for MCP servers + scenario specs (RC-*, RE-*)
```

## Setup (once)
```bash
node -v                      # need >= 22.14
python3 -V                   # 3.12
cp .env.example .env         # fill keys; never commit .env
npx @truefoundry/trueforge@latest            # UI + API on http://localhost:8790
uv sync                                       # python deps for mcp/ and scripts/
npm --prefix orchestrator install
```
Configure in TrueForge UI (Settings): model provider, Daytona sandbox (key needs Snapshot-create), GitHub MCP
(`https://api.githubcopilot.com/mcp/`, header `Authorization: Bearer $GITHUB_PAT`), custom MCPs below.

## Run
```bash
uv run mcp/registry/server.py                 # :8802  registry MCP
uv run mcp/k8s/server.py                      # :8801  k8s MCP (stretch; needs kind cluster)
kind create cluster --name shipgate           # stretch only
npx tsx scripts/setup_agents.ts               # upsert agents from agents/*.json
npm --prefix orchestrator run start           # polls labels, runs agents, prompts approvals in terminal
```

## Test
```bash
uv run pytest tests/mcp -q                    # unit tests for our MCP servers
bash scripts/reset.sh                         # reset tinyshop repo state + cluster
uv run python scripts/check.py RC-01          # assert final GitHub/registry/cluster state for one scenario
uv run python scripts/check.py --all          # every scenario in tests/scenarios/*.yaml
```
Always run `reset.sh` before a scenario. A scenario passes only if `check.py` prints PASS and `approvals.log`
matches the scenario's expected approvals list exactly.

## Conventions
- Python 3.12, FastMCP, `ruff` format; TypeScript strict, `tsx` to run.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`) — Release Captain relies on them.
- Every agent ends its final message with one fenced ```json handoff block (schema in SPEC.md §5).
- Secrets only via `.env`; `.env.example` lists names, never values.
- Keep skills short and procedural; put domain rules in `.claude/rules/` for us, in `skills/*/SKILL.md` for the agent.

## When working in this repo
- Before coding: check `HANDOVER.md`; after a work block: update it (done / blocked / next).
- New architectural decision → one line in `MEMORY.md` with date and reason.
- Adding a tool that mutates anything → add it to the agent's `require_approval_for_tools` list AND a scenario test.
- Do not add features outside SPEC.md scope during the event. Narrow and working beats broad and broken.
- Demo time matters: never leave Daytona sandboxes running; pause schedules unless demoing.
