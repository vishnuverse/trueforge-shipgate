# MEMORY.md — decisions and learned facts

Long-lived project memory. Append one line per decision/fact: date · decision/fact · reason/source.
Never delete; mark superseded lines with ~~strikethrough~~ and add the replacement below.

## Architecture decisions
- 2026-09-25 · Primary agent = Release Captain; Runbook Executor stretch; Ticket Resolver only with 4 people · judging rewards narrow + working (25 pts) and harness-visible work (30 pts).
- 2026-09-25 · GitHub (issues, PRs, labels, tags) is the handoff bus between agents · no direct agent-to-agent calls; state is visible and demoable.
- 2026-09-25 · Chaining via a small TS orchestrator on `@truefoundry/trueforge-sdk`, not subagents · TrueForge subagents are dynamic, one level deep, can't call saved agents.
- 2026-09-25 · Sandbox holds zero credentials; all mutations go through MCP tools · approvals gate MCP calls only; shell in sandbox would bypass gates.
- 2026-09-25 · Publish via our own `registry` FastMCP server holding the TestPyPI token · lets `publish_package` be a named, gated tool.
- 2026-09-25 · Gated tools listed by name in `require_approval_for_tools` · unannotated MCP tools run ungated under `@destructive`/`@write`.
- 2026-09-25 · Test, tag and publish a single pinned SHA · approval must bind to the exact artifact, not a PR merge.
- 2026-09-25 · ~~`mock-infra` JSON-state MCP~~ → real local kind cluster behind a `k8s` MCP · hackathon forbids mocks.
- 2026-09-25 · Registry = TestPyPI (+ optional GHCR image) · free; real no-re-upload semantics make RC-14 realistic.
- 2026-09-25 · Every agent ends with one fenced JSON handoff block (SPEC §6) · orchestrator never parses prose.
- 2026-09-25 · Test repo stays `tinyshop` (small Python + pytest); FFmpeg / ffmpeg-based repos rejected · build and test time too long for 2 runs per release in a 7-hour window; keep it simple.

## Learned facts (TrueForge)
- Local mode: `npx @truefoundry/trueforge@latest`, :8790, SQLite, no login — localhost only. Node >= 22.14. (trueforge.dev/quickstart)
- Sandbox provider: Daytona only; key needs Snapshot-create or config fails. (trueforge.dev/sandbox)
- MCP: remote HTTP/SSE only; auth none / header / OAuth DCR. stdio servers need a bridge (e.g. supergateway). (trueforge.dev/mcp-servers)
- Models: catalog (OpenAI, Anthropic, Gemini, Fireworks, Together, Kimi, GLM, Qwen) + any OpenAI-compatible `custom`. (trueforge.dev/models)
- Agent config: `enable_tools` (@all/@read-only/names), `require_approval_for_tools` (@all/@write/@destructive/names), `preload`; skills need sandbox; dynamic subagents on by default; iteration limit 100. (trueforge.dev/create-agent/overview)
- SDK approvals: turn ends with `tool.approval_required`; resume with `user.tool_approval` `{status: allow|deny, reason}`. (trueforge.dev/api/use-agent)
- Schedules: hourly minimum; each run is a session. Behaviour on a gate during a scheduled run is undocumented. (trueforge.dev/schedules)
- Approvals also apply to Code Mode and subagent tool calls. (research report)

## Learned facts (hackathon)
- Sat 26 Sep 2026, Polaris campus Bangalore; build 12:00–19:00 IST; demos 19:30–21:00. (truefoundry.com/truefoundry-hackathon)
- Rules: TrueForge mandatory; real system; sandbox execution; stop before destructive actions; nothing pre-built; disclose AI use; public repo whose README runs on another laptop.
- Judging: harness doing the work 30 · works 25 · safety boundaries 20 · real work 15 · demo clarity 10.
- Judges include TrueFoundry CTO. Company themes: governance, specific/auditable approvals, avoiding approval fatigue, cost vs Claude Managed Agents.

## Open questions
- How does GitHub remote MCP annotate tag/release tools? (check tonight)
- Can a scheduled run be resumed after hitting a gate? (untested; keep schedules gate-free)
