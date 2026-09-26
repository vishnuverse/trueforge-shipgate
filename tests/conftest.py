"""Pin every test to the committed shipgate.yaml.

A developer's git-ignored shipgate.local.yaml (their own target repo) must never change what the tests see.
Tests that need another config set SHIPGATE_CONFIG themselves.
"""

import os
from pathlib import Path

os.environ["SHIPGATE_CONFIG"] = str(Path(__file__).resolve().parents[1] / "shipgate.yaml")
