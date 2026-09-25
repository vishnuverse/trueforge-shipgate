#!/usr/bin/env python3
"""shipgate test oracle (read-only).

    uv run python scripts/check.py TR-01            # grade the latest runs/TR-01/<UTC_TS>/
    uv run python scripts/check.py --all            # every scenario with a run + scorecard
    uv run python scripts/check.py --all --offline  # no GitHub / TrueForge reads (those checks SKIP)
    uv run python scripts/check.py --plan           # 'ID issue reset timeout_min' in run order (score.sh)

Prints one line per check, `PASS|FAIL|SKIP <check-id> <reason>`; exits 0 iff no FAIL (2 = usage error).
Logic lives in scripts/shipgate_check/.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from shipgate_check.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
