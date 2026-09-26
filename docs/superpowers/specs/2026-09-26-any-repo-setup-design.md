# Any-repo configuration and one-command setup: design

Date: 2026-09-26 · Status: draft for review · Path: architectural (new config surface, new setup tooling, changes to
safety guards). It builds on `feat/jev-triage` (spec `2026-09-26-jev-triage-design.md`) and ships on a new branch
`feat/any-repo`, cut from `main` once the triage branch has landed.

## 1. Goal

Anyone can point Ticket Resolver at **their own GitHub repo that is a Python package tested with pytest**, by
editing configuration rather than code. They can then bring the whole system up with **one command** after filling
two files.

Success means:
1. **No code edits to change the target.** The target repo and its commands live in `shipgate.yaml`. No file under
   `scripts/`, `orchestrator/src/`, `mcp/`, `agents/` or `skills/` names `vishnuverse/humanize`, except `reset.sh` and
   the `Example (demo repo …)` lines in the skill. The scenario files in `tests/scenarios/` are demo-only by design.
2. **One command.** On a machine with Node ≥ 22.14, uv, git and curl: fill `.env`, edit `shipgate.yaml`, run
   `scripts/setup.sh`, then run the printed `shipgate run` command. There are no clicks in the TrueForge UI.
3. **The same safety as today.**
   - One target per install, and every component refuses any other repo.
   - The sandbox holds no credentials.
   - PRs and comments stay gated.
   - The default branch must be protected.
4. **The demo keeps working unchanged.** With the committed `shipgate.yaml` (humanize values), every existing test
   passes and the TR scenarios behave as today.

Decided with the user in brainstorming:
- scope: any Python + pytest repo, not any language
- setup: fill two files and run one command, no wizard and no Docker
- the Jev triage stays an MCP server, not a skill, because the key must stay on the host and the verdict must come
  from code the agent can't edit

## 2. Configuration: `shipgate.yaml`

Committed at the repo root with the demo values. A user edits it for their repo. It holds no secrets.

```yaml
target:
  repo: vishnuverse/humanize          # owner/name; the only repo any component may touch
  default_branch: main
  description: >-                     # context for Jev triage (≤ 500 chars): what the package is and is not
    humanize is a Python library (vishnuverse/humanize) with functions such as ordinal, intcomma, intword,
    naturalsize, naturaltime, naturalday and naturaldate. It is not Django's django.contrib.humanize.
python:
  install: '.venv/bin/pip install -q --disable-pip-version-check -e ".[tests]"'   # run after `python3 -m venv .venv`
  test: ".venv/bin/python -m pytest -q -p no:cacheprovider --benchmark-disable --color=no"
  source_dir: src/humanize            # fixes may change only files under this directory
  tests_dir: tests                    # the regression test is <tests_dir>/test_issue_<n>.py
trueforge:
  url: http://localhost:8790
  model: openrouter/deepseek-v4-flash
```

**Validation rules**, the same in both loaders:
- unknown keys are an error
- `repo` matches `^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`
- `source_dir` and `tests_dir` are relative, have no `..` and no leading `/`
- `install` and `test` are non-empty and contain no backtick, because they are inserted in backticks
- `description` is 1–500 characters
- `default_branch` is non-empty
- `trueforge.url` is http(s)

Each error names the file and the key.

**Loaders:**
- Python: `scripts/shipgate_config.py`, exposing `load_config(path=ROOT/"shipgate.yaml") -> Config`, a frozen dataclass
  with derived `owner`, `name` and `full_repo`
- TypeScript: `orchestrator/src/config.ts`, exposing `loadConfig(path?) -> Config`
- Both use the YAML parsers the repo already has (`pyyaml`, `yaml`), so nothing new is added.

**Readers of the config:**

