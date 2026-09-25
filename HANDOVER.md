# HANDOVER.md

Relay baton between sessions (human or Claude). Update at the end of every work block. Newest entry on top.

---

## 2026-09-25 (night before) — planning complete, no code yet

**State**
- Plan, research and test catalogue in `README.md`. Scope and requirements frozen in `SPEC.md`.
- Repo skeleton docs only: `CLAUDE.md`, `SPEC.md`, `HANDOVER.md`, `MEMORY.md`, `AGENTS.md`, `.claude/rules/`.
- No application code — hackathon rules forbid pre-built work. Coding starts 12:00 IST Sat 26 Sep.

**Tonight checklist (accounts/keys only)**
- [ ] Daytona account + API key with **Sandboxes + Snapshot-create** permissions; test it in TrueForge Settings.
- [ ] GitHub fine-grained PAT (Contents, Issues, Pull requests: read/write) scoped to `tinyshop` only.
- [ ] TestPyPI account + API token; confirm name `shipgate-tinyshop` is free.
- [ ] Model key (OpenAI credits on the day; Gemini/Groq as backup).
- [ ] `npx @truefoundry/trueforge@latest` starts on :8790 (Node >= 22.14).
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
**Scenarios passing**: RC-.. / RE-..
-->
