# docs/HANDOVER.md

Relay baton between sessions (human or Claude). Update at the end of every work block. Newest entry on top.

---

## 2026-09-26 15:01 — Claude — Any-repo final-review fix wave (branch `feat/any-repo`)

**Done** (whole-branch review: 5 Important, fixed per the controller's rulings)
- I1: the triage server's `.env` reader now accepts `export KEY=value` lines (they were skipped, so every ticket got
  an `error` verdict and was held although `setup.sh`'s preflight passed).
- I2: the skill states no humanize fact as a rule any more; hard rule 11, the Defect / Failing-run definitions and
  steps 3c, 6, 6b are generic, and each humanize fact is an `Example (demo repo vishnuverse/humanize, <where>)` line
  just before its section's closing tag. Golden re-rendered.
- I3: the triage tool's title comes from the config (`Triage a <name> ticket`).
- I4: the orchestrator's TrueForge URL falls back to `shipgate.yaml` `trueforge.url` (env `TRUEFORGE_URL` still
  wins); `.env.example` now has `TRUEFORGE_URL` commented out, so an existing `.env` copied from the old example
  still pins `http://localhost:8790` for the orchestrator until that line is removed.
- I5: README no longer claims `setup.sh --smoke` runs the tests (it is one triage call); Limits says setup cannot
  check the install/test commands (the first ticket run does); the `scripts/` repository-map row names `setup.sh`,
  `stop.sh`, `setup_trueforge.ts` and `shipgate_config.py`.

**Known limit (ruling, not fixed):** the triage questions (policy `triage-v1`, `mcp/triage/policy.py`) name humanize.
On another repo most tickets will likely be held as `uncertain` (investigate-only, no patch) until a retuned policy
(`triage-v2`, re-probed) exists.

**Live check after the fix wave (15:20):** triage MCP restarted on the final code; `scripts/setup.sh --no-start`
re-registered the agent with the re-worded skill (provider and both connectors `kept`, no key sent; doctor all ✓);
`scripts/score.sh TR-03` → **PASS 27/27**: Jev `uncertain` (margin 0.04), patch held, zero branch/push/PR calls,
outcome `policy_blocked`. The humanize facts moved into labelled examples still reach the demo agent.

**Deferred minors** (any-repo reviews; none blocks merge): loaders' file-not-found branch untested · Windows drive
guard beyond spec · duplicate YAML keys load in Python but fail in TS · loaders don't reject whitespace/metacharacters
in dirs or branch · `constants.py` exits 2 at import on a bad config · `targetRepo()` re-reads the config per call ·
`reset.sh` guard duplicates the root lookup and says "cannot read shipgate.yaml" when uv is missing; only the mismatch
path is tested · `setup_agents.ts` dead `RenderError` branch, no tsc coverage (add `scripts/*.ts` to the orchestrator
tsconfig), skill-extras rendering untested · `setup.ts` `isObj` duplicates `isMapping`; malformed `TRUEFORGE_URL` exits
1 not 2; github connector rebuilt on rotation (needs a comment) · `stop.sh` matches both pid files against one pattern ·
`setup.sh`: `--check` also reads branch protection, a network error reads as "not protected", no `npx` preflight, three
`die` messages lack a fix hint, dry-run on a fresh clone without a uv cache gives uv's offline error, branch names with
`/` not URL-encoded · doctor shows a missing agent as "github gates []" · TrueForge URL precedence edge cases (old
`.env` pins localhost; empty `TRUEFORGE_URL` not treated as unset by the setup scripts; `check.py` ignores the config) ·
step 9 still says "e.g. the demo repo's number.py" outside examples · README/CLAUDE.md don't surface `--rotate-keys`,
`--allow-remote`, `--smoke`; CLAUDE.md layout omits the setup scripts; README test counts stale.

**Next**
1. Merge decision for `feat/any-repo`.
2. Next steps 1–3 of the 14:52 entry below still stand (second repo, public repo, Daytona demo).