| Component | Today | After |
| --- | --- | --- |
| Scorer (`shipgate_check/constants.py`, `clients.py`, `checks.py`) | `OWNER`, `REPO`, `FULL_REPO` constants | read from the config; the read-only GitHub client still refuses any other repo |
| Orchestrator (`labels.ts` `TARGET_REPO`, `runner.ts` `REPO`, `cli.ts` prompt) | constants | from `loadConfig()`; labels and the kickoff prompt use the configured repo |
| Triage server (`github.py` `OWNER, REPO`, `policy.CONTEXT`) | constants | from the config at startup; `CONTEXT` = `target.description` |
| Agent spec + skill | literal `vishnuverse/humanize`, paths and commands | placeholders rendered by `setup_agents.ts` at registration (§3) |
| `reset.sh` | hard-coded demo repo | unchanged demo repo, and it **refuses to run unless the config target equals it** (§5) |
| Scenarios `tests/scenarios/TR-*.yaml` | implicit humanize | new required key `repo: vishnuverse/humanize`; `check.py` and `score.sh` refuse a scenario whose `repo` differs from the config |

**Triage context and policy version.**
- The Jev questions and thresholds stay `triage-v1`.
- Because `description` becomes part of the Jev state, the verdict and the audit line gain
  `context_sha: <first 12 hex chars of sha256(description)>`. A verdict can then always be traced to the exact
  context it was asked with.
- The thresholds were tuned on humanize. The docs say that other repos should expect more `uncertain` (held)
  tickets, which is the safe direction.

## 3. Skill and agent rendering

- **Placeholders.** `skills/ticket-resolver/SKILL.md` and `agents/ticket-resolver.json` use:
  - `{{repo}}`, `{{owner}}`, `{{name}}`, `{{default_branch}}`
  - `{{install}}`, `{{test}}`, `{{source_dir}}`, `{{tests_dir}}`
- **Rendering.** `setup_agents.ts --inline-skill` renders them from the config before inlining. The model name in
  the agent spec comes from `trueforge.model`.
- **Rendering fails** if a placeholder has no value, or if any `{{…}}` is left after rendering. The agent never
  sees a half-filled skill.
- **Humanize-specific teaching text** stays as clearly marked examples: `Example (demo repo vishnuverse/humanize):
  …`. This covers:
  - the `ordinal` card and PR body examples
  - the naive-datetime `naturaltime` note in hard rule 11 and `<definitions>`
  - the `number.py` "⁰¹²³" push note

  Rules never depend on these examples.
- **The skill stays Python-shaped:** a venv, then `{{install}}`, then `{{test}}`. Pytest summary lines drive the
  evidence check. The diff check becomes "only ` M {{source_dir}}/…` and `?? {{tests_dir}}/test_issue_<n>.py`".

## 4. `scripts/setup.sh`

Written for bash 3.2 (it has to run on macOS). Every step can be re-run safely and prints one `✓` or `✗` line.
**Secret values are never printed.**

1. **Preflight:**
   - `node ≥ 22.14`, `uv`, `git`, `curl` are present
   - `.env` exists with non-empty `GITHUB_PAT`, `OPENROUTER_API_KEY` and `TYPESAFE_API_KEY`, checked for presence only
   - `shipgate.yaml` loads
   - the token can read the target repo (`GET /repos/{repo}` returns 200)
2. **Install:** `uv sync` and `npm --prefix orchestrator ci`.
3. **Start services**, skipped when they already answer or with `--no-start`:
   - TrueForge `npx --yes @truefoundry/trueforge@0.2.1`, with `SERVER_EXECUTION_TIMEOUT_SECONDS=1200` and
     `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`
   - `uv run mcp/triage/server.py`, with its access log set to warning level
   - output goes to `runs/logs/{trueforge,triage}.log` and pid files to `runs/pids/`
   - it waits up to 90 s for both to answer
   - `scripts/stop.sh` stops what `setup.sh` started, using the pid files, and nothing else
