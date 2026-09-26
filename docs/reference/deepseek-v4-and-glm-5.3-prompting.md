# Prompting reference: DeepSeek V4 Flash and GLM-5.3-Flash via OpenRouter

> **Superseded 2026-09-26** as the current-model reference by
> [`gpt-6-luna-prompting-and-caching.md`](gpt-6-luna-prompting-and-caching.md). Still valid when `shipgate.yaml`
> sets `trueforge.model: openrouter/...`.

Our notes for the Ticket Resolver model (primary DeepSeek V4 Flash, fallback GLM-5.3-Flash), reached through OpenRouter as
a TrueForge `custom` provider. Paraphrased from vendor docs and model cards, researched 2026-09-26; each point cites its
source. **[unverified]** = inference or not confirmable. TrueForge behaviour was read from the installed 0.2.1 source
(`VercelAILLM.mjs`, `TurnResourceResolver.mjs`), not tested on the wire.

Verified by us on 2026-09-26 (OpenRouter models API): `deepseek/deepseek-v4-flash` is named **"DeepSeek V4 Flash 0423"**
(the April preview); `deepseek/deepseek-v4-flash-0731` is the re-post-trained release (31 endpoints, all with tools).

## 0. Headline findings
- **Our bake-off tested the 0423 preview.** DeepSeek's 0731 card reports large agentic gains over it (Terminal Bench 2.1
  61.8 → 82.7; DeepSWE 7.3 → 54.4). [huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731]
- **DeepSeek's own API retired V4 Flash on 2026-09-10** (its `deepseek-v4-flash` name now routes to V4.1 Flash). On
  OpenRouter both V4 Flash slugs are served by third-party hosts. [api-docs.deepseek.com/updates]
- **Reasoning must be replayed across tool calls.** Both models think between tool calls and expect that reasoning sent
  back. TrueForge stores it as thinking blocks and replays it; `@ai-sdk/openai-compatible` 3.0.55 sends it as
  `reasoning_content`, which OpenRouter accepts. [openrouter.ai/docs/guides/best-practices/reasoning-tokens]
- **No official V4 / 5.3 prompt-style guide** (XML vs markdown, placement, few-shot) from either vendor. [searched]

## 1. DeepSeek V4 Flash

| Topic | Guidance | Source |
| --- | --- | --- |
| Prompt structure | System prompt is a plain leading block; tool schemas are injected into it as a "## Tools" section. In 0731, `reasoning_effort` becomes a text prefix before the system prompt, so changing effort changes the cached prefix | HF 0731 `encoding/README.md` |
| Sampling | 0731: temperature 1.0; top_p 0.95 for agentic work (1.0 otherwise). 0423: 1.0 / 1.0 | HF model cards |
| Don't | The old "coding = temperature 0.0" table predates V4 thinking; don't apply it. In thinking mode DeepSeek's API ignores temperature and penalties | api-docs.deepseek.com thinking_mode, parameter_settings |
| Thinking | On by default (effort low / high / max). With tools, earlier reasoning must be sent back (DeepSeek's API returns 400 otherwise). Max effort wants ≥ 384K context | api-docs.deepseek.com/guides/thinking_mode |
| Tools | OpenAI format; the model can emit several tool calls in one turn. `strict` mode is beta, DeepSeek API only (not OpenRouter hosts [unverified]) | api-docs.deepseek.com/guides/tool_calls |
| JSON | `json_object` mode needs "json" in the prompt and can return empty content: prefer a fenced block in text | api-docs.deepseek.com/guides/json_mode |
| Caching | Automatic, full-prefix match, lasts hours | api-docs.deepseek.com/guides/kv_cache |
| Limits | 1M context; output caps vary by OpenRouter host (32K to ~943K) | OpenRouter endpoints API |

## 2. GLM-5.3-Flash (Z.ai)

| Topic | Guidance | Source |
| --- | --- | --- |
| Prompt structure | For coding agents: Goal / Context / Constraints / Done-when; plan before executing; repeated rules in skills | docs.z.ai/devpack/resources/best-practice |
| Sampling | temperature 1.0, top_p 0.95; tune only one | docs.z.ai GLM-5.3-Flash and migration guides |
| Thinking | Always on (disabling errors). Effort low / high / **max (default)**. Interleaved thinking: return thinking with tool results unmodified, in order; this also raises cache hits | docs.z.ai/guides/capabilities/thinking-mode |
| Tools | `tool_choice` supports only `auto`; single-purpose tools, clear names, full parameter descriptions | docs.z.ai/guides/capabilities/function-calling |
| JSON | `json_object` only | docs.z.ai struct-output |
| Caching | Implicit; identical content hits best, keep the system prompt stable | docs.z.ai/guides/capabilities/cache |
| Limits | 1M context; 128K max output (default 65,536) | docs.z.ai concept-param |

## 3. OpenRouter
- `reasoning` object (`effort`, `max_tokens`, `exclude`, `enabled`) or top-level `reasoning_effort`; reasoning counts
  against `max_tokens`; pass returned reasoning back unmodified. GLM rejects `none`. [OpenRouter parameters + reasoning docs]
- OpenRouter doesn't inject missing sampling params: each host uses its own defaults. [parameters doc]
- Caching for DeepSeek and Z.ai is automatic (cache reads ~0.1× / ~0.2× input). Sticky routing keys on the first system
  + first user message; expires after 10 min idle. [prompting-caching guide]
- Auto Exacto reorders providers on tool-calling requests by tool-call error rate and throughput. [routing docs]
- Presets (`model@preset/slug`) carry provider preferences; TrueForge can't send `provider` itself. [presets doc]
- TrueForge forwards `spec.model.params` (`temperature`, `top_p`, `max_tokens`, `reasoning_effort`) to OpenRouter.

## 4. Recommendations for Ticket Resolver
1. Use `deepseek/deepseek-v4-flash-0731` (pinned, not `-latest`); re-run `scripts/bakeoff.py` first. Output is dearer
   ($0.32/M vs $0.094/M) but a run stays under a cent.
2. Set `reasoning_effort: "high"` explicitly (not `max`: slower, wants 384K). Same for the GLM fallback, whose default
   `max` may explain its slower bake-off run [inference].
3. Set `temperature: 1.0`, `top_p: 0.95` for 0731 (agentic recommendation) so behaviour doesn't depend on the host.
4. Never set `reasoning.exclude` / `include_reasoning: false`: tool loops need reasoning replayed.
5. Set `max_tokens` ≈ 32768: reasoning shares the budget; small caps give truncated tool calls.
6. Keep the cached prefix byte-stable: same tools in the same order; don't change effort mid-run; move "today is …"
   from `instructions` to the kickoff message.
7. SKILL.md rule: at most one GitHub write per turn (parallel tool calls are possible and few hosts honour
   `parallel_tool_calls: false`).
8. Keep the handoff as a fenced `json` block in text, not `response_format`.
9. Add an explicit "Done when" line to the skill (Z.ai's Goal / Constraints / Done-when pattern).
10. Fall back to GLM per run, never mid-session (replaying DeepSeek reasoning into GLM is undefined [inference]).
