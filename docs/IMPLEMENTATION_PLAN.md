# docs/IMPLEMENTATION_PLAN.md — 2 contributors

Scope for a 2-person team: **Ticket Resolver first** (SPEC §4), then **Runbook Executor** (SPEC §5).
**Release Captain is optional** (SPEC §6) and has no slot in this timeline.
Build window: Sat 26 Sep 2026, 12:00–19:00 IST. Submit by 18:45 (15 min buffer).

## Roles
| | Contributor A — Agent owner | Contributor B — Systems & quality owner |
| --- | --- | --- |
| Owns | TrueForge config, `agents/`, `skills/`, approvals UX, orchestrator, demo driving | `vishnuverse/humanize` fork + fixtures, `demo-app/`, `mcp/k8s/`, kind cluster, `scripts/`, `tests/`, `runbooks/`, README, build story |
| Folders (no overlap) | `agents/`, `skills/`, `orchestrator/` | `demo-app/`, `mcp/`, `runbooks/`, `scripts/`, `tests/`, `README.md` |
| Shared (announce before editing) | `docs/SPEC.md`, `docs/HANDOVER.md`, `docs/MEMORY.md`, `.env.example` | same |

Git: both on `main`, small commits, conventional-commit messages, `git pull --rebase` before every push. Folder
ownership means conflicts should be near zero.

---

## Phase 0 — Tonight (Fri 25 Sep) · accounts only, no project code
| A | B |
| --- | --- |
| Daytona key (Sandboxes + Snapshot-create), test in TrueForge Settings | GitHub fine-grained PAT scoped to `vishnuverse/humanize` only (Contents, Issues, PRs r/w) — the fork already exists |
| Model key (OpenAI credits on the day; Gemini backup) | `kind` + `kubectl` installed; `kind create cluster` works, then delete it |
| `npx @truefoundry/trueforge@0.2.1` runs on :8790 (Node >= 22.14) | Python 3.12 + `uv` installed; `pip download fastmcp` works |
| Check GitHub MCP names + annotations for `create_pull_request`, `add_issue_comment`, `push_files`, `create_branch` | *Optional:* Jira Cloud free site, API-token auth enabled for the Rovo MCP server, API token created |
| Read `trueforge.dev/api/use-agent` (approval events) | Read `trueforge.dev/mcp-servers` (custom server auth) |

**Exit:** both laptops can start TrueForge; all keys in a shared password manager (never in chat or git).
TestPyPI is only needed if Release Captain gets built.

---

## Phase 1 — Foundations · 12:00–12:45
| A | B |
| --- | --- |
| Configure TrueForge: model, Daytona sandbox, GitHub remote MCP (header auth) | Prepare the fork (`docs/research-and-plan.md` → Target repo): push the upstream tags (the fork has **none**), enable Issues, commit the planted regression(s) and disclose them |
| Open Select MCP Tools: record exact tool names + annotations → `docs/MEMORY.md` | Open issues #1–#7 (docs/SPEC.md §4.6); labels `bug`, `triaged`, `fix-proposed`, `cannot-reproduce`, `needs-human` |
| Create draft agent `ticket-resolver` in UI; chat test: "read issue #1 and list the repo files" | Ruleset on `main`: PR required, block direct + force push, **no bypass list**. Time `pytest -q` once in Daytona |

**Sync 12:45 (5 min):** A shows the agent reading issue #1 from `vishnuverse/humanize`. B confirms tags, issues, labels and ruleset.
**Cut line:** if the Daytona sandbox isn't working by 12:45, A switches to fixing it and B takes the agent draft.

---

## Phase 2 — Core agent · 12:45–14:15
| A — `skills/ticket-resolver/SKILL.md` + `agents/ticket-resolver.json` | B — scripts + scenarios |
| --- | --- |
| T2 parse ticket, T3 scope check, T5 pin SHA | `scripts/reset.sh`: close agent PRs, delete `fix/*` branches, delete agent comments, restore labels; idempotent |
| T6 sandbox: full clone (never `--depth`) + `git fetch --tags`, checkout SHA, `pip install -e ".[tests]"` | `scripts/check.py`: asserts PR (branch, test file, body evidence), comments, labels → PASS/FAIL |
| T7 failing test ×3 (×10 if intermittent) | `tests/scenarios/TR-01.yaml`, `TR-03.yaml`, `TR-05.yaml`, `TR-06.yaml` with expected approvals |
| T8 minimal patch, new test ×3 + full suite | Verify the ruleset: a push to `main` with the PAT is **rejected** |
| Register skill (git-backed, this repo) and attach to agent | Seed a clean `reset.sh` → run cycle |

