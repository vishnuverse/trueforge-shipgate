# Prompting reference: OpenAI gpt-6-luna (Responses API)

The current model reference: Ticket Resolver runs on OpenAI `gpt-6-luna` (`shipgate.yaml`
`trueforge.model: openai/gpt-6-luna`). Replaces `deepseek-v4-and-glm-5.3-prompting.md`, which stays valid for an
`openrouter/...` model. Researched 2026-09-26. **[unverified]** = inference or not confirmable
from the fetched pages. TrueForge behaviour was read from the installed 0.2.1 source, not tested on the wire.

Sources (fetched 2026-09-26):
1. `openai.com/index/better-prompt-caching-for-gpt-6/` — **failed to load (HTTP 403 Forbidden), twice.** None of its
   claims are reflected below (retry it before relying on §2); where the GPT-6 caching behaviour matters, this doc falls back to the general
   `prompt-caching` guide (source 2) and flags the gap.
2. `developers.openai.com/api/docs/guides/prompt-caching.md` — loaded.
3. `developers.openai.com/api/docs/models/gpt-6-luna.md` — loaded (model card).
4. `developers.openai.com/api/docs/guides/latest-model.md` — loaded, but as fetched it documents a model called
   **"GPT-6 Astra"**, not `gpt-6-luna`. Treated as generic latest-model agentic guidance only; anything
   Astra-specific (e.g. its `reasoning_effort` floor) is called out and NOT assumed to apply to Luna.
5. `developers.openai.com/api/docs/guides/reasoning-best-practices.md` — loaded, but it is generic reasoning-model
   guidance written around `o1`/`o3`/`o4-mini`; no `gpt-6-luna`-specific content and no caching content.

Also folded in: the user-supplied "Prompt engineering" guide (developer/`instructions` priority; Identity →
Instructions → Examples → Context; Markdown + XML structuring; version prompts in code; static content first and
early in the request for caching; pin snapshots; reasoning models want high-level goals, GPT models want explicit
steps; agentic prompts: persist, brief preambles, TODO/rubric tracking).

## 1. `gpt-6-luna` model facts

| Fact | Value | Source |
| --- | --- | --- |
| Model ID | `gpt-6-luna` | model card |
| Snapshot to pin | Only one snapshot is listed: `gpt-6-luna` itself — no dated snapshot (e.g. no `gpt-6-luna-2026-xx-xx`) exists to pin against | model card |
| Context window | 1,050,000 tokens total (922,000 max input + 128,000 max output) | model card |
| Max output tokens | 128,000 | model card |
| Reasoning efforts | `none, low, medium (default), high, xhigh, max` | model card |
| Temperature / top_p accepted | **Not stated on the model card either way.** Not confirmed either as accepted or rejected. See §5 for the working assumption | model card |
| Input price | $0.10 / M tokens | model card |
| Cached input price | $0.01 / M tokens (10% of input — a 90% discount) | model card |
| Output price | $0.50 / M tokens | model card |
| Knowledge cutoff | 2026-05-18 | model card |
| Large-prompt surcharge | Prompts over 272K input tokens: 2× input/cached-input rate, 1.5× output rate. Our skill (~26K chars, well under 272K tokens) never crosses this | model card |
| Function calling | Available via Responses API at any `reasoning_effort`; via Chat Completions only when `reasoning_effort: "none"`. Doesn't affect us — TrueForge always uses the Responses API | model card |

## 2. Prompt caching (general OpenAI guide — GPT-6 blog post unreachable)

Because source 1 (the GPT-6-specific caching blog) 403'd twice, everything here is from the general
`prompt-caching` guide, which explicitly splits behaviour into "GPT-5.6 and later" vs "earlier models". `gpt-6-luna`
postdates GPT-5.6 in OpenAI's naming, so this doc assumes it falls in the **GPT-5.6+ bucket** throughout —
**[inference]**, not confirmed against a GPT-6-specific page.

