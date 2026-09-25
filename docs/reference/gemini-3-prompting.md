# Prompting reference: Gemini 3 Flash on TrueForge

Our notes for writing `skills/ticket-resolver/SKILL.md` and the agent `instructions`. Paraphrased from Google's
guides (content CC BY 4.0) and TrueForge's docs/source, then applied to Ticket Resolver. Checked 2026-09-26.

Sources:
- [Gemini 3 developer guide](https://ai.google.dev/gemini-api/docs/gemini-3) (Google, CC BY 4.0)
- [Prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies) (Google, CC BY 4.0)
- [TrueForge skills](https://trueforge.dev/skills), TrueForge 0.2.1 source (`VercelAILLM.ts`, `model-catalog.yaml`)

## 1. Model settings (agent spec)

| Setting | Use | Why |
| --- | --- | --- |
| `model.name` | `google-gemini/gemini-3-6-flash` | Configured provider; 1M context, 64k output |
| `model.params.temperature` | **leave unset** (Gemini default 1.0) | Google: values below 1.0 can cause looping or worse reasoning on Gemini 3. Our old plan said 0.2: don't. |
| `model.params.reasoning_effort` | `high` | TrueForge passes it through as Gemini's thinking level (`minimal`/`low`/`medium`/`high`). High = deep planning and bug finding, which is our job. |
| `config.sandbox.enabled` | `true` | Off by default. Skills need the sandbox. |
| `skills[].preload` | `true` | Inlines SKILL.md into the prompt, so the procedure is always in context instead of relying on the model to pick the skill. |

Thought signatures (Gemini's reasoning state between tool calls) are handled by TrueForge's provider adapter; nothing to do.

## 2. How Gemini 3 wants to be prompted

- **Short and direct.** State the goal and the constraints plainly. No persuasion, no "IMPORTANT!!!", no
  long chain-of-thought scaffolding: with thinking on, extra "think step by step" text adds nothing.
- **One structure, used consistently.** XML-style tags (`<role>`, `<constraints>`, `<procedure>`, `<output_format>`)
  or Markdown headings, not a mix.
- **Critical rules at the top**, role and hard constraints first. For long inputs (ticket text, test logs), put the
  data first and the specific question last ("Based on the log above, ...").
- **Define ambiguous terms.** Say exactly what "reproduced", "green" or "intermittent" mean in numbers.
- **Output is terse by default.** Ask explicitly for the evidence card and the handoff JSON in a fixed format.
- **Examples beat descriptions for format.** A few consistent examples (same tags, same spacing) regulate phrasing;
  keep them varied so the model doesn't copy one.
- **Grounding.** Say what to rely on (tool output, the ticket) and that nothing else counts as evidence.
- **Date awareness.** Tell it today's date if dates matter (freezegun cases #4).

## 3. Agent-specific guidance from Google, applied

| Google's advice | Ticket Resolver rule |
| --- | --- |
| Plan before acting | First output: a short plan (ticket parse, pinned SHA, which test to write). |
| Separate exploratory from state-changing actions | Reads + sandbox work are free; `create_branch`/`push_files` only after green evidence; PR and comment are gated. |
| Say whether to stick to the plan or pivot | Pivot allowed inside the sandbox; never widen scope beyond the ticket. |
| Set retry limits and when to change strategy | Max **2** patch attempts; after a red attempt, change the approach, never repeat the same patch; then stop with evidence. |
| Self-verify before responding | Check the evidence card against the numeric definitions before asking for approval. |
| Say when to ask vs assume | Ambiguous ticket → one clarifying comment (gated), never a guess. |

## 4. TrueForge skill mechanics

- SKILL.md = YAML frontmatter (`name`, `description`) + Markdown body. The description is the only thing the model
  sees up front unless `preload: true`.
- Git-backed: registered with repo URL + `path` + `ref`; pin `ref` to a commit SHA for the demo.
- On use, the repo is materialised into the sandbox (Daytona: `/opt/tfy/skills/<name>`; local sandbox uses its own
  layout). Heavy reference material goes in supporting files next to SKILL.md, read on demand.
- Two skills can't share a name on one agent. Prefer focused skills over one big pack.

## 5. Checklist before committing SKILL.md or instructions

- [ ] Hard rules first, in one tag/section; each rule testable (maps to a TR scenario).
- [ ] Every threshold is a number (3/3, 10/10, 2 attempts).
- [ ] Ticket text and approval reasons are marked as data; only the `REVISE:`/`EDIT:`/`STOP` prefixes are protocol.
- [ ] Evidence card and handoff JSON have one fixed template each, with one filled example.
- [ ] No temperature set; `reasoning_effort: high`; `preload: true`.
- [ ] No persuasive filler; total SKILL.md short enough to read in two minutes.