---

## 2026-09-26 14:52 — Claude — Any-repo config + one-command setup: live acceptance (Task 10 of 10, branch `feat/any-repo`)

**Done** (plan `.superpowers/sdd/2026-09-26-any-repo-setup/task-10-brief.md`, live against the running install; no keys
printed, no `--rotate-keys`/`--allow-remote`)
- Step 1 `scripts/setup.sh --no-start` on the running install: `✓ model provider openrouter: kept`,
  `✓ connector github: kept`, `✓ connector triage: kept` (no `created`/`rotated` line), agent `ticket-resolver` updated,
  `✓ vishnuverse/humanize@main is protected`, `✓ labels present`, doctor all `✓`, `ready.`, exit 0.
- Step 2 `scripts/setup.sh --check --smoke 1`: doctor all `✓`, `triage #1 on vishnuverse/humanize: defect · defect 0.97
  (margin 0.95) · in_scope 0.88 · patch allowed`, exit 0.
- Step 3 fresh clone (`git clone` + tags, `feat/any-repo`, own copy of `.env`): `scripts/setup.sh --no-start` repeated
  kept/kept/kept and `ready.`, exit 0; `scripts/score.sh TR-01` (reset the fork, run with scripted approvals, check):
  session `01m3efxaacqxsg6jdymvt1fg3b`, both gates (`create_pull_request`, `add_issue_comment`) paused and were
  `script -> allow`d, real PR opened from `fix/issue-1` and a reply posted on #1 — **`# RESULT TR-01 PASS (34 passed,
  0 failed, 0 skipped)`**, exit 0. All of H1–H4, S1–S4, S7–S10, T14, `expect.*` and `never-enabled` passed, including
  **H4 clean this run** (no `mcp_client`/`gh`/API/loopback in the 39 sandbox commands) — the push-mismatch habit noted
  in earlier runs did not recur here. Temp clone directory deleted after the run (`rm -rf` on the `mktemp -d` parent).
- Step 4: no second repo was named for this session, so the README's "Using your own repo" section now states the
  any-repo flow itself is proven on the humanize fork only.
- Net: the any-repo configuration + one-command setup (Tasks 1–10) is accepted live end to end on this machine —
  idempotent re-registration, doctor, smoke triage, and a full scored scenario from a clean clone all pass.

**Next**
1. Prove the any-repo flow against a second, real repo when one is offered (steps in README "Using your own repo").
2. Decide when to make `vishnuverse/trueforge-shipgate` public for submission.
3. Filmed `--approve ui` demo run on Daytona once its key arrives; Runbook Executor on a local kind cluster.

---

## 2026-09-26 14:30 — Vishnu + Claude — Any-repo config + one-command setup: docs (Task 9 of 10, branch `feat/any-repo`)

**Done**
- Tasks 1–8 of `docs/superpowers/plans/2026-09-26-any-repo-setup.md` committed: `shipgate.yaml` + matching
  Python/TypeScript loaders; scorer, orchestrator and the triage server read the target from config; skill and agent
  spec are templates rendered at registration (`setup_agents.ts --inline-skill`); `reset.sh` refuses to run unless
  the config target is the demo fork; `scripts/setup_trueforge.ts` (register provider + connectors, `--check`
  doctor); `scripts/setup.sh` (one-command install/start/register/check, `--dry-run`/`--check`/`--no-start`/
  `--rotate-keys`/`--allow-remote`/`--allow-unprotected`/`--smoke <issue>`) and `scripts/stop.sh`.
- Task 9 (this entry): docs brought in line with the config-driven flow — README "Quick start" collapsed to
  `cp .env.example .env` → edit `shipgate.yaml` → `scripts/setup.sh` → one `shipgate run` line; "Using your own
  fork" replaced by "Using your own repo" (requirements, `shipgate.yaml` key table, limits) with the fixture setup
  kept under "Scored demo (the humanize fork)"; `CLAUDE.md` Setup/Run/boundary 7/layout updated to match;
  `docs/SPEC.md` §4.1/§4.7 note the config source and the scenario `repo:` key; `docs/contracts.md` gained
  `## 9. shipgate.yaml` (schema + validation rules, verbatim from the spec) and `SHIPGATE_CONFIG` /
  `SHIPGATE_ENV_FILE` / `SHIPGATE_PID_DIR` in its environment table; `AGENTS.md` directory map gained
  `shipgate.yaml`, the `setup`/`stop` scripts and `orchestrator/src/{config,render,setup}.ts`; `.env.example` now
  lists `OPENROUTER_API_KEY` (setup.sh requires it) alongside comments naming each key's reader.