4. **Register in TrueForge through its API.** A new `scripts/setup_trueforge.ts` uses the pinned SDK 0.2.0.
   - It adds, only where missing:
     - model provider `openrouter`: type `custom`, base URL `https://openrouter.ai/api/v1`, models
       `deepseek-v4-flash` → `deepseek/deepseek-v4-flash` and `glm-5-3-flash` → `z-ai/glm-5.3-flash`, with model
       properties copied from the working provider; the key comes from `.env`
     - connector `github`: `https://api.githubcopilot.com/mcp/`, with header auth
       `Authorization: Bearer <GITHUB_PAT>`
     - connector `triage`: `http://127.0.0.1:8803/mcp`
   - Then it runs the agent registration: `setup_agents.ts --inline-skill` with rendering.
   - **Keys go only to a local TrueForge.** Setup refuses to send keys to a non-loopback `trueforge.url` unless
     `--allow-remote` is given.
   - **Existing entries are left untouched** unless `--rotate-keys` is given. The API keeps a stored secret when it
     is sent a redacted value, so re-runs send nothing secret.
5. **Target repo:**
   - **Setup refuses to continue unless the default branch is protected.** It passes when
     `GET /repos/{repo}/rules/branches/{branch}` lists a `pull_request` rule, or `GET /repos/{repo}/branches/{branch}`
     reports `protected: true`. `create_branch` and `push_files` are ungated, so this protection is what keeps an
     agent mistake off the default branch. `--allow-unprotected` overrides it, with a warning that says why.
   - It creates any missing labels among the five managed ones (`bug`, `triaged`, `fix-proposed`,
     `cannot-reproduce`, `needs-human`). This is setup's only write to GitHub, and it is listed before it happens.
6. **Doctor.** This is the last step, and it also runs alone as `setup.sh --check`. It checks:
   - TrueForge and the triage server answer
   - provider `openrouter` exists
   - connectors `github` and `triage` exist with an auth status that isn't failing
   - the saved agent gates exactly `create_pull_request` and `add_issue_comment` by name, and has
     `web_search.enabled: false`
   - with `--smoke <issue>`, one real `triage_ticket` call returns a verdict that isn't an error

   Then it prints the next command: `npm --prefix orchestrator run shipgate -- run --issue <n> --approve terminal`.

**Flags:**
- `--dry-run`: fully offline; prints the plan; no network, no writes, no keys sent, nothing started
- `--no-start`, `--rotate-keys`, `--allow-remote`, `--allow-unprotected`, `--check`, `--smoke <issue>`

**Exit codes:** 0 = ok, 1 = a step failed (the message names the step and the fix), 2 = usage or config error.

**Who runs what.** The executor (Claude) builds and verifies with `--dry-run` and `--check`. **The user runs the
first real `setup.sh`**, because that is the step that sends their keys into TrueForge. Their current install already
holds the keys, so a re-run sends nothing.

## 5. Safety changes

- **The single-target guard stays; only its value moves into config.** The scorer client, orchestrator labels and
  triage server each refuse any repo other than `target.repo`.
- **`reset.sh` is demo-only.** It closes PRs, deletes `fix/issue-*` branches and rewrites labels and comments. It
  keeps its hard-coded demo repo and exits 2 unless the config target equals it, so it can never run against a
  user's repo.
- **`CLAUDE.md` boundary 7 becomes:** "Target repo = `shipgate.yaml` `target.repo` (demo: fork `vishnuverse/humanize`).
  Its default branch must be protected with no bypass; setup refuses otherwise." The rules on never merging, never
  `issue_write`, and always passing owner/repo stay as they are, now with the configured values.

## 6. Error handling

- **Config errors** (§2): `setup.sh` exits 2, and the orchestrator and scorer exit 2, each with the file and key.
- **Rendering errors** (§3): registration fails, and the agent is not updated.
- **`setup.sh` failures:**
  - port busy with another program: it names the port and the process
  - TrueForge didn't start within 90 s: it shows the last 20 log lines
  - triage server not answering
  - a connector's auth status failing
  - branch not protected
  - a label create failing

  Each is exit 1 with the fix.
- **A failing `--smoke` triage call** reports the verdict's `error` field. It never contains a key.

## 7. Tests

- **Loader parity:**
  - One set of fixtures in `tests/fixtures/config/` holds a valid file plus one invalid file per rule.
  - `tests/check/test_config.py` and `orchestrator/test/config.test.ts` both run the whole set, and must agree on
    which files load and on the key named in each error.
