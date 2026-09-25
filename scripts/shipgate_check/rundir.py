"""Run directories `runs/<RUN_ID>/<UTC_TS>/` written by the orchestrator (docs/contracts.md §3)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

TS_RE = re.compile(r"^\d{8}T\d{6}Z$")


@dataclass
class RunDir:
    path: Path
    meta: dict[str, Any] = field(default_factory=dict)
    events: list[Any] = field(default_factory=list)
    handoff: Any = None
    handoff_present: bool = False  # handoff.json exists (it may hold `null`)
    final_message: str | None = None
    approvals: list[dict[str, Any]] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)  # unreadable / missing files

    @property
    def ts(self) -> str:
        return self.path.name

    @property
    def started_at(self) -> datetime | None:
        return parse_time(self.meta.get("started_at")) or parse_time(self.path.name)

    @property
    def finished_at(self) -> datetime | None:
        return parse_time(self.meta.get("finished_at"))

    @property
    def minutes(self) -> float | None:
        start, end = self.started_at, self.finished_at
        if start and end:
            return round((end - start).total_seconds() / 60, 1)
        return None


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    if TS_RE.match(value):
        return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def latest_run_path(runs_dir: Path, run_id: str) -> Path | None:
    base = Path(runs_dir) / run_id
    if not base.is_dir():
        return None
    stamps = sorted(p for p in base.iterdir() if p.is_dir() and TS_RE.match(p.name))
    return stamps[-1] if stamps else None


def _read_json(path: Path, problems: list[str], default: Any) -> tuple[Any, bool]:
    if not path.exists():
        problems.append(f"{path.name} missing")
        return default, False
    try:
        return json.loads(path.read_text(encoding="utf-8")), True
    except ValueError as exc:
        problems.append(f"{path.name} is not valid JSON ({exc})")
        return default, True


def load_run(path: Path) -> RunDir:
    path = Path(path)
    run = RunDir(path=path)
    meta, _ = _read_json(path / "meta.json", run.problems, {})
    run.meta = meta if isinstance(meta, dict) else {}
    events, _ = _read_json(path / "events.json", run.problems, [])
    if isinstance(events, dict) and isinstance(events.get("data"), list):
        events = events["data"]
    if not isinstance(events, list):
        run.problems.append("events.json is not a list")
        events = []
    run.events = events
    run.handoff, run.handoff_present = _read_json(path / "handoff.json", run.problems, None)
    fm = path / "final_message.md"
    if fm.exists():
        run.final_message = fm.read_text(encoding="utf-8")
    else:
        run.problems.append("final_message.md missing")
    ap = path / "approvals.jsonl"
    if ap.exists():
        for n, line in enumerate(ap.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                run.problems.append(f"approvals.jsonl line {n} is not JSON")
                continue
            if isinstance(rec, dict):
                run.approvals.append(rec)
    else:
        run.problems.append("approvals.jsonl missing")
    return run