**Sync 14:15 (10 min):** full dry run in chat on issue #1 — agent shows the failing test, the patch and green suite,
**no gated calls yet**. B shows `reset.sh` + `check.py` on a hand-made PR.
**Cut line:** if intermittent handling (#4) is slow, drop it to "report hit rate only, no patch".

---

## Phase 3 — Gates + first real fix · 14:15–15:30
| A | B |
| --- | --- |
| `require_approval_for_tools`: `create_pull_request`, `add_issue_comment` **by name**; `merge_pull_request` + `issue_write` not enabled | Run TR-01 end to end with `check.py` |
| T10/T11 evidence card (Generative UI table) before each gate | TR-03 (cannot reproduce) and TR-06 (injection #5) |
| T9 push to `fix/issue-<n>`; T13 deny-with-reason → revise once → re-request | TR-05 (deny PR) — expected approvals list matches exactly |

**Milestone 15:30:** **TR-01 passes for real** — PR from `fix/issue-1` with a failing→passing test, then a reply on
issue #1, each after one approval. Commit + push everything; update `docs/HANDOVER.md`.
**This is the minimum demoable product. Everything after this is improvement.**

---

## Phase 4 — Hardening (A) + Runbook infra (B) · 15:30–16:45
| A — Ticket Resolver | B — Runbook Executor infra |
| --- | --- |
| TR-02 (second planted bug), TR-04 (intermittent hit rate), TR-09 (duplicate PR) | `demo-app/`: tiny web app over `humanize` (`/humanize`, `/health`, `/version`); build a good and a broken image, `kind load` both; deployment `api`, ConfigMap `flags` |
| Orchestrator (TS, SDK): `bug` label → session → approvals in terminal → `approvals.log` → handoff JSON → flip label | `mcp/k8s/server.py`: `get_status`, `scale` (reversible), `set_flag` (reversible), `deploy`, `rollback` (destructive), `lock/unlock`; streamable HTTP :8801 |
| If the orchestrator runs long: skip it, drive the demo from the TrueForge UI (still scores on harness) | `tests/mcp/test_k8s.py`; `runbooks/deploy.md` |
| Handoff JSON enforced (`response_format` via API if the model drifts) | Add `k8s` MCP to TrueForge as a custom server (no auth, localhost) |

**Sync 16:45:** `reset.sh` → full TR-01 (via orchestrator or UI). Decide: Runbook Executor or polish.

---

## Phase 5 — Runbook Executor OR polish · 16:45–17:45 (pick one at 16:45)
**Runbook Executor (only if TR-01/03/05/06 are all green):**
- A: `skills/runbook-executor/SKILL.md` (E1–E9) + `agents/runbook-executor.json`; `deploy`, `rollback` gated by name.
- B: RE-01 (classification), RE-02 (happy deploy), RE-03 (auto rollback via the broken `demo-app` image failing `/health`) with `check.py`.
- **Cut line 17:30:** if RE-01 isn't green, leave it out of the demo; keep the code marked WIP in the README.

**Polish (otherwise):**
- A: cost/tokens per run from the Sessions page → one number for the demo. *Optional:* Jira as the ticket source.
- B: README "runs on a fresh laptop" — B follows it on A's machine from scratch; fix every gap. AI-use disclosure.

Release Captain stays optional: only if everything above is green before 17:00. If built: rename the package to
`shipgate-humanize` in `pyproject.toml` (`chore: rename for demo registry`); the next version follows the last tag `4.16.0`.

---

## Phase 6 — Demo + submit · 17:45–19:00
| Time | A | B |
| --- | --- | --- |
| 17:45–18:15 | Rehearse the 5-min demo ×2 (script below); each of us explains the architecture once unaided (judges will ask) | Record a backup screen capture of a clean run showing the Daytona run and the approval pause; check no keys are on screen; trim with ffmpeg |
| 18:15–18:40 | Architecture slide: sandbox (no keys) · MCP (keys) · named gates · ruleset on `main` · blast radius if the agent is wrong | Final README, results table (scenario IDs passed), push |
| 18:40–18:45 | **Submit** | Build-story post draft (₹50k prize) |

**Demo script (5 min):**
1. Architecture in 30 s — what the agent can and can't do alone.
2. Label issue #1 `bug` → agent reads it, clones the `humanize` fork in Daytona, writes a failing test (`ordinal(12)` → `12nd`), runs it 3× (red).
3. Agent patches → 3× green + full suite → evidence card → **approve PR** → PR on GitHub with the test.
4. Reply draft → **deny** ("don't promise a release date") → agent revises → approve reply.
5. Issue #3 → honest "could not reproduce" + one question. Issue #5 → typo fixed, injection flagged, no merge possible.
6. *(If built)* Runbook Executor on kind: reversible steps auto, stops at `deploy`, broken image fails `/health` → asks to `rollback`.
7. Close: scenario pass table, approvals count, cost per run.

---

## Definition of done (submission)

> [!IMPORTANT]
> Every box below maps to the organisers' 5-item checklist at the top of `README.md`. Missing item 1 (harness visibly working) disqualifies the project.

- [ ] TR-01, TR-03, TR-05, TR-06 pass via `check.py` (TR-02, TR-04, TR-09 nice to have)
- [ ] One live real fix PR + reply after approvals, visible on GitHub
- [ ] Gated tools listed by name; sandbox holds zero credentials; `main` ruleset has no bypass
- [ ] **Demo and backup video show where the code ran (Daytona) and the agent stopping for approval**
- [ ] **No keys in the repo, screenshots or demo video** (`.env` gitignored; never film `.env` or TrueForge Settings)
- [ ] **Only our own accounts, data and keys connected**
- [ ] README runs on a fresh laptop; AI assistance disclosed
- [ ] `docs/HANDOVER.md` final entry; public repo pushed before 18:45

## Fallbacks
| Problem | Fallback |
| --- | --- |
| Daytona slow/failing | Smaller snapshot; if dead by 13:30, ask organisers — sandbox is mandatory, don't fake it |
| Sandbox build shows version `0.1.dev1` | The clone was shallow or had no tags: full clone + `git fetch --tags`, and check the fork has the upstream tags |
| GitHub MCP lacks `push_files` or needs a different branch tool | Use `create_or_update_file` per file on `fix/issue-<n>`; still ungated because `main` is protected |
| Ruleset can't block the owner's token | Gate `push_files` + `create_branch` by name as well (one more approval) and record it in `docs/MEMORY.md` |
| Model rate limits | Switch provider in TrueForge (custom OpenAI-compatible) — config only |
| kind or `k8s` MCP not ready at 16:45 | Skip Runbook Executor; polish Ticket Resolver instead |
| Running late at 16:45 | Skip Phase 5 entirely; go straight to demo prep |
