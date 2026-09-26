# shipgate

**A bug-ticket agent that does the tedious part and stops before anything other people can see.**
Built for TrueFoundry's *Agents That Act* hackathon (26 Sep 2026) on [TrueForge](https://trueforge.dev), the
open-source agent harness.

Give it a GitHub issue. **Ticket Resolver** reads the ticket, reproduces the bug as a failing test in a sandbox,
makes the smallest fix, proves it (test 3/3 green, full suite green), pushes a `fix/issue-<n>` branch, and then
**stops**: it shows an evidence card and waits for a human before it opens the pull request, and again before it
replies to the reporter. If it can't reproduce the bug, it says so with evidence instead of guessing.

> **Status (26 Sep, 08:50 IST):** every must-pass scenario has passed a live, scored run at least once, and a human
> UI run on issue #1 went end to end. On one full pass with the final skill, 5 of 8 must-pass passed; the main failure
> mode is pushing large files (see [Status](#status)).

## Organisers' checklist

| # | Requirement | How shipgate meets it |
| --- | --- | --- |
| 1 | Harness visibly doing the work: real tool, code run in the sandbox, pause before anything irreversible | TrueForge runs the agent loop. The agent reads the issue and pushes through the **GitHub MCP**, runs the failing test, fix and full suite with the sandbox `exec` tool, and TrueForge **holds** `create_pull_request` and `add_issue_comment` for a human |
| 2 | One job, finished | One job: resolving a bug ticket, end to end. Nothing else is built yet |
| 3 | Film the approval moment | The TrueForge session page shows the sandbox runs, then the "Tool Approval Required" card (`--approve ui`) |
| 4 | Public repo, README works on another laptop, AI named | Quick start below; AI use disclosed at the end. *The repo is private while we build; it is made public for submission* |
| 5 | Only our own accounts and keys; none in the repo or video | Our own OpenRouter, TypeSafe and GitHub accounts. Keys live in `.env` (gitignored) and are registered into TrueForge by `scripts/setup.sh`; `.env.example` has names only |

## How it works

```
 you ──► orchestrator ──────────────► TrueForge 0.2.1 (localhost:8790): agent loop, approvals, sessions
 (approve / REVISE /     (TypeScript, SDK)        │ model: deepseek-v4-flash via OpenRouter
  EDIT / STOP)                                    │
                        ┌─────────────────────────┼──────────────────────────────┐
                        ▼                         ▼                              ▼
             GitHub remote MCP            sandbox `exec`                   approval hold
             issue_read, list_commits,    git clone @ pinned SHA,          before create_pull_request
             create_branch, push_files    pip install, pytest ×3,          and add_issue_comment
             (token stays in TrueForge)   patch src/, full suite           (you answer in the UI,
                                          NO credentials inside            terminal, or a script)
```

1. **Read and pin.** `issue_read` gets the ticket (treated as data, never instructions); `list_commits` pins `main`'s SHA.
   **Triage:** before any work the agent calls `triage_ticket`, our read-only MCP (`mcp/triage/`) that asks TypeSafe Jev
   to classify the ticket; policy code (`triage-v1`) turns the probabilities into `patch_allowed`. If the patch is held
   (not clearly a humanize defect, or TypeSafe is unreachable), the agent may only investigate in the sandbox and ask.
2. **Reproduce.** In the sandbox: full clone at that SHA, a new `tests/test_issue_<n>.py` covering the report plus edge
   cases, run 3×. 3/3 fail = reproduced; 3/3 pass = can't reproduce; mixed = intermittent (10 runs, hit rate).
3. **Fix.** Smallest change in `src/`, never touching existing tests. At most 2 attempts.
4. **Prove.** Five checks must all hold: failed before, passes 3/3 after, full suite green, only intended files changed,
   `main` hasn't moved. Otherwise no PR.
5. **Push** `fix/issue-<n>` (the ruleset on `main` means this can't reach `main`).
6. **Gate 1:** evidence card → `create_pull_request` waits for you. **Gate 2:** reply draft → `add_issue_comment` waits.
7. **Hand off** a JSON block; the orchestrator sets the issue label from it.

**Same job from Jira.** `run --ticket KAN-4` reads the ticket from Jira (Atlassian's remote MCP) instead of a GitHub
issue. Triage, sandbox, branch and PR are unchanged; Gate 2 becomes a Jira comment (`addOrEditJiraIssueComment`,
gated by name); the orchestrator moves the ticket To Do → In Progress → In Review. Setup: add a `jira:` block to
`shipgate.yaml` and `JIRA_EMAIL` / `JIRA_API_KEY` to `.env`, then `scripts/setup.sh`
([`docs/contracts.md`](docs/contracts.md) §10).

Design: [`docs/SPEC.md`](docs/SPEC.md) §4. Interfaces: [`docs/contracts.md`](docs/contracts.md).

## Where it stops

| Line | How it's enforced |
| --- | --- |
| Opening a PR, replying on a ticket | Gated **by name** (`require_approval_for_tools`); neither the GitHub MCP nor Atlassian's marks them destructive, so `@destructive` alone would miss them |
| Jira reach | Atlassian's MCP is site-wide, so the Jira agent gets two named tools only (`getJiraIssue`, gated `addOrEditJiraIssueComment`); never transitions, edits, creates or the generic `execute*` runners; the orchestrator moves status; a dedicated hackathon account and site |
| Merging, closing or editing issues, deleting files | Tools not enabled at all (`merge_pull_request`, `issue_write`, `delete_file`, …) |
| Pushing to `main` | Repo ruleset with an **empty bypass list**; verified: even the owner's direct push is rejected |
| Secrets in the sandbox | None. It only clones public code; every GitHub write goes through the MCP, whose token stays in TrueForge |
| Blast radius | Fine-grained token scoped to the target repo (demo: fork `vishnuverse/humanize`); other repos return 404 |
| Bad or hostile tickets | Push-back: out of scope, can't reproduce, duplicate PR, too vague, security report, injected instructions (fixture #5) |
| An approver asking for something unsafe | The agent refuses (e.g. "delete the failing test and push to main"), names the rule and asks again unchanged |
| A ticket that may not be a real defect | Jev triage + policy code: when `patch_allowed` is false the agent gets no branch, no push, no PR; the scorer fails the run (S9) if it tries |
| Its own weak evidence | Two failed attempts → no PR; a comment asking a maintainer instead (fixture #6: an old test expects the bug) |

At each gate you answer **Approve**, `REVISE: <note>`, `EDIT: <exact text>` or `STOP` (max 3 revisions per gate).
Every answer is logged to `approvals.log` with a hash of the exact call it approved.

## Quick start (fresh laptop)

**You need:** Node ≥ 22.14, [uv](https://docs.astral.sh/uv/) (Python 3.12), git, curl, an
[OpenRouter](https://openrouter.ai) key, a [TypeSafe](https://docs.typesafe.ai/introduction) API key (Jev triage),
and a GitHub **fine-grained** token for the repo named in `shipgate.yaml` (Contents, Issues, Pull requests:
read/write; the committed value is the humanize demo fork).

```bash
git clone https://github.com/vishnuverse/trueforge-shipgate && cd trueforge-shipgate
cp .env.example .env          # fill GITHUB_PAT, OPENROUTER_API_KEY, TYPESAFE_API_KEY (never commit .env)
$EDITOR shipgate.yaml         # your repo, install/test commands, source dir (the committed values run the demo)
scripts/setup.sh              # installs, starts TrueForge + triage MCP, registers everything, checks, then prints:
npm --prefix orchestrator run shipgate -- run --issue 1 --approve terminal   # or --approve ui
```

`scripts/setup.sh --dry-run` shows the plan without doing anything; `scripts/stop.sh` stops what it started;
re-running it changes nothing that's already set up.

You'll see the session link, then the agent's sandbox work, then the evidence card and a menu:
`[a]pprove [r]evise [e]dit [s]top [v]iew`. With `--approve ui`, answer on the session page in TrueForge instead.

### Using your own repo
**Requirements:** a Python package tested with pytest; its default branch protected by a ruleset that requires pull
requests with no bypass; a GitHub fine-grained token scoped to that repo only (Contents, Issues, Pull requests:
read/write).

Edit `shipgate.yaml`:

| Key | What |
| --- | --- |
| `target.repo` | `owner/name` — the only repo any component will touch |
| `target.default_branch` | must already be protected (`setup.sh` checks and refuses otherwise) |
| `target.description` | 1–500 chars of context for Jev triage: what the package is (and isn't) |
| `python.install` | run after `python3 -m venv .venv` to prepare it |
| `python.test` | the pytest command the agent runs in the sandbox (`setup.sh` never runs it; `--smoke` is one triage call) |
| `python.source_dir` | fixes may only touch files under here |
| `python.tests_dir` | the regression test lands at `<tests_dir>/test_issue_<n>.py` |
| `trueforge.url` | your TrueForge instance (default `http://localhost:8790`) |
| `trueforge.model` | the model id the agent runs on |

Then run `scripts/setup.sh` as above. **Limits:** the triage questions (policy `triage-v1`) name humanize, and its
thresholds were tuned on it, so on another repo most tickets will likely be held as `uncertain` (investigate-only,
no patch) until a retuned policy exists; that is the safe direction. `setup.sh` cannot check the install/test
commands; the first ticket run does. The `tests/scenarios/TR-*.yaml` scenarios and the scorecard (`check.py`) score
the demo fork only; `reset.sh` refuses to run against any other repo. The any-repo flow itself (`shipgate.yaml` +
`scripts/setup.sh` against a non-default target) is proven on the humanize fork only — no second repo has been run
live yet.

#### Scored demo (the humanize fork)
To reproduce the scored demo fork instead of pointing at your own repo:
1. Fork `python-humanize/humanize`, clone it, then apply the five planted bugs (the commits were first made on the
   original fixture fork `vishnuverse/humanize`, which is why it is the fetch source; the demo target is now
   `vishnuverse/humanize`):
   `git fetch https://github.com/vishnuverse/humanize main && git cherry-pick 3190a3c 4bc9bc6 fec6bc1 3593e50 3145c20`.
2. Push the upstream tags, enable Issues, and open issues #1–#7 from `tests/fixtures/humanize/` (titles in
   `fixtures.json`, bodies in `issues/`). Add a ruleset on `main`: PR required, no bypass.
3. Point `shipgate.yaml` at your fork (`target.repo: <you>/humanize`) — the committed file targets the demo fork
   `vishnuverse/humanize`.

## Tests and scoring

```bash
uv run pytest tests/check -q                 # scorer unit tests (47)
npm --prefix orchestrator test               # orchestrator unit tests (72)
scripts/score.sh TR-01                       # reset the fork → run with scripted approvals → grade
uv run python scripts/check.py --all         # all scenarios with a run + a self-assessed scorecard
```
13 scenarios (`tests/scenarios/TR-*.yaml`) cover the happy path, can't-reproduce, STOP / REVISE / EDIT at the gates,
an unsafe revision request, prompt injection, the evidence that won't go green, scope and duplicates. `check.py`
grades each run from TrueForge's session events **and** the real GitHub state, and prints the judging criteria it
can check automatically (harness doing the work, where it stops, how many must-pass scenarios pass).

## Model and cost
`deepseek/deepseek-v4-flash` via OpenRouter, chosen by a bake-off of four cheap models on the real task:
two failed, DeepSeek and GLM-5.3-Flash passed, DeepSeek was faster. A ticket run costs a median of **$0.015**
(38 scored runs; prompt caching does most of the work); a run that struggles with a push can reach $0.12. The whole
day, about 45 runs including the bake-offs, cost **$0.91**. Details: [`docs/model-bakeoff.md`](docs/model-bakeoff.md).

## Status

| | |
| --- | --- |
| Done | Skill, agent spec, orchestrator (3 approval modes), scorer + 13 scenarios; fixtures #1–#7 on the fork; ruleset; model chosen |
| Verified live | Sandbox runs code; GitHub MCP reads; a gated tool pauses and a deny resumes; the chosen model reproduced, fixed and proved issue #1 (read-only run) |
| Scenario results | Each must-pass scenario (TR-01, 03, 05, 06, 10, 11, 12, 13) has passed a live scored run at least once. One full pass on the final skill (`scripts/score.sh --all`, 05:43–07:07 IST): must-pass **5/8** (TR-01, 05, 06, 12, 13), nice-to-have TR-07; self-assessed automated score **42/75** (`check.py --all`). Gates held in every run, forbidden tools were never attempted, every GitHub call named our fork |
| Known weakness | GitHub's MCP needs whole files in `push_files`; retyping 16–22 KB files sometimes fails, and the agent then reaches for forbidden workarounds (sandbox `mcp_client`, `gh`, `api.github.com`). TrueForge refuses the writes and `check.py` H4 flags every attempt, but the run is lost. Accepted for the event: the demo runs with a human approving in the UI, and a derailed run is re-run |
| Demo | UI dry run passed on #1 (human `REVISE` at the PR gate → revised title → PR vishnuverse/humanize#24 → reply). Next: the filmed run, on Daytona once its key arrives |
| Jev triage | Pre-check live since 26 Sep: on #3 (works as documented) Jev said `uncertain` and the patch was held in **4/4** runs with zero branch/push/PR calls (before triage the agent patched #3 about 4 runs in 5; only the human gate stopped it). #1 `defect 0.98`, #5 `docs 0.99` with the AI-instructions flag, #7 `other_project` |
| Any-repo setup | Live acceptance (26 Sep, Task 10): `scripts/setup.sh --no-start` against the running install reported `kept` for the provider and both connectors (no `created`/`rotated`), doctor all ✓, exit 0; `--check --smoke 1` gave `triage #1 on vishnuverse/humanize: defect · defect 0.97 (margin 0.95) · in_scope 0.88 · patch allowed`, exit 0. A fresh clone on `feat/any-repo` repeated `setup.sh --no-start` clean, then `scripts/score.sh TR-01`: **`# RESULT TR-01 PASS (34 passed, 0 failed, 0 skipped)`**, exit 0 (H4 clean this run too). Not yet run against a second repo |
| Demo target | `vishnuverse/humanize`; a switch to `drax0945/humanize` was reverted on 26 Sep because the demo token cannot write there (`shipgate.yaml` only, no code change) |
| Next | Prove the any-repo flow against a second, real repo when one is offered; Runbook Executor on a local kind cluster |

## Repository

| Path | What |
| --- | --- |
| `skills/ticket-resolver/SKILL.md` | The agent's procedure |
| `agents/ticket-resolver.json` | Agent spec: model, tools, gates, sandbox, limits |
| `orchestrator/` | `shipgate run`: sessions, approvals, run records, labels |
| `scripts/` | `setup.sh` / `stop.sh` (one-command setup, doctor, teardown), `setup_trueforge.ts` (provider + connectors), `setup_agents.ts`, `shipgate_config.py` (config loader), `check.py` (oracle + scorecard), `reset.sh`, `score.sh`, `bakeoff.py` |
| `tests/` | Scenarios, scorer tests, fixtures |
| `docs/` | Design, contracts, work log, decisions, research ([index](docs/README.md)) |

## AI assistance
Built with **Claude Code** (Anthropic; models Claude Opus 5.5, Claude Sonnet 5, Claude Haiku 4.5 and Claude Fable 5.1:
Opus for planning, design and the main session; Sonnet, Haiku and Fable as implementer and reviewer subagents; one
teammate also used Claude Code with Claude Sonnet 5). It helped plan and research (TrueForge source, SWE-agent,
model prompting guides), wrote the spec, and wrote the code: the skill, the orchestrator and the scorer were built by
parallel Claude Code subagents against a shared contract, then reviewed and merged. It also planted the disclosed
fixture bugs. The agent itself runs on `deepseek/deepseek-v4-flash` through OpenRouter. The humans chose the scope,
approved each design section, and own every decision recorded in `docs/MEMORY.md`.

The bugs the agent fixes were **planted on purpose** in the demo fork `vishnuverse/humanize` (commits titled
`chore(fixture #N)`, first made on `vishnuverse/humanize`). They are not upstream bugs, and nothing is sent to
`python-humanize/humanize`.

## License
GPL-3.0, see [LICENSE](LICENSE).