- Also: `tests/check/test_reset_guard.py` reformatted (`ruff format`) to clear a pre-existing E501, committed
  separately from the docs.

**Next**
1. Task 10 (Live acceptance): fresh-clone `setup.sh --no-start --check` + `score.sh TR-01` from a temp clone; a
   second repo only if a real one is offered. Until that lands, the any-repo flow is proven on the humanize fork only.
2. Decide when to make `vishnuverse/trueforge-shipgate` public for submission.

---

## 2026-09-26 12:05 — Vishnu + Claude — Jev triage pre-check built and accepted live (branch `feat/jev-triage`)

**Done**
- Plan `docs/superpowers/plans/2026-09-26-jev-triage.md` executed natively (8 tasks): `mcp/triage/` (read-only
  `triage_ticket` MCP, policy `triage-v1`, fail-closed, audit `runs/triage.jsonl`), scorer S8–S10 + loopback H4 +
  `policy_blocked`, `expect.triage`, skill step 3.0 + `<investigate_only>`, `score.sh` readiness, docs.
  117 Python + 72 orchestrator tests; live smoke (`-m live`) 2/2.
- Final review (fresh reviewer): 0 Critical, 1 Important fixed (`6f3d100`: 6b "Else step 7" could reach the fix while
  held), 14 minors deferred (ledger `.superpowers/sdd/2026-09-26-jev-triage/progress.md`).
