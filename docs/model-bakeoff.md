# Model bake-off (2026-09-26)

**Pick: `deepseek/deepseek-v4-flash` via OpenRouter** (TrueForge model `openrouter/deepseek-v4-flash`).
Fallback: `z-ai/glm-5.3-flash`. Reason: both finished the real task; DeepSeek was ~1.5× faster, which matters on stage.

## Why a bake-off
The Gemini key was free tier (20 requests/day) and one ticket run needs 30–50 model calls. With a $5 OpenRouter
budget, we wanted the smallest model that still does the job, measured rather than guessed.

## Method
`scripts/bakeoff.py` runs every candidate in parallel on the same task through TrueForge 0.2.1:
- the real agent instructions + `skills/ticket-resolver/SKILL.md`, on issue #1 (`ordinal(12)` → `12nd`);
- built-in local sandbox; GitHub MCP with **read-only** tools, so nothing on GitHub changes;
- stop after the evidence card and write the handoff JSON; iteration limit 60.

Scored from the session events: reproduced before the patch, issue test passing after, full suite green, evidence
card shown, handoff block present, steps, wall time, and cost from OpenRouter's prices.

## Results (one run each)

| Model | $/M tokens in / out / cached | Result | Wall time | Sandbox commands | Cost |
| --- | --- | --- | --- | --- | --- |
| **deepseek/deepseek-v4-flash** | 0.047 / 0.094 / 0.009 | **Pass**: 4 new test cases fail 3/3 → fix → 5 pass 3/3, suite green, evidence card, handoff | 168 s | 22 | $0.0058 |
| z-ai/glm-5.3-flash | 0.045 / 0.14 / 0.010 | **Pass** (recovered from a pip SSL error on the way; 748 passed) | 253 s | 14 | $0.0046 |
| openai/gpt-5-nano | 0.05 / 0.40 / 0.005 | Fail: gave up after 2 commands; handoff with a placeholder SHA | 52 s | 2 | $0.0027 |
| openai/gpt-oss-20b | 0.018 / 0.09 / – | Fail: never set up the repo properly; no handoff | 262 s | 20 | $0.0015 |

Total spend for the bake-off: **$0.026** (OpenRouter key usage). Prompt caching did most of the work: DeepSeek read
437k input tokens, 412k of them from cache. A full ticket run therefore costs well under one cent.

## Caveats
- One run per model: a small sample. Re-run `python3 scripts/bakeoff.py` after changing the skill.
- The script's "reproduced" column first used exit codes; models pipe pytest through `tail`, so it now reads pytest's
  summary lines (as `check.py` does).
- Gemini-specific advice in `reference/gemini-3-prompting.md` (temperature, thinking level) doesn't apply to DeepSeek;
  the agent spec sets no temperature and no reasoning effort.
