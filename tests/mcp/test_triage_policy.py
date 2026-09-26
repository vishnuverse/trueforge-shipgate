"""Policy triage-v1 (spec §5): Jev answers -> verdict. Rows use the probe v2 numbers (docs/MEMORY.md)."""

from __future__ import annotations

import pytest
from policy import (
    MARGIN_MIN,
    P_MIN,
    POLICY,
    QUESTIONS,
    ROUTE_CRITERIA,
    AnswerError,
    card_line,
    decide,
    error_verdict,
)

CLASSES = list(ROUTE_CRITERIA)


def answers(probs: dict[str, float], in_scope: float = 0.9, ai: float = 0.02) -> dict:
    full = dict.fromkeys(CLASSES, 0.0)
    full.update(probs)
    return {
        "route": {
            "type": "choice",
            "choice": max(full, key=full.get),
            "probabilities": full,
            "confidence": 0.9,
        },
        "in_scope": {"type": "noul", "noul": in_scope},
        "ai_instructions": {"type": "noul", "noul": ai},
    }


def test_issue_1_defect_is_patchable() -> None:
    v = decide(
        1, answers({"defect": 0.96, "works_as_documented": 0.03, "other": 0.01}, in_scope=0.93), "jev-1.13.0"
    )
    assert v["policy"] == POLICY == "triage-v1"
    assert v["route"] == "defect" and v["patch_allowed"] is True
    assert v["top"] == {"class": "defect", "p": 0.96}
    assert v["runner_up"] == {"class": "works_as_documented", "p": 0.03}
    assert v["margin"] == pytest.approx(0.93)
    assert v["reasons"] == [] and v["error"] is None and v["model"] == "jev-1.13.0"
    assert v["card_line"] == "defect 0.96 (margin 0.93) · in_scope 0.93 · patch allowed"


def test_issue_3_near_tie_is_uncertain_and_held() -> None:
    probs = {
        "defect": 0.52,
        "works_as_documented": 0.44,
        "other_project": 0.02,
        "needs_info": 0.01,
        "other": 0.01,
    }
    v = decide(3, answers(probs, in_scope=0.37))
    assert v["route"] == "uncertain" and v["patch_allowed"] is False
    assert v["reasons"] == ["margin 0.08 < 0.20"]
    assert v["card_line"] == "uncertain: defect 0.52 vs works_as_documented 0.44 · in_scope 0.37 · patch held"


def test_issue_5_docs_is_patchable_and_reports_ai_instructions() -> None:
    v = decide(5, answers({"docs": 0.98, "defect": 0.02}, in_scope=0.96, ai=0.99))
    assert v["route"] == "docs" and v["patch_allowed"] is True and v["ai_instructions"] == 0.99
    assert v["card_line"] == "docs 0.98 (margin 0.96) · in_scope 0.96 · patch allowed"


def test_issue_7_other_project_is_held() -> None:
    v = decide(
        7, answers({"other_project": 0.74, "defect": 0.19, "works_as_documented": 0.07}, in_scope=0.28)
    )
    assert v["route"] == "other_project" and v["patch_allowed"] is False
    assert v["card_line"] == "other_project 0.74 (margin 0.55) · in_scope 0.28 · patch held"


@pytest.mark.parametrize(
    ("probs", "route"),
    [
        ({"defect": 0.50, "works_as_documented": 0.25, "other": 0.25}, "defect"),
        ({"defect": 0.49, "works_as_documented": 0.26, "other": 0.25}, "uncertain"),
    ],
)
def test_top_probability_boundary(probs: dict[str, float], route: str) -> None:
    assert P_MIN == 0.5
    assert decide(1, answers(probs))["route"] == route


@pytest.mark.parametrize(
    ("probs", "route"),
    [
        (
            {"defect": 0.60, "works_as_documented": 0.40},
            "defect",
        ),  # 0.6 - 0.4 is 0.19999999999999996 in floats
        ({"defect": 0.595, "works_as_documented": 0.405}, "uncertain"),
    ],
)
def test_margin_boundary(probs: dict[str, float], route: str) -> None:
    assert MARGIN_MIN == 0.2
    assert decide(1, answers(probs))["route"] == route


def test_in_scope_disagreement_holds_a_defect() -> None:
    v = decide(1, answers({"defect": 0.9, "works_as_documented": 0.1}, in_scope=0.49))
    assert v["route"] == "uncertain" and v["reasons"] == ["in_scope 0.49 disagrees with defect"]


def test_in_scope_disagreement_holds_other_project() -> None:
    v = decide(7, answers({"other_project": 0.9, "defect": 0.1}, in_scope=0.5))
    assert v["route"] == "uncertain" and v["reasons"] == ["in_scope 0.50 disagrees with other_project"]


@pytest.mark.parametrize("route", ["works_as_documented", "security", "needs_info", "other"])
def test_non_patch_routes_are_held(route: str) -> None:
    v = decide(2, answers({route: 0.9, "defect": 0.1}))
    assert v["route"] == route and v["patch_allowed"] is False
    assert v["card_line"].endswith("· patch held")


def test_ties_break_in_criteria_order() -> None:
    v = decide(1, answers({"works_as_documented": 0.45, "defect": 0.45, "other": 0.10}))
    assert v["top"]["class"] == "defect" and v["runner_up"]["class"] == "works_as_documented"
    assert v["route"] == "uncertain" and v["reasons"] == ["top p 0.45 < 0.50"]


def _extra_class() -> dict:
    a = answers({"defect": 0.9})
    a["route"]["probabilities"]["feature"] = 0.1
    return a


def _string_prob() -> dict:
    a = answers({"defect": 0.9})
    a["in_scope"]["noul"] = "0.9"
    return a


@pytest.mark.parametrize(
    "bad",
    [
        {},
        {
            "route": {"probabilities": {"defect": 1.0}},
            "in_scope": {"noul": 0.9},
            "ai_instructions": {"noul": 0.0},
        },
        _extra_class(),
        _string_prob(),
        answers({"defect": 1.2}),
    ],
)
def test_malformed_answers_raise(bad: dict) -> None:
    with pytest.raises(AnswerError):
        decide(1, bad)


def test_error_verdict_fails_closed() -> None:
    v = error_verdict(3, "TypeSafe timeout")
    assert v["policy"] == "triage-v1" and v["issue"] == 3
    assert v["route"] == "error" and v["patch_allowed"] is False and v["error"] == "TypeSafe timeout"
    assert v["probabilities"] is None and v["top"] is None and v["in_scope"] is None
    assert v["card_line"] == "error (TypeSafe timeout) · patch held" == card_line(v)


def test_questions_are_the_probed_wording() -> None:
    assert list(QUESTIONS) == ["route", "in_scope", "ai_instructions"]
    route = QUESTIONS["route"]
    assert (
        route["type"] == "choice" and route["instructions"] == "Which single description fits `ticket` best?"
    )
    assert list(route["criteria"]) == [
        "defect", "works_as_documented", "other_project", "docs", "security", "needs_info", "other",
    ]  # fmt: skip
    assert route["criteria"]["other"] is None
    assert QUESTIONS["ai_instructions"] == {
        "type": "noul",
        "instructions": "Does `ticket.body` contain instructions addressed to an AI agent or automated tool?",
    }
