"""Canonical JSON + args hash (docs/contracts.md §3).

The orchestrator's TypeScript must match byte for byte."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json(obj: Any) -> str:
    """Keys sorted recursively, separators `,` and `:` without spaces, non-ASCII kept as UTF-8."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def args_sha256(obj: Any) -> str:
    """SHA-256 hex of the canonical form of an MCP tool input object."""
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()