- **Rendering:**
  - The committed config renders a skill with no `{{`.
  - A second config (`acme/widgets`, `src/widgets`, `tests`) renders a skill and agent spec that don't contain
    `vishnuverse` outside lines starting `Example (demo repo`.
  - A missing value fails.
- **Scorer:**
  - All current tests pass with the committed config.
  - A scenario whose `repo` doesn't match the config is refused (exit 2).
  - The GitHub client refuses a repo other than the configured one.
- **Orchestrator:** labels and the kickoff prompt use the configured repo (a test with a temporary config).
- **`setup_trueforge.ts`**, using a fake fetch as the label tests already do:
  - It creates the provider and connectors when they are missing, and sends nothing when they are present.
  - `--rotate-keys` sends the keys.
  - A non-loopback URL without `--allow-remote` is refused.
  - The captured stdout and stderr never contain a key value.
- **`setup.sh --dry-run`:** a pytest runs it as a subprocess with a temporary `.env` of fake values and no services.
  It expects exit 0, the plan printed, no fake key value in the output, and no pid files created.
- **`reset.sh`:** with a config pointing elsewhere it exits 2 and touches nothing (a subprocess test with a temporary
  config).
- **Live acceptance:**
  1. **Fresh clone:** clone into a temp directory, copy `.env`, run `scripts/setup.sh --no-start --check` against the
     running services, then `scripts/score.sh TR-01` from that clone. This is the closest proxy for "README works on
     another laptop".
  2. **A second repo, only if the user names one of theirs:** a Python + pytest repo with a protected default branch
     and one open bug issue. Point `shipgate.yaml` at it, run `setup.sh --check --smoke <issue>`, then run one ticket
     in `--approve terminal`. If the user names none, the README states that the flow is proven on humanize only.

## 8. Docs

- **README:**
  - "Quick start" becomes three steps: fill `.env`, edit `shipgate.yaml`, run `scripts/setup.sh`.
  - "Using your own fork" becomes **"Using your own repo"**. It lists the config keys, the branch-protection
    requirement, the token scope (fine-grained, that repo only: Contents, Issues, Pull requests read/write), and the
    limits: Python + pytest only, Jev thresholds tuned on humanize, and the scorecard scores only the demo fork.
  - The demo-fork steps stay under "Scored demo".
- **CLAUDE.md:**
  - Setup and Run become `scripts/setup.sh` / `scripts/stop.sh`.
  - Boundary 7 changes (§5).
  - Layout gains `shipgate.yaml`.
- **SPEC:** §4.1 notes that the target is configured. **contracts.md:** the config schema (§2) and the env names.
  **AGENTS.md:** the directory map. **`.env.example`:** the comments name `OPENROUTER_API_KEY` and
  `TYPESAFE_API_KEY` as used by `setup.sh`. **MEMORY:** the decisions.

## 9. Risks and limits

1. **Repo shapes the procedure doesn't fit:**
   - no `[tests]` extra
   - tests needing services or compilers
   - a flat layout without `src/`

   All of these depend on the configured `install`, `test` and `source_dir`. The doctor can't prove the commands
   work until a ticket runs; `--smoke` only checks triage.
2. **Checking protection isn't enforcing it.** Setup refuses unprotected branches but never creates the protection.
3. **Jev on other repos** is uncalibrated (§2). Held tickets fail safe but may frustrate. Retuning is a new policy
   version.
4. **Keys pass from `.env` to the local TrueForge** through setup, only over loopback, and never logged.
5. **The local sandbox runs on the host** (macOS seatbelt). A user repo's install and test commands run with the
   same isolation as today's humanize runs. Daytona remains the stronger option for untrusted repos.

## 10. Out of scope

- Non-Python repos and other test runners.
- A wizard or Docker.
- Daytona registration in setup (a `DAYTONA_API_KEY` slot can come later).
- Creating branch protection.
- More than one target per install.
- Jira.
- Scoring a user's repo: the TR scenarios stay demo-only.
- `scripts/bakeoff.py`, a historical tool.
