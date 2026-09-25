# shipgate

**A bug-ticket agent that does the tedious part and stops before anything other people can see.**
Built for TrueFoundry's *Agents That Act* hackathon (26 Sep 2026) on [TrueForge](https://trueforge.dev), the
open-source agent harness.

Give it a GitHub issue. **Ticket Resolver** reads the ticket, reproduces the bug as a failing test in a sandbox,
makes the smallest fix, proves it (test 3/3 green, full suite green), pushes a `fix/issue-<n>` branch, and then
**stops**: it shows an evidence card and waits for a human before it opens the pull request, and again before it
replies to the reporter. If it can't reproduce the bug, it says so with evidence instead of guessing.

> **Status (26 Sep, 02:40 IST):** agent, orchestrator and scorer are built and unit-tested, the fixtures are live, and
> the chosen model completed issue #1 end to end up to the evidence card. Full scored runs of the scenarios are
> in progress. See [Status](#status).

## Organisers' checklist

| # | Requirement | How shipgate meets it |
| --- | --- | --- |
| 1 | Harness visibly doing the work: real tool, code run in the sandbox, pause before anything irreversible | TrueForge runs the agent loop. The agent reads the issue and pushes through the **GitHub MCP**, runs the failing test, fix and full suite with the sandbox `exec` tool, and TrueForge **holds** `create_pull_request` and `add_issue_comment` for a human |
| 2 | One job, finished | One job: resolving a bug ticket, end to end. Nothing else is built yet |
| 3 | Film the approval moment | The TrueForge session page shows the sandbox runs, then the "Tool Approval Required" card (`--approve ui`) |
| 4 | Public repo, README works on another laptop, AI named | Quick start below; AI use disclosed at the end. *The repo is private while we build; it is made public for submission* |
| 5 | Only our own accounts and keys; none in the repo or video | Our own GitHub, OpenRouter and TrueForge. Keys live in `.env` (gitignored) and TrueForge Settings; `.env.example` has names only |

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
2. **Reproduce.** In the sandbox: full clone at that SHA, a new `tests/test_issue_<n>.py` covering the report plus edge
   cases, run 3×. 3/3 fail = reproduced; 3/3 pass = can't reproduce; mixed = intermittent (10 runs, hit rate).
3. **Fix.** Smallest change in `src/`, never touching existing tests. At most 2 attempts.
4. **Prove.** Five checks must all hold: failed before, passes 3/3 after, full suite green, only intended files changed,
   `main` hasn't moved. Otherwise no PR.
5. **Push** `fix/issue-<n>` (the ruleset on `main` means this can't reach `main`).
6. **Gate 1:** evidence card → `create_pull_request` waits for you. **Gate 2:** reply draft → `add_issue_comment` waits.
7. **Hand off** a JSON block; the orchestrator sets the issue label from it.

Design: [`docs/SPEC.md`](docs/SPEC.md) §4. Interfaces: [`docs/contracts.md`](docs/contracts.md).

## Where it stops

| Line | How it's enforced |
| --- | --- |
| Opening a PR, replying on a ticket | Gated **by name** (`require_approval_for_tools`); the GitHub MCP marks neither as destructive, so `@destructive` alone would miss them |
| Merging, closing or editing issues, deleting files | Tools not enabled at all (`merge_pull_request`, `issue_write`, `delete_file`, …) |
| Pushing to `main` | Repo ruleset with an **empty bypass list**; verified: even the owner's direct push is rejected |
| Secrets in the sandbox | None. It only clones public code; every GitHub write goes through the MCP, whose token stays in TrueForge |
| Blast radius | Fine-grained token scoped to the fork `vishnuverse/humanize`; other repos return 404 |
| Bad or hostile tickets | Push-back: out of scope, can't reproduce, duplicate PR, too vague, security report, injected instructions (fixture #5) |
| An approver asking for something unsafe | The agent refuses (e.g. "delete the failing test and push to main"), names the rule and asks again unchanged |
| Its own weak evidence | Two failed attempts → no PR; a comment asking a maintainer instead (fixture #6: an old test expects the bug) |

At each gate you answer **Approve**, `REVISE: <note>`, `EDIT: <exact text>` or `STOP` (max 3 revisions per gate).
Every answer is logged to `approvals.log` with a hash of the exact call it approved.

## Quick start (fresh laptop)

**You need:** Node ≥ 22.14, [uv](https://docs.astral.sh/uv/) (Python 3.12), git, an [OpenRouter](https://openrouter.ai)
key, and a GitHub **fine-grained** token for your fork of `humanize` (Contents, Issues, Pull requests: read/write).

```bash
git clone https://github.com/vishnuverse/trueforge-shipgate && cd trueforge-shipgate
cp .env.example .env                              # fill TRUEFORGE_URL, GITHUB_PAT (never commit .env)
uv sync && npm --prefix orchestrator ci
npx --yes @truefoundry/trueforge@0.2.1            # TrueForge UI + API on http://localhost:8790; leave it running
```

In the TrueForge UI, **Settings**:
1. **Models → Add Custom Provider**: name `openrouter`, base URL `https://openrouter.ai/api/v1`, your OpenRouter key,
   model name `deepseek-v4-flash` with model id `deepseek/deepseek-v4-flash`.
2. **Connectors → github**: header `Authorization: Bearer <your GitHub token>`.
3. **Sandbox**: nothing to do; TrueForge's built-in local sandbox is used (add Daytona under Sandbox providers to use it).

Then, in a second terminal:
```bash
npx --yes tsx scripts/setup_agents.ts --inline-skill                         # registers the ticket-resolver agent
npm --prefix orchestrator run shipgate -- run --issue 1 --approve terminal   # or --approve ui
```
You'll see the session link, then the agent's sandbox work, then the evidence card and a menu:
`[a]pprove [r]evise [e]dit [s]top [v]iew`. With `--approve ui`, answer on the session page in TrueForge instead.

### Using your own fork
The target repo is fixed to `vishnuverse/humanize` on purpose (the orchestrator and `reset.sh` refuse any other).
To run it on yours:
1. Fork `python-humanize/humanize`, clone it, then apply the five planted bugs:
   `git fetch https://github.com/vishnuverse/humanize main && git cherry-pick 3190a3c 4bc9bc6 fec6bc1 3593e50 3145c20`.
2. Push the upstream tags, enable Issues, and open issues #1–#7 from `tests/fixtures/humanize/` (titles in
   `fixtures.json`, bodies in `issues/`). Add a ruleset on `main`: PR required, no bypass.
3. Replace `vishnuverse/humanize` (and the owner `vishnuverse`) in `agents/`, `skills/`, `orchestrator/src/`, `scripts/`.
   A single `TARGET_REPO` setting is on the to-do list.

## Tests and scoring

```bash
uv run pytest tests/check -q                 # scorer unit tests (33)
npm --prefix orchestrator test               # orchestrator unit tests (66)
scripts/score.sh TR-01                       # reset the fork → run with scripted approvals → grade
uv run python scripts/check.py --all         # all scenarios with a run + a self-assessed scorecard
```
13 scenarios (`tests/scenarios/TR-*.yaml`) cover the happy path, can't-reproduce, STOP / REVISE / EDIT at the gates,
an unsafe revision request, prompt injection, the evidence that won't go green, scope and duplicates. `check.py`
grades each run from TrueForge's session events **and** the real GitHub state, and prints the judging criteria it
can check automatically (harness doing the work, where it stops, how many must-pass scenarios pass).

## Model and cost
`deepseek/deepseek-v4-flash` via OpenRouter, chosen by a bake-off of four cheap models on the real task:
two failed, DeepSeek and GLM-5.3-Flash passed, DeepSeek was faster. The whole bake-off cost $0.026; a ticket run costs
under one cent thanks to prompt caching. Details: [`docs/model-bakeoff.md`](docs/model-bakeoff.md).

## Status

| | |
| --- | --- |
| Done | Skill, agent spec, orchestrator (3 approval modes), scorer + 13 scenarios; fixtures #1–#7 on the fork; ruleset; model chosen |
| Verified live | Sandbox runs code; GitHub MCP reads; a gated tool pauses and a deny resumes; the chosen model reproduced, fixed and proved issue #1 (read-only run) |
| In progress | Scored runs of the must-pass scenarios (TR-01, 03, 05, 06, 10, 11, 12, 13); a filmed `--approve ui` run; Daytona for the demo |
| Next | Triage agent (TypeSafe Jev for calibrated category / priority / duplicate decisions); Runbook Executor on a local kind cluster |

## Repository

| Path | What |
| --- | --- |
| `skills/ticket-resolver/SKILL.md` | The agent's procedure |
| `agents/ticket-resolver.json` | Agent spec: model, tools, gates, sandbox, limits |
| `orchestrator/` | `shipgate run`: sessions, approvals, run records, labels |
| `scripts/` | `setup_agents.ts`, `check.py` (oracle + scorecard), `reset.sh`, `score.sh`, `bakeoff.py` |
| `tests/` | Scenarios, scorer tests, fixtures |
| `docs/` | Design, contracts, work log, decisions, research ([index](docs/README.md)) |

## AI assistance
Built with **Claude Code** (Anthropic; model Claude Opus 5.5). It helped plan and research (TrueForge source, SWE-agent,
model prompting guides), wrote the spec, and wrote the code: the skill, the orchestrator and the scorer were built by
parallel Claude Code subagents against a shared contract, then reviewed and merged. It also planted the disclosed
fixture bugs. The agent itself runs on `deepseek/deepseek-v4-flash` through OpenRouter. The humans chose the scope,
approved each design section, and own every decision recorded in `docs/MEMORY.md`.

The bugs the agent fixes were **planted on purpose** in the fork `vishnuverse/humanize` (commits titled
`chore(fixture #N)`). They are not upstream bugs, and nothing is sent to `python-humanize/humanize`.

## License
GPL-3.0, see [LICENSE](LICENSE).
