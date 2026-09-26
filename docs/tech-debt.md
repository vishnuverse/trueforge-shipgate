# Critique and tech debt (26 Sep 2026, 15:30–16:30 IST)

Written after running the whole current flow (unit tests, `setup.sh`, doctor, a live `score.sh TR-01`) and auditing
orchestrator, skill, triage MCP, scorer and scripts, before adding Jira. Every item was checked against the code;
line numbers are at `f11ab33`. "Fixed" means fixed on `feat/jira`.

## Run-through result

| Step | Result |
| --- | --- |
| `uv run pytest -q` / `npm --prefix orchestrator test` / typecheck | 158 passed / 110 passed / clean |
| `scripts/setup.sh` + `--check` | all ✓ (but see F1: it passed on a target the token could not write) |
| `scripts/score.sh TR-01` on `drax0945/humanize` | **reset failed: 403** on close PR, delete branch, set labels |
| `scripts/score.sh TR-01` on `vishnuverse/humanize` | **PASS 34/34** (session `01m3ek33m1v50p78yysba46b8s`), incl. the new summarize-before-Jev step |
| `check.py --all --regrade --offline` | 19/75: every saved run predates the current target and skill (F2) |

## Flow-level findings

| # | Sev | Finding | Evidence | Status |
| --- | --- | --- | --- | --- |
| F1 | High | The doctor proves the GitHub token can **read** the target, never that it can **write**. The 15:25 switch to `drax0945/humanize` passed `setup.sh --check`, then every write 403'd — the agent could not have opened a PR there. | `scripts/setup.sh` ("GitHub token reads …"); reset log | Target reverted to `vishnuverse/humanize` (`f11ab33`). Doctor write check deferred (add a `GET /repos/{repo}` `permissions.push` check). |
| F2 | High | The saved scorecard is stale: newest grade per scenario is 00:19–06:05 UTC, before triage, any-repo and summarize-before-Jev; TR-02/11/14 last saved with run-level FAILs. `check.py --all` reports old truth. | `runs/TR-*/<ts>/check.json` | Deferred: run the must-pass set again before submission. |
| F3 | Med | `shipgate.local.yaml` silently shadows `shipgate.yaml` in every loader, and `setup.sh` still prints "shipgate.yaml: target …". Editing `shipgate.yaml` then has no effect on this machine. | `scripts/shipgate_config.py` `config_path()`, `orchestrator/src/config.ts` `configPath()` | Deferred: print the file actually loaded. |
| F4 | Med | H4 habit: the agent reaches for `mcp_client` in the sandbox (TR-01, TR-06 earlier). Mitigation is prompt-only. Jira adds another ungated read reachable from Code Mode. | earlier H4 FAILs; `docs/MEMORY.md` Code Mode | H4 also flags `atlassian.net` / `JIRA_` / `ATATT` (Jira slice). Prompt-only mitigation remains. |
| F5 | Med | Triage policy `triage-v1` questions name humanize; on any other repo most tickets are held `uncertain`. Fine for the KAN tickets (same repo). | `mcp/triage/policy.py:22-26,40-41` | Known limit, deferred (`triage-v2`). |
| F6 | Med | Atlassian's MCP is site-wide: it cannot be pinned to one project the way `owner/repo` pins GitHub, and v2 exposes generic `executeWrite`/`executeDestructive` runners that would bypass per-tool gates. | `GET /api/v1/mcp-servers/jira/tools` | Mitigated: dedicated account + site, named allowlist of 2 tools, comment gated by name, key/cloudId warning at the gate, scorer T14-J + never-enabled list. |
| F7 | Low | TrueForge `auth_status: authenticated` only means a header is configured. `/v1/mcp` "authenticated" but exposed no Jira tools. | spike, `docs/MEMORY.md` Learned facts (Jira) | Documented; doctor could list tools (deferred). |

## Code-level debt