- **Mechanism**: caching preserves KV state for a "cache breakpoint" — a reusable prefix. Each request is matched
  from longest to shortest candidate prefix against what's already cached. Cache reuse requires the **entire**
  rendered prefix to match exactly, so any change anywhere in the prefix breaks the match from that point on.
- **What counts toward the prefix**: the model's full rendered context — OpenAI's own hidden system content,
  developer/system instructions, tool definitions, and the conversation history (text, images, documents, supported
  audio) — in that order. Settings that participate in prefix identity: `model`, `tools` (names, descriptions,
  schemas, **and their order**), `parallel_tool_calls`, `text.format`, `reasoning.effort`, `text.verbosity`,
  `context_management`. Changing any of these changes the effective cache key, not just the content after them.
- **Minimum cacheable length**: 1,024 tokens for GPT-5.6+ (our assumed bucket for Luna). OpenAI's own hidden system
  tokens don't count toward that minimum. Earlier models used a 128-token rounding rule instead; that does not apply
  here (or if Luna turns out not to be in the GPT-5.6+ bucket, treat the reported `cached_tokens` as rounded down to
  the nearest 128).
- **What the GPT-6 blog reportedly changed**: not verifiable — source 1 never loaded. Do not assume anything about
  it beyond what's in this section.
- **`prompt_cache_key`**: for GPT-5.6+, this is now optional and only needed for **separate cache accounting** (e.g.
  per customer/workspace), not for routing to a cache — the newer caching path apparently doesn't need it to find a
  match the way older models did. It's still good practice to set a stable key: "assign a distinct key per
  customer/user whose accounting should stay separate" and "reuse the same key for a customer's related requests."
  High-volume guidance (~15 req/min per key across prefixes) doesn't apply to our single-agent, low-QPS use.
