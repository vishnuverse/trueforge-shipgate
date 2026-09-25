# docs/MEMORY.md — decisions and learned facts

Long-lived project memory. Append one line per decision/fact: date · decision/fact · reason/source.
Never delete; mark superseded lines with ~~strikethrough~~ and add the replacement below.

## Architecture decisions
- 2026-09-25 · ~~Primary agent = Release Captain; Runbook Executor stretch; Ticket Resolver only with 4 people · judging rewards narrow + working (25 pts) and harness-visible work (30 pts).~~
- 2026-09-26 · Priority = Ticket Resolver (P0) → Runbook Executor (P1) → Release Captain (optional) · team choice; Ticket Resolver runs generated code (failing test + patch) in Daytona, which the 30-pt qualifying criterion requires; Runbook Executor's kind cluster is on the host, unreachable from the sandbox.
- 2026-09-26 · Ticket Resolver gates `create_pull_request` + `add_issue_comment` by name; `create_branch` / `push_files` to `fix/*` ungated · the `main` ruleset (no bypass) stops pushes reaching `main`; gating the push too would add a third approval per ticket (approval fatigue).
- 2026-09-26 · `merge_pull_request` and `update_issue` not enabled for Ticket Resolver; the orchestrator flips labels from the handoff JSON · `update_issue` can close issues, which the injection ticket (#5) asks for; smaller blast radius.
- 2026-09-26 · Tickets live in GitHub issues; Jira (Atlassian remote MCP, API-token header auth) is an optional ticket source · adds setup and an admin toggle; code and PRs stay on GitHub either way.
- 2026-09-26 · ~~Runbook Executor deploys public image tags on kind (bad tag = failed release) · without Release Captain there is no published image to deploy.~~
- 2026-09-26 · Runbook Executor deploys `demo-app` (tiny web app over `humanize`: `/humanize`, `/health`, `/version`), good + broken images built on the day and `kind load`ed · "which version is running" and a failing `/health` are easy to show live.
- 2026-09-25 · GitHub (issues, PRs, labels, tags) is the handoff bus between agents · no direct agent-to-agent calls; state is visible and demoable.
- 2026-09-25 · Chaining via a small TS orchestrator on `@truefoundry/trueforge-sdk`, not subagents · TrueForge subagents are dynamic, one level deep, can't call saved agents.
- 2026-09-25 · Sandbox holds zero credentials; all mutations go through MCP tools · approvals gate MCP calls only; shell in sandbox would bypass gates.
- 2026-09-25 · Publish via our own `registry` FastMCP server holding the TestPyPI token · lets `publish_package` be a named, gated tool.
- 2026-09-25 · Gated tools listed by name in `require_approval_for_tools` · unannotated MCP tools run ungated under `@destructive`/`@write`.
- 2026-09-25 · Test, tag and publish a single pinned SHA · approval must bind to the exact artifact, not a PR merge.
- 2026-09-25 · ~~`mock-infra` JSON-state MCP~~ → real local kind cluster behind a `k8s` MCP · hackathon forbids mocks.
- 2026-09-25 · Registry = TestPyPI (+ optional GHCR image) · free; real no-re-upload semantics make RC-14 realistic.
- 2026-09-25 · Every agent ends with one fenced JSON handoff block (SPEC §7) · orchestrator never parses prose.
- 2026-09-25 · ~~Test repo stays `tinyshop` (small Python + pytest); FFmpeg / ffmpeg-based repos rejected · build and test time too long for 2 runs per release in a 7-hour window; keep it simple.~~
- 2026-09-26 · Target repo = fork `vishnuverse/humanize` (of `python-humanize/humanize`, MIT); `vishnuverse/tinyshop` unused · a real, widely used library scores better on "a job worth handing over" than a toy, and its suite runs in seconds; bugs are planted on the day and disclosed. prettytable was the alternative considered.
- 2026-09-26 · Pin TrueForge server `@truefoundry/trueforge@0.2.1` and SDK `@truefoundry/trueforge-sdk@0.2.0` exactly (not `@latest`); run the server via `npx`, never clone/build it · a release mid-event could change behaviour between rehearsal and a judge's laptop; one `npx` line keeps the README runnable.
- 2026-09-26 · After P0: a Triage agent (issue-ai-agent style: category, priority, duplicates, contextual reply, follow-ups). Gemini drives it; our own read-only MCP wraps TypeSafe Jev (`TYPESAFE_API_KEY`) for calibrated category / priority / duplicate decisions; replies gated; labels auto only at confidence > 0.9 · Jev can't generate text or run an agent loop, but gives calibrated decisions; `bug` label feeds Ticket Resolver. Notes: `docs/reference/issue-ai-agent-and-typesafe.md`.
- 2026-09-26 · Ticket Resolver model = `deepseek/deepseek-v4-flash` via OpenRouter (fallback `z-ai/glm-5.3-flash`) · bake-off on issue #1: both passed (DeepSeek 168 s / $0.0058, GLM 253 s / $0.0046), gpt-5-nano and gpt-oss-20b failed; total $0.026. `docs/model-bakeoff.md`.
- 2026-09-26 · Docs reorganised: `SPEC`, `HANDOVER`, `MEMORY`, `IMPLEMENTATION_PLAN` moved to `docs/`; old README → `docs/research-and-plan.md`; new submission README at the root; index `docs/README.md` · README is what judges read; keep CLAUDE.md/AGENTS.md at the root for tools.
- 2026-09-26 · Keep `vishnuverse/trueforge-shipgate` **private**; deliver the skill inline (`setup_agents.ts --inline-skill`) instead of as a git skill · team choice; git skills are fetched anonymously. The submission rules require a public repo, so it must be made public before submitting.
- 2026-09-26 · Build on TrueForge's built-in local sandbox; add Daytona for scenario runs + the demo once the key arrives · no Daytona account yet; 0.2.1 has no Docker/K8s sandbox; the local sandbox runs on the host next to `.env`, which weakens "sandbox holds no credentials".

## Learned facts (TrueForge)
- Local mode: `npx @truefoundry/trueforge@latest`, :8790, SQLite, no login — localhost only. Node >= 22.14. (trueforge.dev/quickstart)
- ~~Sandbox provider: Daytona only; key needs Snapshot-create or config fails. (trueforge.dev/sandbox)~~
- Sandbox providers in 0.2.1: **Daytona** (Settings; key needs Snapshot-create), **built-in local sandbox** (standalone/`npx` only; macOS seatbelt or Linux bwrap; used automatically when no provider is configured; boot log says "Local sandbox fallback is available"), TrueFoundry-hosted (env, TrueFoundry mode only). No Docker or K8s provider (K8s = unmerged PR truefoundry/trueforge#874). Official Docker image runs `STANDALONE=false`, which turns the local sandbox off. (TrueForge source + our run, 2026-09-26)
- Self-hosted Daytona can't be used: Daytona settings have no API URL field, and snapshot registration POSTs to hardcoded `https://app.daytona.io/api/snapshots`. (`DaytonaProvider.ts`, `providerUtils.ts`, 2026-09-26)
- Standalone data lives in `~/Library/Application Support/trueforge/db/db.sqlite` (macOS). API docs at `http://localhost:8790/api/v1/docs`. (our run, 2026-09-26)
- MCP: remote HTTP/SSE only; auth none / header / OAuth DCR. stdio servers need a bridge (e.g. supergateway). (trueforge.dev/mcp-servers)
- Models: catalog (OpenAI, Anthropic, Gemini, Fireworks, Together, Kimi, GLM, Qwen) + any OpenAI-compatible `custom`. (trueforge.dev/models)
- Agent config: `enable_tools` (@all/@read-only/names), `require_approval_for_tools` (@all/@write/@destructive/names), `preload`; skills need sandbox; dynamic subagents on by default; iteration limit 100. (trueforge.dev/create-agent/overview)
- SDK approvals: turn ends with `tool.approval_required`; resume with `user.tool_approval` `{status: allow|deny, reason}`. (trueforge.dev/api/use-agent)
- Schedules: hourly minimum; each run is a session. Behaviour on a gate during a scheduled run is undocumented. (trueforge.dev/schedules)
- Approvals also apply to Code Mode and subagent tool calls. (research report)
- Git skills can't be preloaded: `preload: true` on a git skill → 422 "preload is not supported for git skills". The agent `cat`s SKILL.md first instead. A git skill whose repo/ref/path isn't publicly fetchable makes sandbox setup fail, so **every `exec` fails**; `setup_agents.ts` refuses such a ref. `vishnuverse/trueforge-shipgate` is **private** (anonymous API 404), so until it's public use `setup_agents.ts --inline-skill`. (skill agent, 2026-09-26)
- TypeSafe key works: `GET https://api.typesafe.ai/v1/models` → 200 with `jev-latest`, `jev-preview` (no waitlist block). Triage agent not built yet. (2026-09-26)
- Local sandbox + pip: pip ≥24.2 verifies TLS through the macOS keychain, which the sandbox blocks (`OSStatus -26276`), so `pip install` fails on SSL. `--use-deprecated=legacy-certs` fixes only the top-level pip; build isolation spawns another pip. `export PIP_USE_DEPRECATED=legacy-certs` fixes both (verified: install OK, 738 passed). Never `--trusted-host`: TR-01 run 1 saw the model reach for it. (2026-09-26)
- TR-01 run 1 (02:32 IST): agent correct up to the push; `create_branch`/`push_files` → 403 because the GitHub token is read-only. 17 checks passed incl. H1, H2, H4, S1–S3, S7; 12 failed, all from the 403. Token needs Contents, Issues, Pull requests: read/write. (2026-09-26)
- Tool responses over ~24,000 characters are offloaded; SKILL.md via `exec` is ~19k, fine. (skill agent, 2026-09-26)
- UI route for a session: `<TRUEFORGE_URL>/sessions/<session_id>` (shows the approval card). The UI's Allow sends `{"status":"allow"}` and creates one turn per click. Subscribing to an already-finished turn can return 412 (fall back to GET turn). (orchestrator agent, 2026-09-26)
- Sub-agents and ask-user are on by default; the agent config sets both `enabled: false`. (2026-09-26)
- Gemini key is **free tier: 20 requests/day** (`generate_content_free_tier_requests`), exhausted at ~20:36Z; also 503 "high demand". One ticket run needs 30–50 calls. → OpenRouter custom provider added (base `https://openrouter.ai/api/v1`, key hard-limited to $5). (2026-09-26)
- Gemini 3: keep temperature at the default 1.0 (below 1.0 can loop or degrade reasoning); control depth with thinking level. TrueForge passes `model.params.reasoning_effort` (`minimal|low|medium|high` for gemini-3-6-flash) through as the thinking level and sends no temperature unless set. Notes: `docs/reference/gemini-3-prompting.md`. (ai.google.dev Gemini 3 guide; TrueForge `VercelAILLM.ts`, 2026-09-26)
- Skills: `preload: true` inlines SKILL.md into the prompt; otherwise only name + description are shown until the model picks the skill. Git skills = repo URL + `path` + `ref` (pin a SHA). (trueforge.dev/skills, OpenAPI `Skill`, 2026-09-26)
- GitHub MCP has **no `update_issue`**: it is now `issue_write` (create, edit and close issues). The "not enabled" decision above applies to `issue_write`. (github/github-mcp-server `pkg/github/issues.go`, 2026-09-26)
- GitHub MCP annotations: every write tool has `readOnlyHint=false` and **no `destructiveHint`**, except `delete_file` (`destructiveHint=true`). Covers `create_branch`, `push_files`, `create_pull_request`, `add_issue_comment`, `issue_write`, `merge_pull_request`. So `@destructive` alone would not gate PRs or comments. Confirm against the live server once the PAT is set. (github-mcp-server source, 2026-09-26)
- Live GitHub MCP (our PAT, via `GET /api/v1/mcp-servers/github/tools`): 45 tools; matches the source above (no `update_issue`; only `delete_file` destructive). (2026-09-26 00:58 IST)
- Agent sandbox is **off by default**: every agent spec needs `config.sandbox.enabled: true`. (TrueForge OpenAPI `SandboxConfig`, 2026-09-26)
- API shapes (0.2.1): turn input `{"type":"user.message","content":...}`; `stream:false` still returns `running` at once, so wait on `GET /sessions/{id}/turns/{tid}/subscribe`; a gate ends the turn `done` with `required_actions[].type = "tool.approval_required"` (holds `thread_id` + `tool_call_id`); resume with `user.tool_approval` + `approval: {status: allow|deny, reason}`. MCP tools are deferred: the agent calls `list_tools` → `get_tool_info` → `call_tool`. (our run, 2026-09-26)
- Name gating works: `require_approval_for_tools: ["get_me"]` paused a read-only tool, so literal names gate regardless of annotations. (our run, 2026-09-26)
- Local sandbox on this Mac: shell tool is `exec`; one folder per session under `~/Library/Application Support/trueforge/sandboxes/`; outbound network works (`git ls-remote` GitHub OK, PyPI 200); reading `~/Documents/...` (this repo, so `.env` too) → "Operation not permitted"; git can't use the macOS keychain (`-60008`). Only these paths were tested. (our run, 2026-09-26)

## Learned facts (target repo `vishnuverse/humanize`, checked 2026-09-26 00:45 IST)
- Fork `main` = upstream `main` (`392aef7`). The fork has **0 tags**; upstream's latest is `4.16.0` (**no `v` prefix**), 27 commits behind `main`. Push the upstream tags to the fork before anything depends on versions.
- Issues are **disabled** on the fork (GitHub default for forks) — enable them before opening fixtures.
- Build: hatchling + hatch-vcs, `version.source = "vcs"`, `local_scheme = "no-local-version"`. With tags: `4.16.1.dev27` (no `+g<hash>`, so TestPyPI would accept an untagged build). Shallow/tagless clone: `0.1.dev1`.
- No runtime dependencies; `requires-python >= 3.10`; test extra is `tests` (freezegun, pytest ≥ 9, pytest-benchmark, pytest-codspeed, pytest-cov); `filterwarnings = error`.
- Local run (py3.12): 746 passed, 110 skipped (i18n needs `.mo` from `scripts/generate-translation-binaries.sh`) in ~9 s; ~1 s with `--benchmark-disable`.
- Upstream commits since `4.16.0` are not conventional commits (e.g. "Fix fractional() …", "Add Sinhala (si_LK) locale").
- `ordinal()`'s 11/12/13 special case is `src/humanize/number.py:139`; dropping it gives `12nd` (planned bug #1).

- Fixtures planted 2026-09-26 ~01:50 IST (team chose to build before 12:00): 58 upstream tags pushed; five disclosed commits `chore(fixture #N)` on `main` → HEAD **`3145c20`**; suite 738 passed, 110 skipped (py3.12). Issues enabled; #1–#7 opened in order with label `bug` (#1–#6 bodies were edited once after a mis-ordered create); labels `triaged`, `fix-proposed`, `cannot-reproduce`, `needs-human` added.
- Ruleset `protect-main (shipgate)` (id 24018372): deletion, non_fast_forward, pull_request; empty bypass list. A direct push to `main` with the owner's own token was **rejected** (GH013), so the owner's PAT can't reach `main` either way.
- `GITHUB_PAT` in `.env` is fine-grained (expires 2026-10-25); reads the fork; gets 404 on another repo's collaborators endpoint, so it's limited to the fork. (checked 2026-09-26 02:00 IST, no value printed)
- #6 conflict verified: restoring the correct `intword()` fails exactly `tests/test_number.py::test_intword[test_args10-1000.0 million]`.
- #4 is a real-clock bug: freezegun's `tz_offset` shifts both local and UTC time, so it can't trigger it; `TZ=<zone>` does whenever that zone's date differs from UTC.

## Learned facts (hackathon)
- Sat 26 Sep 2026, Polaris campus Bangalore; build 12:00–19:00 IST; demos 19:30–21:00. (truefoundry.com/truefoundry-hackathon)
- Rules: TrueForge mandatory; real system; sandbox execution; stop before destructive actions; nothing pre-built; disclose AI use; public repo whose README runs on another laptop.
- ~~Judging: harness doing the work 30 · works 25 · safety boundaries 20 · real work 15 · demo clarity 10.~~
- Judging (official, 2026-09-26): harness doing the work 30 (qualifying; judge must watch real tool + sandbox run + hold; prompt-with-wrapper ≈ 0) · it actually runs 25 (stranger clones + follows README on own laptop) · where it stops 20 (defend the line; sandboxed vs gated; agent explains next action; small blast radius) · a job worth handing over 15 (real chore a person would delegate) · demo clarity 10 (5 min; judges ask us to explain our architecture).
- Submission checklist (organisers, shared 2026-09-26): (1) harness visibly working — real tool, sandbox code run, pause before irreversible; "works as well as a text box" = not eligible; (2) one job finished; (3) film the approval moment + where code ran; (4) public repo, README works elsewhere, AI named; (5) only own accounts/data/keys, no keys in repo or demo video.
- Judges include TrueFoundry CTO. Company themes: governance, specific/auditable approvals, avoiding approval fatigue, cost vs Claude Managed Agents.

## Open questions
- ~~How does GitHub remote MCP name and annotate `create_pull_request`, `add_issue_comment`, `push_files`, `create_branch`? (check tonight)~~ → answered from source in Learned facts (TrueForge); confirm on the live server.
- ~~Does a GitHub ruleset with an empty bypass list block the repo owner's fine-grained PAT from pushing to `main`? (verify in Phase 2; fallback: gate the push tools too)~~ → yes: owner's token rejected (GH013), see Learned facts (target repo).
- Jira (optional): exact Atlassian MCP tool names for read / comment / transition, and the site's `cloudId`.
- Can the fork-scoped fine-grained PAT open issues or PRs on upstream `python-humanize/humanize`? Expected no (fine-grained PATs can't contribute to public repos you aren't a member of); verify, because a stray upstream PR would spam a real maintainer.
- Can a scheduled run be resumed after hitting a gate? (untested; keep schedules gate-free)