| Sev | Item | Evidence | Status |
| --- | --- | --- | --- |
| High | Seven `.env` readers disagree (inline comments, quotes, `export`, `\n` escapes, `KEY = v`); the triage server ignored `SHIPGATE_ENV_FILE`, so preflight could pass while triage had no key and held every ticket (the same class as the 15:01 I1 bug). | `mcp/triage/server.py:52-72`, `scripts/shipgate_check/clients.py:168-182`, `orchestrator/src/env.ts:25-44`, `scripts/setup_agents.ts:114-122`, `scripts/setup_trueforge.ts:19-20`, `scripts/reset.sh:56-59`, `scripts/setup.sh:42-47` | Triage honours `SHIPGATE_ENV_FILE` (Jira slice). One shared reader + a parity test deferred. |
| Med-High | Policy name `triage-v1` hard-coded in scorer and skill; a `triage-v2` makes S9/S10/`expect.triage` fail closed. | `scripts/shipgate_check/checks.py:481,542`, `constants.py:118`, SKILL.md | Deferred |
| Med | H3 and S1 only look at the `github` server; direct calls are recognised only by GitHub tool names. A gated call on any other server went ungraded. | `checks.py:191,647`, `events.py:277` | Fixed (Jira slice) |
| Med | Approval-prefix parsing: TypeScript is case-sensitive, Python upper-cases; the test factory writes the Python value so the drift never shows. | `orchestrator/src/protocol.ts:15-17`, `events.py:217-223`, `tests/check/runfactory.py:238` | Deferred |
| Med | The sync triage tool blocks FastMCP's event loop for up to ~105 s; `score.sh`'s 3 s probe can then report it down. | `mcp/triage/server.py:152`, `scripts/score.sh:59` | Deferred |
| Med | `scripts/bakeoff.py` sends unrendered templates (46 `{{…}}`) and no triage server, so it can never patch. | `scripts/bakeoff.py:71-87` | Deferred; treat as broken |
| Med | Git-skill mode registers the raw template path, so the sandbox would see literal `{{repo}}`. | `scripts/setup_agents.ts:391-399` | Refused when a skill is templated (Jira slice) |
| Med | Scorer hard-codes `main`, `src/`, `tests/`, `localhost:8790` although `shipgate.yaml` names them. | `checks.py:414,418,911,1086,1110`, `clients.py:128`, `constants.py:23` | Partly (test file path per ticket); rest deferred |
| Low-Med | Gate, label and port lists duplicated with no cross-check test; the scorer loads config and raises `SystemExit` at import time. | `constants.py:10-14`, `orchestrator/src/labels.ts:9`, `scripts/setup.sh:95` | Gates split per agent (Jira slice); rest deferred |
| Low-Med | TR-03 expectations are weak (a TypeSafe outage also passes); S8/S9 trust the first verdict and allow an exec in the same message. | `tests/scenarios/TR-03.yaml:12-14`, `checks.py:492,512,519` | Deferred |
| Low | Exit code 2 means both "config error" and "timeout"; a corrupt `check.json` aborts `--all`. | `orchestrator/src/cli.ts:188`, `runner.ts:23`, `scripts/shipgate_check/cli.py:121` | Deferred |
| Low | Dead code: `ENABLED_TOOLS`, `PREFIXES`, `turnsFromEvents`, `exampleMask`. | `constants.py:26,126`, `events.ts:153`, `render.ts:43` | Deferred |
| Low | Doc drift: contracts says `check.py` reads `approvals.log`; triage audit keys miss `context_sha`. | `docs/contracts.md:12,166` | Deferred |
| Low | Hygiene: `.DS_Store` / `.env.*` not ignored; 3 stale `.claude/worktrees/agent-*`; `approvals.log` never rotated; uncommitted edits in `tests/fixtures/humanize/issues/{1,2,4,6}.md` since 08:30; a machine-specific `PATH` in `.claude/launch.json`. | `.gitignore`, `git worktree list` | `.gitignore` fixed; rest listed for the team |
| Added | The Jira skill is a copy of the GitHub skill and can drift. | `skills/ticket-resolver-jira/SKILL.md` | Parity test guards section/rule/step numbering; converge to one template later |

## Suggested order after the hackathon

1. Doctor checks write access and prints the config file it loaded (F1, F3).
2. One `.env` reader per language with a shared fixture test.
3. Fresh must-pass pass and a scorecard that ignores grades older than the current skill hash (F2).
4. `triage-v2` with generic questions, the policy name read from one constant.
5. Async triage tool; approval-prefix parity test.
