# docs/

| File | What it is | Read it when |
| --- | --- | --- |
| [SPEC.md](SPEC.md) | The design: scope, Ticket Resolver flow T1–T15, evidence check, push-back, HITL protocol, fixtures, scorer | You change agent behaviour or scoring |
| [contracts.md](contracts.md) | Wiring between skill, orchestrator and scorer: CLI, run directory, approval record, scenario YAML, TrueForge API facts | You touch `orchestrator/` or `scripts/check.py` |
| [model-bakeoff.md](model-bakeoff.md) | How the agent's model was chosen: four cheap OpenRouter models on the real task, with cost | You change the model |
| [HANDOVER.md](HANDOVER.md) | Work log: done / blocked / next, newest first | You start or finish a work block |
| [MEMORY.md](MEMORY.md) | Decisions and verified facts, one line each, never deleted | You make a decision or learn a fact |
| [tech-debt.md](tech-debt.md) | Critique of the current flow and prioritized tech debt, with evidence and status | You pick up cleanup work or judge a risk |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | The original day plan (phases, owners, demo script) | Planning the demo |
| [research-and-plan.md](research-and-plan.md) | Pre-event research: rules, judging, competitors, all three agent designs and test catalogues | Background, or building P1 / optional agents |
| [superpowers/plans/](superpowers/plans/) | Step-by-step execution plans (current: Jev triage pre-check) | You pick up the next task |
| [superpowers/specs/](superpowers/specs/) | Design specs behind the plans (current: Jev triage pre-check, triage-v1) | You change a design decision |
| [reference/](reference/) | Notes that shaped the skill: **GPT-6 Luna prompting + prompt caching (current model)**, DeepSeek V4 + GLM-5.3 prompting (previous model), Gemini 3 prompting, SWE-agent patterns, issue-ai-agent + TypeSafe, a `gh`-based fix-issue draft | Improving the skill or prompt |
