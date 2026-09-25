# docs/HANDOVER.md

Relay baton between sessions (human or Claude). Update at the end of every work block. Newest entry on top.

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