- **Retention**: GPT-5.6+ uses `prompt_cache_options.ttl`, and **only `"30m"` is a supported value — which is also
  the default.** There is no extended/24h option at this tier (that only exists for earlier models via the separate
  `prompt_cache_retention: "in_memory" | "24h"` param, defaulted by the org's Zero Data Retention setting). Net
  effect for us: **TrueForge not forwarding `prompt_cache_retention` doesn't cost us anything if Luna is GPT-5.6+**,
  because there's nothing to opt into beyond the 30-minute default.
- **Reading cache hits**: `usage.input_tokens_details.cached_tokens` (tokens served from cache) and
  `usage.input_tokens_details.cache_write_tokens` (tokens newly written to cache this turn), against
  `usage.input_tokens` (total). Hit rate = cached_tokens / input_tokens.
- **Pricing mechanics for GPT-5.6+**: cache reads cost 0.1× the input rate (matches the $0.01 vs $0.10 cached/input
  price above); cache writes cost 1.25× the input rate. Writing a prefix once and fully reusing it once nets 1.35×
  ordinary input cost total, vs 2× for reprocessing uncached twice — i.e. caching only pays off from the *second*
  reuse of a given prefix onward within its TTL, not the first.

## 3. Applied to our agent (TrueForge 0.2.1 → OpenAI Responses API)

Given: `store: false`, `include: ["reasoning.encrypted_content"]`, no server-side conversation storage — every turn
re-sends full instructions + message history + tool results, so the *only* lever we have is prefix caching. TrueForge
forwards `reasoning_effort`, `temperature`, `top_p`, `max_tokens`→`maxOutputTokens`, and for OpenAI additionally
`service_tier`, `user`, `prompt_cache_key`, `parallel_tool_calls`, `reasoning_summary` — but **not**
`prompt_cache_retention` (irrelevant per §2, since Luna's only retention option is the 30m default anyway) and not
`prompt_cache_options.ttl` (also moot for the same reason, as long as Luna is confirmed GPT-5.6+ tier).

Concrete, checkable rules:

1. **Keep `instructions` byte-identical across runs.** No dates, issue numbers, or run IDs in the agent spec's
   instructions or the inlined `skills/ticket-resolver/SKILL.md` — any single byte changed anywhere invalidates the
   cached prefix from that point forward. This is already the design (date is deliberately kept out of
   `instructions`); don't regress it when editing the skill.
2. **Put all stable content first.** Order stays: hidden OpenAI system content → our `instructions` (with SKILL.md
   inlined) → tool definitions → then the kickoff user message (`Resolve GitHub issue #<n> in <repo>. Approval mode:
   <mode>. Today is <date>.`) → then whatever accumulates (tool results, issue text, command output). The kickoff
   message is the correct place for the date/issue-number/mode variability — never move it earlier.
3. **Don't reorder or reword tool definitions between runs.** Tool name, description, and JSON-schema order are part
   of the cache key (§2). Adding/removing a GitHub MCP tool, the triage MCP tool, or changing the `call_tool`
   meta-tool's shape resets caching for every session that follows until the new shape stabilizes.
4. **Set a static `prompt_cache_key`.** Propose `shipgate-ticket-resolver-v1`; bump the suffix only when the
   instructions/skill/tool-set changes on purpose (mirrors "version prompts in code" from the prompt-engineering
   guide, and doubles as a changelog marker in the cache-accounting sense from §2).
5. **Never change `reasoning_effort` mid-run.** It's part of the prefix identity; flips reset the cache for that
   session's remaining turns.
6. **Don't edit history.** Any mutation of an earlier message (not just appends) invalidates the prefix from that
   point on — obvious, but worth stating since "orchestrator relays approvals" work could tempt someone into
   patching a prior turn instead of appending a new one.
7. **Verify cache hits from run artifacts.** Each turn's raw response `usage` object (wherever TrueForge logs it —
   check the run directory's event log) should show a growing `input_tokens_details.cached_tokens` close to
   `input_tokens` from turn 2 onward in a session; a flat/zero `cached_tokens` on turn 2+ means something in rules
   1–6 broke the prefix. Since our skill (~26K chars ≈ well over the 1,024-token minimum) is the bulk of the prefix,
   even a single early cache hit should be visible in usage.
8. Because source 1 never loaded, we have no GPT-6-specific caching guidance beyond the general guide — re-check
   `openai.com/index/better-prompt-caching-for-gpt-6/` before the demo in case it has agent-relevant specifics (e.g.
   a documented `gpt-6-luna` caching quirk) that this reference is missing.

## 4. Prompting `gpt-6-luna` for this agent

`gpt-6-luna` supports a `none` reasoning effort and up to `max`, so it behaves like a hybrid reasoning/non-reasoning
model depending on the setting chosen — treat the prompting style accordingly rather than picking one lane
blindly.

- **Developer-message structure**: keep the Identity → Instructions → Examples → Context shape from the
  prompt-engineering guide. Use Markdown headers for the big sections (Identity, Instructions, Tool-use rules,
  Output format) and XML tags for content the model should not paraphrase (issue body, command output blocks) —
  this also gives the model — and us, reading logs — clean delimiters, per the reasoning-best-practices guide's
  "use clear delimiters" advice.
- **Explicit tool-use rules stay explicit.** The reasoning-best-practices guide's "avoid chain-of-thought prompts,
  keep it simple" advice is written for pure reasoning models (o1/o3-class) reasoning silently before one final
  answer; our agent is a multi-turn tool-using loop, which is closer to the agentic guidance in source 4. Keep
  SKILL.md's explicit, numbered tool-use rules (when to call GitHub MCP vs triage vs sandbox `exec`, the
  one-GitHub-write-per-turn rule inherited from the DeepSeek reference) rather than replacing them with a vague
  high-level goal — source 4's agentic guidance (bias toward action, finish authorized work, don't over-verify
  reversible steps) layers on top of those rules, it doesn't replace them.
- **Persistence.** Carry over the "plan and persist until solved" instruction from the prompt-engineering guide, and
  source 4's "treat requests like 'can you...' as authorization to execute" framing — but our approval gates
  (opening a PR, replying on a ticket, etc.) still override this: the skill must keep stating explicitly which
  actions require a pause regardless of how "authorized" the model feels.
