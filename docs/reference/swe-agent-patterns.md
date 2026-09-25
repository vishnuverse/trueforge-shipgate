# Reference: SWE-agent patterns for a shell-only issue fixer

Our notes on [SWE-agent](https://github.com/SWE-agent/SWE-agent) and
[mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) (both MIT), paraphrased and applied to Ticket Resolver.
Ticket Resolver has one sandbox tool (`exec`) and GitHub MCP, so we copy SWE-agent's *guardrails* into the skill text
instead of building its custom editor. Checked 2026-09-26.

Sources: `config/default.yaml`, `config/bash_only.yaml`, `config/sweagent_0_7/07.yaml`,
`tools/review_on_submit_m/bin/submit`, `tools/windowed_edit_linting/bin/edit`, `tools/edit_anthropic/bin/str_replace_editor`,
`sweagent/tools/tools.py`, `sweagent/agent/reviewer.py`, docs `background/aci.md`, paper [arXiv 2405.15793](https://arxiv.org/abs/2405.15793).

## 1. The workflow their prompts teach

1. Find and read the relevant code.
2. Write a repro and run it: see the bug.
3. Edit the source (minimal, non-test changes only).
4. Rerun the repro: see the fix.
5. Think about edge cases.
6. Submit, but the first `submit` returns a review checklist with the full diff (rerun repro, delete scratch files,
   revert any test edits); only the second submit ends the run.

`bash_only.yaml`: exactly one command per reply (`&&`/`||` allowed), a short THOUGHT first, never modify tests or config
(`pyproject.toml`, `setup.cfg`). mini-swe-agent: each command runs in a fresh subshell, so `cd` doesn't persist.

## 2. Agent-computer interface findings (paper ablations, SWE-bench Lite, full setup 18.0%)

| Removed or changed | Resolve rate | Lesson for us |
| --- | --- | --- |
| No edit tool | 10.3% | Editing is the weak spot; give a safe edit recipe |
| Edit without lint check | 15.0% | Syntax-check every edit, revert on failure |
| Viewer shows whole file | 12.7% | View line ranges, never `cat` big files |
| Iterative instead of summarized search | 12.0% | `grep -l` / `grep -n` before reading |
| Full history instead of last 5 observations | 15.0% | Keep command output short |

Failure data: 51.7% of runs had a failed edit and only 57.2% recovered from one; cascading bad edits caused 23.4% of
failures; overly specific or wrong fixes caused 52%. Successful runs took a median of 12 steps, failed runs ~21.

## 3. Guardrails they enforce in code (we enforce them in the skill)

- Blocked: interactive editors and pagers (`vim`, `nano`, `less`, `tail -f`), bare `python`/`bash`, `nohup`.
- Bad format / blocked command / shell syntax error → re-ask (max 3), nothing executed.
- Per-command timeouts; 3 timeouts in a row ends the run. Step and cost caps per instance.
- On a crash or limit: keep partial work by recording `git diff`.
- Retry agent: N attempts with a hard reset between them, then a chooser or reviewer picks; capped attempts and budget.

## 4. Rules adopted for Ticket Resolver (→ SKILL.md)

| # | Rule | From |
| --- | --- | --- |
| 1 | One command per `exec`; start every command with `cd <repo> &&` (no shell state carries over) | mini-swe-agent |
| 2 | Fixed order: read issue → locate code → write `tests/test_issue_<n>.py` → see it fail → patch `src/` → rerun issue test → full suite | default.yaml, 07.yaml |
| 3 | Search before reading: `grep -rln` then `grep -n`, then view 40–100 lines with `nl -ba f \| sed -n 'A,Bp'` | ACI ablations |
| 4 | Edit with a `python3 - <<'EOF'` script that asserts the old text occurs exactly once, then replaces it; new files via quoted heredoc | str_replace_editor |
| 5 | After each edit: `python3 -m py_compile <file>`, re-view the edited lines ±4, and on error `git checkout -- <file>` and change approach | windowed_edit_linting |
| 6 | Two failed edits in a row to the same spot end the attempt | paper failure data |
| 7 | Change only `src/humanize/**`; create only `tests/test_issue_<n>.py`; never touch existing tests or config | bash_only.yaml, review_on_submit |
| 8 | Fix the root cause in the code's own style; never special-case the ticket's example input | default.yaml, paper (52%) |
| 9 | Non-interactive only: `PAGER=cat GIT_PAGER=cat`, pytest `-q -p no:cacheprovider`; no editors, no bare `python` | tools.py blocklist |
| 10 | Keep output short: `\| tail -40`, or redirect to a file and grep it | truncation templates |
| 11 | Self-review before any GitHub write: `git status --porcelain && git diff`, only intended files, no scratch files, rerun issue test + full suite | review_on_submit |
| 12 | Max 2 patch attempts; before attempt 2 `git checkout -- src/`, keep the new test, write down why attempt 1 failed; after 2 red → no PR, evidence in handoff | reviewer.py retry agent |

Local-sandbox caveat: macOS has no `timeout` command (Daytona's Linux image does). Rely on TrueForge's exec timeout and
non-interactive flags instead of `timeout N`.

## 5. Adapting `skills/github-fix-issue.md` (our local draft)

Its method carries over (understand → prior art → plan → small steps → tests → full suite → PR with `Fixes #n`), but every
`gh` command maps to a GitHub MCP tool, because the sandbox holds no token and `gh pr create` would skip the approval gate:

| Draft uses | Ticket Resolver uses |
| --- | --- |
| `gh issue view` | `issue_read` (MCP) |
| `gh pr list --search` | `list_pull_requests` / `search_pull_requests` (MCP) |
| `git checkout -b` + commits | local branch in the sandbox only; GitHub branch via `create_branch` + `push_files` (MCP) |
| `gh pr create` | `create_pull_request` (MCP, **gated**) |
| request a reviewer | dropped: the human approver is the reviewer |