- Live (real TrueForge + GitHub + TypeSafe, jev-1.13.0):
  - TR-03 (#3): **patch held and zero branch/push/PR calls in 4/4 runs** (Jev `uncertain` every time, never `error`);
    scored PASS 3/4 (run 2 omitted the handoff push-back entry). Outcomes: cannot_reproduce ×3, policy_blocked ×1.
  - TR-07 (#7): PASS (`other_project` → out_of_scope). TR-01 (#1): 33/34, `defect 0.98`, S8/S9/S10 PASS; H4 FAIL
    (agent used `mcp_client` debugging the known push mismatch). TR-06 (#5): 33/35, `docs 0.99` + AI flag, S10 PASS;
    FAIL H4 and S8 (agent listed tools with `mcp-client` in the sandbox before triage).
- TrueForge now runs with `OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1"]`; connector `triage` registered via
  `PUT /api/v1/settings/mcp-servers`; agent re-registered with the fixed skill.
- Spec for the next theme: `docs/superpowers/specs/2026-09-26-any-repo-setup-design.md` (approved).

**Deferred minors** (Jev review): S9/x_triage trust the first verdict without checking its issue, and S8 allows a
second call after a verdict · triage server's .env reader drops `export KEY=` lines (every ticket held) · the sync
tool blocks FastMCP's event loop during a call · S10 collapses whitespace only (`Triage (triage-v1):` without the space
is a false FAIL) · `_audit` catches OSError only · model pin sent, not enforced · TR-03 `patch_allowed: false` also
passes on a TypeSafe outage (check route `uncertain` in `runs/triage.jsonl`) · TR-03 outcome/label/repro lists not
cross-checked · scorer doesn't check the saved agent's triage server / web_search · S8 edge cases (same-message exec,
non-inline skill) · skill promises card_line in every push-back comment · score.sh readiness doesn't check connector or
allow-list; `server.py &` logs into the demo terminal · README own-fork section, rule 5 accounts, .env.example comment,
live smoke not in test docs · nits: "0.50 < 0.50" rounding, loopback regex misses [::1]/127.x, AnswerError repr
unbounded, generic flat module names.

**Next**
1. Merge decision for `feat/jev-triage`.
2. Any-repo config + one-command setup: plan `docs/superpowers/plans/2026-09-26-any-repo-setup.md`.
3. Agent habit to fix later: sandbox `mcp_client`/`mcp-client` use (H4) — the skill forbids it, the model still does it.

---

## 2026-09-26 08:30 — Vishnu + Claude — finish-P0 plan closed; final review fixes in

**Done**
- Final whole-branch review (fresh reviewer): no Critical. Fixed: S4 substring false pass (`2d8fef4`), 60-min demo
  timeout for ui/terminal (`73e3392`), nudge + `check.json` documented (`6324288`), skill 6b (`8a4ceef`).
- Skill 6b NOT verified: the TR-03 check run patched documented behaviour again; the gate held. TR-03 is a
  judgement call this model gets right ~1 in 5.
- Decision: accept the push_files weakness; demo in `--approve ui`, re-run if a push derails.

**Deferred minors** (review): stale timeout docs (SPEC §4.7 'Cap: 10 minutes', contracts example), SKILL git-checkout
recovery vs strict scorer, nudge/final-verdict use two sources, corrupt check.json aborts --all, 'against' wording for
cannot_reproduce, redundant `seen` set, loose TR-03 steps regex, #3-specific example in hard rule 11.

**Update 08:45** UI dry run passed (PR #24, REVISE at Gate 1, exit 0). Film terminal + browser side by side.

**Next**
1. Filmed `--approve ui` run on #1 (REVISE once) — dry run done; Daytona key → one run there.
2. Fresh-laptop README test; decide on the uncommitted fixture edits (`tests/fixtures/humanize/issues/{1,2,4,6}.md`).
3. Jev triage pre-check built on branch `feat/jev-triage` (plan `docs/superpowers/plans/2026-09-26-jev-triage.md`); live acceptance in its Task 8. Then Runbook Executor on kind. Before submitting: make the repo public.

---

## 2026-09-26 07:15 — Vishnu + Claude — P0 scenarios: each must-pass green once; full pass 5/8

**Done** (plan `docs/superpowers/plans/2026-09-26-finish-p0.md`, ledger in `.superpowers/sdd/`)
- Each must-pass scenario passed a live scored run: TR-01, 03, 05, 06, 10, 11, 12, 13 (+ TR-09).
- Fixes: S4 accepts the card in the PR body; orchestrator nudge on empty turns; TrueForge turn limit 20 min;
  iteration limit 90; skill rules (old-test conflict, documented behaviour, T2 push-back, push discipline);
  scorer bugs (existing-test edits, repro null, comment window, --all saved grades).
- Full pass on the final skill: must-pass 5/8, automated 42/75 (`check.py --all`).

**Blocked on Vishnu (decision)**
- Push-step reliability: build a diff-based push MCP tool, try a stronger model, or accept and demo in ui mode.

**Next**
1. Decision above, then a second full pass.
2. Final whole-branch review (plan requirement). Filmed `--approve ui` run. Daytona key. Fresh-laptop test.

---

## 2026-09-26 03:10 — Vishnu + Claude — TR-01 end to end: 29/30

**Done**
- GitHub token fixed (Contents / Issues / PRs read-write). Model stays deepseek-v4-flash **0423** with reasoning high,
  temp 1.0, top_p 0.95, max_tokens 32768 (0731 reused tool-call ids and called GitHub from sandbox code).
- Verified: TrueForge refuses gated tools from sandbox code (Code Mode); H4 now also flags `mcp_client`.
- TR-01: 29/30, real PR vishnuverse/humanize#8. S4 failed (card only in PR body) → hard rule in SKILL.md.
- pip in the local sandbox: `PIP_USE_DEPRECATED=legacy-certs` in the command prefix; `--trusted-host` forbidden.

**Next**
1. Re-run TR-01 to confirm 30/30 (reset closes PR #8), then TR-03, 05, 06, 10, 11, 12, 13.
2. Jev triage pre-check built (plan `docs/superpowers/plans/2026-09-26-jev-triage.md`); live acceptance in Task 8. Filmed `--approve ui` run. Daytona when the key arrives.

---

## 2026-09-26 02:45 — Vishnu + Claude — model chosen, docs reorganised, submission README

**Done**
- Model bake-off (`scripts/bakeoff.py`, `docs/model-bakeoff.md`): **deepseek-v4-flash** picked (glm-5.3-flash fallback);
  agent re-registered on `openrouter/deepseek-v4-flash`. Spend so far $0.026 of the $5 key limit.
- Docs: `SPEC`, `HANDOVER`, `MEMORY`, `IMPLEMENTATION_PLAN` → `docs/`; old README → `docs/research-and-plan.md`;
  new submission README; `docs/README.md` index; fixture issue texts in `tests/fixtures/humanize/`.
- Alignment fixes: kickoff "Approval mode", shared handoff parsing, SPEC §7 status values.

**Next**
1. `scripts/score.sh TR-01`, then the rest of the must-pass set → `check.py --all`.
2. Prompting notes for DeepSeek V4 / GLM-5.3 → `docs/reference/` (research agent running); apply to SKILL.md if needed.
3. Filmed `--approve ui` run; fresh-laptop README test; `TARGET_REPO` setting; Daytona when the key arrives.

---

## 2026-09-26 02:20 — Vishnu + Claude — P0 built in parallel and merged; model switch pending

**Done** (team chose to build before 12:00)
- Fork `vishnuverse/humanize`: tags, fixtures #1–#7 (5 disclosed plant commits, HEAD `3145c20`), labels, no-bypass ruleset.
- Merged on `main`: `skills/ticket-resolver/SKILL.md` + `agents/ticket-resolver.json` + `scripts/setup_agents.ts`;
  `orchestrator/` (66 tests, typecheck clean); `scripts/check.py` + `shipgate_check/` + 13 scenarios + `reset.sh` /
  `score.sh` (32 tests, ruff clean). Contracts: `docs/contracts.md`.
- Gemini key is free tier (20 requests/day): exhausted. OpenRouter provider added in TrueForge with 4 candidates;
  `OPENROUTER_API_KEY` in `.env` (hard limit $5). Repo stays private → skill delivered inline.

**Blocked on Vishnu**
- Paste the OpenRouter key into TrueForge: Settings → Models → `openrouter` → Edit.

**Next**
1. Model bake-off on issue #1 (no GitHub writes): `scratchpad/bakeoff.py` → pick model → update agent JSON, SPEC §4.1.
2. `npx --yes tsx scripts/setup_agents.ts --inline-skill`, then `scripts/score.sh TR-01`; fix integration gaps
   (handoff `status` for non-fixed outcomes, TR-14 stop rule, "approval mode" phrase in kickoff).
3. Must-pass: TR-01, 03, 05, 06, 10, 11, 12, 13 → `check.py --all` scorecard. Then TR-02, 04, 07, 09, 14.
4. Live `--approve ui` run on #1 (REVISE once) for the demo; README run steps + AI disclosure; Daytona when the key arrives.

---

## 2026-09-26 01:40 — Vishnu + Claude — Ticket Resolver harness designed (spec only, no code)

**Done**
- `docs/SPEC.md` §4 rewritten: agent config (Gemini 3.6 Flash, `reasoning_effort: high`, **no temperature**, sandbox on,
  preload skill), flow T1–T15, evidence check + card, 2-attempt retry loop, push-back table, HITL protocol
  (`REVISE:` / `EDIT:` / `STOP`, max 3 per gate; modes ui / terminal / script), fixtures #1–#7, scorer + scorecard.
- Must-pass: TR-01, 03, 05, 06, 10, 11, 12, 13. README fixtures and scenario table updated to match.
- Reference notes in `docs/reference/`: Gemini 3 prompting, SWE-agent patterns, issue-ai-agent + TypeSafe.
- Decision: Triage agent (TypeSafe Jev behind our MCP) comes after P0. Vishnu adds `TYPESAFE_API_KEY` to `.env`.

**Next (12:00, not before)** — write the implementation plan from `docs/SPEC.md` §4, then build: fixtures on the fork →
`skills/ticket-resolver/SKILL.md` + agent spec → orchestrator (script mode first) → `check.py` → must-pass scenarios.

---

## 2026-09-26 00:55 — Vishnu + Claude — local setup: TrueForge running, local sandbox, kind

**Done**
- TrueForge **0.2.1** runs in standalone mode on :8790 (`.claude/launch.json` → `trueforge`, or `npx --yes @truefoundry/trueforge@0.2.1`).
  Boot log confirms **"Local sandbox fallback is available"** (darwin, Python 3.14). Sandbox = built-in local sandbox until Daytona arrives.
- `kind` v0.33.0 installed; cluster **`shipgate`** is up (1 node Ready, k8s v1.37.0). kubectl context is now `kind-shipgate`.
- GitHub MCP tool names/annotations checked from source: `update_issue` is now **`issue_write`** (docs renamed);
  write tools carry no `destructiveHint` except `delete_file` → gate by name. Details in `docs/MEMORY.md`.
- Docs corrected: TrueForge sandbox options (local sandbox / Daytona; no Docker or K8s provider).

- Vishnu added keys: model **`google-gemini/gemini-3-6-flash`**; connector **`github`** (PAT).
- Verified with throwaway API sessions (not saved agents):
  - live GitHub MCP = 45 tools, matches source; PAT authenticates.
  - sandbox `exec` ran code (exit 0); sandbox reaches GitHub (`humanize` HEAD `392aef7`) and PyPI; can't read `~/Documents`.
  - `require_approval_for_tools: ["get_me"]` paused with `tool.approval_required`; denied via `user.tool_approval`.
- Gotchas in `docs/MEMORY.md`: sandbox is off by default (`config.sandbox.enabled: true`), turn input type is `user.message`.

**Next (12:00, not before)** — Ticket Resolver per the entry below. Daytona: add the key under Sandbox providers when it arrives.

---

## 2026-09-26 00:50 — Vishnu + Claude — target repo switched to `vishnuverse/humanize`

**Done**
- Target repo is now the fork **`vishnuverse/humanize`** (of `python-humanize/humanize`). `vishnuverse/tinyshop` is unused.
- Checked the fork: `main` matches upstream, but it has **no tags** and **Issues are disabled**. Suite: 746 passed,
  110 skipped in ~9 s locally (~1 s with `--benchmark-disable`). Facts in `docs/MEMORY.md`.
- Docs updated: `docs/SPEC.md`, `docs/IMPLEMENTATION_PLAN.md`, `AGENTS.md`, `CLAUDE.md`, `README.md` (new "Target repo" section
  with the fork setup and planted fixtures), `docs/MEMORY.md`.

**Tonight checklist changes**
- Scope the GitHub fine-grained PAT to `vishnuverse/humanize`, not `tinyshop`.
- TestPyPI name to check (only if Release Captain): `shipgate-humanize`.

**Next steps (12:00)** — replaces step 1 of the entry below
1. B, ~10 min: push upstream tags to the fork, enable Issues, commit the planted regression(s), open issues #1–#5,
   labels, ruleset on `main` (no bypass). Steps in `README.md` → Target repo.

**Scenarios passing**: none yet

---

## 2026-09-26 00:30 — Vishnu + Claude — scope switched to Ticket Resolver first

**Done**
- Priority changed: **Ticket Resolver (P0) → Runbook Executor (P1) → Release Captain (optional)**. `docs/SPEC.md`,
  `docs/IMPLEMENTATION_PLAN.md`, `AGENTS.md`, `CLAUDE.md`, `README.md` and `docs/MEMORY.md` updated to match.
- Organisers' submission checklist + official scoring added and highlighted in `README.md` and `CLAUDE.md`.

**Tonight checklist changes** (see the list below)
- TestPyPI is now only needed if Release Captain gets built.
- `kind` + `kubectl` move from stretch to P1: install and smoke-test tonight.
- Check GitHub MCP names/annotations for `create_pull_request`, `add_issue_comment`, `push_files`, `create_branch`.
- *Optional:* Jira Cloud free site, enable API-token auth for the Rovo MCP server, create an API token.

**Next steps (12:00)** — replaces the list in the entry below
1. Write `tinyshop` with the seeded defects; open issues #1–#5; labels; ruleset on `main` (no bypass).
2. Register model, GitHub MCP, Daytona in TrueForge; record tool names; gate `create_pull_request` + `add_issue_comment` by name.
3. Write `skills/ticket-resolver/SKILL.md`; get T2–T8 working in chat on issue #1.
4. `scripts/reset.sh` + `scripts/check.py` for TR-01/03/05/06.

**Scenarios passing**: none yet

---

## 2026-09-25 (night before) — planning complete, no code yet

**State**
- Plan, research and test catalogue in `README.md`. Scope and requirements frozen in `docs/SPEC.md`.
- Repo skeleton docs only: `CLAUDE.md`, `docs/SPEC.md`, `docs/HANDOVER.md`, `docs/MEMORY.md`, `AGENTS.md`, `.claude/rules/`.
- No application code — hackathon rules forbid pre-built work. Coding starts 12:00 IST Sat 26 Sep.

**Tonight checklist (accounts/keys only)**
- [x] Empty public repo `vishnuverse/tinyshop` created (README only) so the PAT can be scoped to it. Code + seed PRs at 12:00.
- [ ] Daytona account + API key with **Sandboxes + Snapshot-create** permissions; test it in TrueForge Settings.
- [ ] GitHub fine-grained PAT (Contents, Issues, Pull requests: read/write) scoped to `tinyshop` only.
- [ ] TestPyPI account + API token; confirm name `shipgate-tinyshop` is free.
- [ ] Model key (OpenAI credits on the day; Gemini/Groq as backup).
- [ ] `npx @truefoundry/trueforge@0.2.1` starts on :8790 (Node >= 22.14).
- [ ] `kind` / `k3d` + `kubectl` installed (stretch).
- [ ] Check how GitHub MCP annotates `create_tag` / release tools (decides the explicit gate list).
- [ ] Team roles agreed: A agent+skill, B repo+registry MCP+tests, C infra (stretch), D demo+README.

**Blockers**
- None known. Risk: Daytona snapshot build on first config can be slow — do it tonight.

**Next steps (12:00)**
1. Create `tinyshop` repo, tag `v1.3.0`, seed PRs (see README fixtures).
2. Register model, GitHub MCP, Daytona in TrueForge; list gated tools by name.
3. Write `skills/release-captain/SKILL.md`; get C2–C8 working in chat.
4. Build `mcp/registry` (TestPyPI publish, `destructiveHint`).

---

<!-- Template for each new entry
## YYYY-MM-DD HH:MM — <who> — <one-line summary>
**Done**
-
**In progress** (file + what's half-finished)
-
**Blockers**
-
**Next steps** (ordered)
1.
**Scenarios passing**: TR-.. / RE-.. / RC-..
-->
