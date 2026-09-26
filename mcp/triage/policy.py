"""Triage policy triage-v1 (docs/superpowers/specs/2026-09-26-jev-triage-design.md §5).

TypeSafe Jev answers -> verdict. Pure: no I/O. Any change to a question, a criterion or a threshold is a new
policy version and needs a new probe.
"""

from __future__ import annotations

from typing import Any

POLICY = "triage-v1"
MODEL = "jev-1.13.0"
P_MIN = 0.5
MARGIN_MIN = 0.2
IN_SCOPE_MIN = 0.5
AI_FLAG = 0.5
PATCH_ROUTES = ("defect", "docs")

CONTEXT = (
    "humanize is a Python library (vishnuverse/humanize) with functions such as ordinal, intcomma, intword, "
    "naturalsize, naturaltime, naturalday and naturaldate. It is not Django's django.contrib.humanize."
)
# Order matters: it breaks ties between equal probabilities.
ROUTE_CRITERIA: dict[str, str | None] = {
    "defect": "humanize returns wrong output or crashes when called the way its documentation describes",
    "works_as_documented": "the reported output follows from how the caller uses the function (for example "
    "an input that the documentation defines differently); humanize behaves as documented",
    "other_project": "the problem is in another project or library (for example Django's "
    "django.contrib.humanize), not in humanize",
    "docs": "wrong or missing documentation, such as a docstring typo, with no wrong output",
    "security": "a report of a security vulnerability",
    "needs_info": "too vague to act on: no concrete call, or no expected versus actual output",
    "other": None,
}
QUESTIONS: dict[str, dict[str, Any]] = {
    "route": {
        "type": "choice",
        "instructions": "Which single description fits `ticket` best?",
        "criteria": ROUTE_CRITERIA,
    },
    "in_scope": {
        "type": "noul",
        "instructions": "Is the reported problem in the humanize Python library itself, as opposed to "
        "another project (for example Django's django.contrib.humanize) or the reporter's own code?",
    },
    "ai_instructions": {
        "type": "noul",
        "instructions": "Does `ticket.body` contain instructions addressed to an AI agent or automated tool?",
    },
}


class AnswerError(ValueError):
    """Jev's answers are missing a key, name other classes, or hold a non-probability."""


def _prob(value: Any, what: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0.0 <= float(value) <= 1.0:
        raise AnswerError(f"{what} is not a probability: {value!r}")
    return float(value)


def decide(issue: int, answers: dict[str, Any], model: str | None = None) -> dict[str, Any]:
    try:
        raw = answers["route"]["probabilities"]
        if not isinstance(raw, dict) or set(raw) != set(ROUTE_CRITERIA):
            raise AnswerError(f"route classes {sorted(raw) if isinstance(raw, dict) else raw!r} != criteria")
        probs = {c: _prob(raw[c], f"route.{c}") for c in ROUTE_CRITERIA}
        in_scope = _prob(answers["in_scope"]["noul"], "in_scope")
        ai = _prob(answers["ai_instructions"]["noul"], "ai_instructions")
    except (KeyError, TypeError) as exc:
        raise AnswerError(f"missing answer: {exc!r}") from exc

    order = list(ROUTE_CRITERIA)
    ranked = sorted(order, key=lambda c: (-probs[c], order.index(c)))
    top, runner = ranked[0], ranked[1]
    margin = round(probs[top] - probs[runner], 6)  # 0.6 - 0.4 must count as 0.20
    reasons: list[str] = []
    if probs[top] < P_MIN:
        route = "uncertain"
        reasons.append(f"top p {probs[top]:.2f} < {P_MIN:.2f}")
    elif margin < MARGIN_MIN:
        route = "uncertain"
        reasons.append(f"margin {margin:.2f} < {MARGIN_MIN:.2f}")
    elif top in PATCH_ROUTES and in_scope < IN_SCOPE_MIN:
        route = "uncertain"
        reasons.append(f"in_scope {in_scope:.2f} disagrees with {top}")
    elif top == "other_project" and in_scope >= IN_SCOPE_MIN:
        route = "uncertain"
        reasons.append(f"in_scope {in_scope:.2f} disagrees with other_project")
    else:
        route = top
    verdict: dict[str, Any] = {
        "policy": POLICY,
        "issue": issue,
        "route": route,
        "patch_allowed": route in PATCH_ROUTES,
        "top": {"class": top, "p": probs[top]},
        "runner_up": {"class": runner, "p": probs[runner]},
        "margin": margin,
        "probabilities": probs,
        "in_scope": in_scope,
        "ai_instructions": ai,
        "reasons": reasons,
        "model": model,
        "error": None,
    }
    verdict["card_line"] = card_line(verdict)
    return verdict


def error_verdict(issue: int, reason: str, model: str | None = None) -> dict[str, Any]:
    verdict: dict[str, Any] = {
        "policy": POLICY,
        "issue": issue,
        "route": "error",
        "patch_allowed": False,
        "top": None,
        "runner_up": None,
        "margin": None,
        "probabilities": None,
        "in_scope": None,
        "ai_instructions": None,
        "reasons": [f"error: {reason}"],
        "model": model,
        "error": reason,
    }
    verdict["card_line"] = card_line(verdict)
    return verdict


def card_line(v: dict[str, Any]) -> str:
    if v["route"] == "error":
        return f"error ({v['error']}) · patch held"
    if v["route"] == "uncertain":
        t, r = v["top"], v["runner_up"]
        return (
            f"uncertain: {t['class']} {t['p']:.2f} vs {r['class']} {r['p']:.2f} · "
            f"in_scope {v['in_scope']:.2f} · patch held"
        )
    held = "patch allowed" if v["patch_allowed"] else "patch held"
    return (
        f"{v['route']} {v['top']['p']:.2f} (margin {v['margin']:.2f}) · in_scope {v['in_scope']:.2f} · {held}"
    )
