# Reference: issue-ai-agent (GitHub Action) and TypeSafe (Jev)

Our notes, paraphrased, checked 2026-09-26. Neither is a drop-in part of Ticket Resolver; this file records what each is,
what we borrow, and how TypeSafe could fit if we use it.

## 1. issue-ai-agent

[alexyan0431/issue-ai-agent](https://github.com/alexyan0431/issue-ai-agent) (MIT, v1.0.0, May 2026, 4 stars) is a
**single-shot triage bot**, not an agent: on `issues: opened` / `issue_comment: created` it classifies the issue
(7 categories × 4 priorities), labels it, searches for duplicates, and posts a short reply. It never writes code, runs
tests or opens PRs, and it posts **without any human approval**.

Pipeline (`src/pipeline.ts`): exclude rules → sanitise text (`src/sanitizer.ts`) → classify (JSON parsed from plain text)
→ labels → duplicate search (title keywords, LLM picks true duplicates) → 3–5 sentence reply. Default model
`claude-haiku-4-5-20251001` via Anthropic or OpenAI chat APIs; no tool calling.

Issues seen in its source (not run): the `llm-provider` input is never read, so provider always defaults to Anthropic,
and with no key a "dev mode" still labels and comments on the real issue. The duplicate prompt uses unsanitised text.

**What we borrow for Ticket Resolver**

| Their feature | Our rule |
| --- | --- |
| Issue text wrapped in "untrusted data" markers | Ticket body goes into the prompt inside `<ticket>` tags, labelled data; instruction-like text is quoted, never followed |
| Sanitiser: strip zero-width/control characters, cap title 500 / body 10k chars | Orchestrator does the same before logging; the agent quotes at most a short excerpt of suspicious text |
| Skip comments from bots | Our reply loop can't trigger itself: the orchestrator ignores events authored by the PAT's user |
| Duplicate search before replying | T4: check for an open `fix/issue-<n>` PR first |
| Security reports → private channel | Push back: a ticket that reports a vulnerability gets a gated comment pointing to private disclosure, no public repro |
| Reply length cap | Reply ≤ 120 words; PR body holds the details |

## 2. TypeSafe / Jev

[TypeSafe](https://docs.typesafe.ai/introduction) sells **Jev**, a "System One" decision model. You send a state
(text/JSON) plus typed questions and get calibrated answers:

- **Choice**: pick one of up to 255 options, with probabilities and a confidence.
- **Score**: an ordered level (2–10), with probabilities and a confidence.
- **Noul**: probability that a statement is true.

It **cannot** generate text, write code, chat or call tools, and has **no OpenAI-compatible endpoint**
([coding agents](https://docs.typesafe.ai/introduction/coding-agents.md), [API](https://docs.typesafe.ai/api.md)).
So it **cannot be a TrueForge model provider** (not even `custom`) and cannot run the agent loop.

| Fact | Value |
| --- | --- |
| API | `POST https://api.typesafe.ai/v1/systemone`, `GET /v1/models`; `Authorization: Bearer <key>` |
| Model | `jev-1.13.0` (`jev-latest`, `jev-preview` alias it); 64k context, text only |
| Price / limits | $0.042 per 1M input tokens, output free; 250k tokens/s, 1,200 req/min; early access (waitlist), no free tier found |
| SDKs | Python `typesafe-sdk` (≥3.10, 10 s default timeout), JS `@typesafe-ai/sdk` (Node ≥20) |
| Weak spots (their docs) | counting, maths, **dates**, double negatives, noisy context, **prompt injection** |
| `.env` names | `TYPESAFE_API_KEY` (required); optional `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, `TYPESAFE_LOG_LEVEL` |

Their build guidance: keep logic in code; one specific question each, many in parallel on the same state; describe what
each Choice option includes/excludes and add `other`; send state as named JSON fields; route on confidence
(auto above 0.9, confirm 0.5–0.9, human below 0.5); avoid agent loops.

**Only realistic fit:** our own MCP server wrapping `/v1/systemone` as a read-only `triage_ticket` tool (e.g. "is this
in `humanize` code?", "does it state expected vs actual?", "is it a security report?"), with a chat model (Gemini)
still driving the agent. Don't use it to detect injection (a documented weak spot) or anything date-related (case #4).