- **Preambles before tool calls.** Keep brief preambles before notable tool calls (per the prompt-engineering guide)
  — one line stating what's about to run and why, before a sandbox `exec` or an MCP write — both for the "film the
  approval moment" hackathon requirement and because it doubles as the log trail `check.py` and human reviewers read.
- **TODO/rubric tracking.** Keep the skill's step checklist; source 4's guidance to reduce "excessive clarification"
  and "over-verification" pushes toward trusting the checklist once each item's condition is met, rather than
  re-confirming already-passed steps.
- **Output format for the final JSON handoff.** No change: end the final message with one fenced ` ```json ` handoff
  block (schema in `docs/SPEC.md` §7). Do not use `text.format` (Structured Outputs) for this — enabling it changes
  what's part of the cache key (§2) and existing usage doesn't need it, since we're already asking for a fenced code
  block in plain text (same rationale as the DeepSeek reference's "keep the handoff as a fenced block" rule).
- **Reasoning effort recommendation**: use **`high`**, not `medium` (the model's default) and not `xhigh`/`max`.
  This is a multi-step coding-and-tool-use agent (branch, patch, sandbox test, PR), which benefits from more
  deliberation than the default, but `xhigh`/`max` cost more per turn and there's no evidence (nothing in the
  fetched docs) that this task needs the top tier — **[inference]**; treat as a starting point to validate with the
  TR-01 scored run in §6, not a settled number.
- **Params to set/drop**: temperature/top_p acceptance is unconfirmed (§1). Given OpenAI's reasoning-model line
  generally ignores or rejects sampling params once a non-`none` `reasoning_effort` is set, **drop `temperature` and
  `top_p` from the agent's `model.params` for `gpt-6-luna`** rather than carrying over the DeepSeek reference's
  `temperature: 1.0, top_p: 0.95` — **[inference]**; if TrueForge/OpenAI errors or silently ignores them, that
  confirms it; don't spend time guessing further. Do set `reasoning_effort: "high"` explicitly (never rely on the
  `medium` default, since the default could change between OpenAI's own doc revisions). Leave `max_tokens` at
  whatever headroom the run needs — 128,000 max output is generous, so err high rather than truncating tool calls,
  mirroring the DeepSeek reference's truncation warning.

## 5. Migration checklist from DeepSeek V4 Flash

- [ ] Register a new TrueForge model provider of type `openai` (Settings → Models), not `custom` — separate from the
      existing OpenRouter `custom` provider used for DeepSeek/GLM.
- [ ] Set model id to `gpt-6-luna` (no dated snapshot exists to pin instead — see §1).
- [ ] Update the agent spec's `model.params`:
  - Remove `temperature: 1.0`, `top_p: 0.95` (§4 — unconfirmed accepted; assume dropped until proven otherwise).
  - Set `reasoning_effort: "high"` (replacing the DeepSeek reference's `"high"`-for-different-reasons value — same
    literal setting, different model, re-validate empirically).
  - Set `prompt_cache_key: "shipgate-ticket-resolver-v1"` (new — OpenRouter path didn't expose this knob to us).
  - Drop any OpenRouter-specific fields (`reasoning.exclude`, provider preferences) — not applicable to the OpenAI
    provider path.
  - Leave `max_tokens` sized for 128K max output headroom; re-check current value isn't still tuned for DeepSeek's
    much larger effective context.
- [ ] Do not change tool definitions, their order, or `skills/ticket-resolver/SKILL.md` content in the same change as
      the provider swap — keep the caching variables isolated so a broken cache is traceable to the model swap alone
      (§3 rule 3).
- [ ] Run `scripts/reset.sh` then `scripts/score.sh TR-01` — one scored run — and confirm `check.py` prints no FAIL.
- [ ] While reviewing that run's artifacts, check `usage.input_tokens_details.cached_tokens` on turn 2+ per §3 rule 7
      to confirm caching is actually engaging before treating the migration as done.
- [ ] Re-attempt `openai.com/index/better-prompt-caching-for-gpt-6/` (blocked twice during this research — source 1) before
      relying further on the GPT-5.6+ assumptions in §2.
