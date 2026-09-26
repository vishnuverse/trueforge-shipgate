# Any-repo configuration and one-command setup: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point Ticket Resolver at any Python + pytest GitHub repo by editing `shipgate.yaml`, and bring the whole
system up with `scripts/setup.sh` after filling `.env`.

**Architecture:**
- **Config:** one file, `shipgate.yaml`, read by two small loaders with identical rules: Python
  `scripts/shipgate_config.py` and TS `orchestrator/src/config.ts`.
- **Readers:** the scorer, orchestrator, triage server and `reset.sh` read the target repo from config instead of
  constants.
- **Rendering:** the skill and agent spec become templates with `{{placeholders}}`, filled at registration by
  `orchestrator/src/render.ts`.
- **Setup:** `scripts/setup.sh` checks prerequisites, installs, starts services, and registers the provider,
  connectors and agent through TrueForge's API (`orchestrator/src/setup.ts`). It then checks branch protection and
  labels on the target repo and runs a doctor.

**Tech Stack:** Python 3.12 (pyyaml, httpx, pytest), TypeScript strict (`yaml`, `node:test`, tsx), bash 3.2,
TrueForge 0.2.1 REST (`/api/v1/settings/*`, snake_case bodies), GitHub REST.

**Spec:** `docs/superpowers/specs/2026-09-26-any-repo-setup-design.md`

**Branch:** `feat/any-repo`, cut from `main` after `feat/jev-triage` has landed. This plan assumes the triage code
(`mcp/triage/`, scorer S8–S10, skill step 3.0) is on `main`.

## Decisions made while planning (verified 2026-09-26; each refines the spec)

1. **`SHIPGATE_CONFIG=<path>` overrides the config location in both loaders.** Tests need a way to point at another
   config without editing the committed one. `SHIPGATE_ENV_FILE` and `SHIPGATE_PID_DIR` do the same for
   `setup.sh`/`stop.sh`, so their tests never touch the real `.env` or real pid files.
2. **TrueForge's REST bodies are snake_case**, checked against the live server: `base_url`, `model_id`,
   `auth.api_key`, and header auth `{"type": "header", "headers": {...}}`.
   - `PUT /api/v1/settings/model-providers` and `PUT /api/v1/settings/mcp-servers` both create-or-replace one entry
     by name.
   - A key rotation therefore sends the existing models back unchanged.
3. **Model properties are copied from the working provider:**
   - `deepseek-v4-flash`: context 1048576, max output 384000, efforts `high`/`xhigh`
   - `glm-5-3-flash`: 1310720, 128000, efforts `low`/`high`/`max`
4. **The triage smoke test is `uv run mcp/triage/server.py --smoke <issue>`.** It is a direct call to the same
   `triage()` function the tool uses, so it proves the key, the context and GitHub without needing a TrueForge
   session.
5. **Skill examples stay literal and are relabelled.** Every `Example (` line becomes
   `Example (demo repo vishnuverse/humanize, `. An *example region* is:
   - starting at that line, everything through the end of the first `~~~` fenced block that follows it, or
   - if a line starting with `</` comes first, everything up to that line.

   Example regions are never templated.
6. **`scripts/bakeoff.py` is untouched** (spec §10). It reads the raw template files and now sees `{{placeholders}}`,
   which is fine for a historical tool.

## Global Constraints

- **Code style:** Python 3.12, `ruff format` then `ruff check` (line length 110). TypeScript strict. Bash scripts
  must run on macOS bash 3.2. Commit only on the test runner's own exit status 0, never on piped output.
- **Commits:** conventional, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Pins:** TrueForge server `@truefoundry/trueforge@0.2.1`, SDK `0.2.0`, `mcp==1.30.0`. No new dependencies.
- **Config schema, from spec §2 verbatim:**
  - keys `target.{repo, default_branch, description}`, `python.{install, test, source_dir, tests_dir}`,
    `trueforge.{url, model}`; all required, unknown keys are an error
  - `repo` matches `^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`
  - dirs are relative, with no `..` and no leading `/`
  - `install` and `test` are non-empty and contain no backtick
  - `description` is 1–500 characters
  - `trueforge.url` is http(s)
  - errors read `<file>: <key>: <problem>`
- **Placeholders:** `{{repo}}`, `{{owner}}`, `{{name}}`, `{{default_branch}}`, `{{install}}`, `{{test}}`,
  `{{source_dir}}`, `{{tests_dir}}`, `{{model}}`. A missing value or any leftover `{{` fails registration.
- **Exit codes:** `setup.sh`, `check.py` and the orchestrator exit 0 = ok, 1 = a step failed, 2 = usage or config
  error.
- **Secrets:**
  - Keys come only from `.env` or the environment, and no key value is ever printed, logged, put in an error
    message, or passed on a command line: curl reads the Authorization header from stdin via `-H @-`.
  - Keys are sent only to a loopback TrueForge unless `--allow-remote` is given.
  - An existing provider or connector is left untouched unless `--rotate-keys` is given.
- **Safety:**
  - A single target, read from config, and every component refuses any other repo.
  - `reset.sh` exits 2 unless the config target is its demo repo.
  - `setup.sh` refuses an unprotected default branch unless `--allow-unprotected` is given.
- **Demo invariant:** with the committed `shipgate.yaml`, every existing test passes, and the rendered skill and
  agent equal the golden humanize fixtures.

## Review Focus

1. **`.env` written with `export KEY=…` or quoted values** must pass the presence check and be read correctly (test
   in Task 8).
2. **A target whose default branch isn't `main`** must render the branch name everywhere outside example regions,
   leaving no stray `main` (test in Task 5).
3. **Directories written with a trailing slash** (`src/widgets/`) are normalised, so the skill never shows
   `src/widgets//x.py` (test in Task 1).
4. **Rotating a key keeps extra models** the user added to the `openrouter` provider, such as `gpt-5-nano` (test in
   Task 7).
5. **Repo names with dots or underscores** (`acme/my.pkg_x`) load in both loaders and render correctly (test in
   Task 1).

---

### Task 1: `shipgate.yaml` and the two loaders

**Files:**
- Create: `shipgate.yaml`, `scripts/shipgate_config.py`, `orchestrator/src/config.ts`
- Create: `tests/fixtures/config/*.yaml`, `tests/fixtures/config/expected.json`
- Create: `tests/check/test_config.py`, `orchestrator/test/config.test.ts`

**Interfaces:**
- Produces (Python `shipgate_config`):
  - `ROOT: Path`, `class ConfigError(ValueError)`
  - `@dataclass(frozen=True) Config(repo, default_branch, description, install, test, source_dir, tests_dir,
    trueforge_url, model)` with properties `owner` and `name`
  - `config_path() -> Path`, `load_config(path=None) -> Config`
  - CLI `python scripts/shipgate_config.py <key>`, where key is one of `target.repo`, `target.owner`,
    `target.name`, `target.default_branch`, `trueforge.url`, `trueforge.model`
- Produces (TS `orchestrator/src/config.ts`):
  - `ROOT`, `class ConfigError extends Error`
  - `interface Config {repo, owner, name, defaultBranch, description, install, test, sourceDir, testsDir,
    trueforgeUrl, model}`
  - `configPath()`, `loadConfig(path?) -> Config`

- [ ] **Step 1: Write the committed config**

Create `shipgate.yaml`:

```yaml
# Ticket Resolver target (docs/superpowers/specs/2026-09-26-any-repo-setup-design.md §2). Edit for your repo;
# no secrets here (keys live in .env). Demo values: the planted-bug fork of humanize.
target:
  repo: vishnuverse/humanize          # owner/name; the only repo any component may touch
  default_branch: main
  description: >-
    humanize is a Python library (vishnuverse/humanize) with functions such as ordinal, intcomma, intword,
    naturalsize, naturaltime, naturalday and naturaldate. It is not Django's django.contrib.humanize.
python:
  install: '.venv/bin/pip install -q --disable-pip-version-check -e ".[tests]"'   # runs after python3 -m venv .venv
  test: ".venv/bin/python -m pytest -q -p no:cacheprovider --benchmark-disable --color=no"
  source_dir: src/humanize            # fixes may change only files under this directory
  tests_dir: tests                    # the regression test is <tests_dir>/test_issue_<n>.py
trueforge:
  url: http://localhost:8790
  model: openrouter/deepseek-v4-flash
```

- [ ] **Step 2: Generate the shared fixtures**

Run this once from the repo root:

```bash
uv run python - <<'EOF'
import copy, json
from pathlib import Path
import yaml
base = yaml.safe_load(Path("shipgate.yaml").read_text())
d = Path("tests/fixtures/config"); d.mkdir(parents=True, exist_ok=True)
def write(name, data=None, raw=None):
    (d / name).write_text(raw if raw is not None else yaml.safe_dump(data, sort_keys=False, width=200))
def mutate(fn):
    c = copy.deepcopy(base); fn(c); return c
expected = {}
write("valid.yaml", base); expected["valid.yaml"] = None
write("valid-dotted-repo.yaml", mutate(lambda c: c["target"].update(repo="acme/my.pkg_x"))); expected["valid-dotted-repo.yaml"] = None
write("valid-trailing-slash.yaml", mutate(lambda c: c["python"].update(source_dir="src/humanize/", tests_dir="tests/"))); expected["valid-trailing-slash.yaml"] = None
cases = {
    "unknown-top-key.yaml": ("targt", lambda c: c.update(targt={})),
    "missing-section.yaml": ("python", lambda c: c.pop("python")),
    "unknown-nested-key.yaml": ("python.extra", lambda c: c["python"].update(extra="x")),
    "missing-description.yaml": ("target.description", lambda c: c["target"].pop("description")),
    "long-description.yaml": ("target.description", lambda c: c["target"].update(description="x" * 501)),
    "bad-repo.yaml": ("target.repo", lambda c: c["target"].update(repo="not a repo")),
    "empty-install.yaml": ("python.install", lambda c: c["python"].update(install="  ")),
    "backtick-test.yaml": ("python.test", lambda c: c["python"].update(test="pytest `x`")),
    "absolute-source-dir.yaml": ("python.source_dir", lambda c: c["python"].update(source_dir="/etc")),
    "dotdot-tests-dir.yaml": ("python.tests_dir", lambda c: c["python"].update(tests_dir="tests/../..")),
    "bad-url.yaml": ("trueforge.url", lambda c: c["trueforge"].update(url="localhost:8790")),
    "non-string-branch.yaml": ("target.default_branch", lambda c: c["target"].update(default_branch=5)),
}
for name, (key, fn) in cases.items():
    write(name, mutate(fn)); expected[name] = key
write("not-a-mapping.yaml", raw="- a\n- b\n"); expected["not-a-mapping.yaml"] = "(root)"
write("invalid-yaml.yaml", raw="target: [unclosed\n"); expected["invalid-yaml.yaml"] = "(file)"
(d / "expected.json").write_text(json.dumps(expected, indent=1, sort_keys=True) + "\n")
print(len(expected), "fixtures")
EOF
```

Expected: `18 fixtures`.

- [ ] **Step 3: Write the failing Python tests**

Create `tests/check/test_config.py`:

```python
"""shipgate.yaml loader (spec any-repo §2). The same fixtures run in orchestrator/test/config.test.ts."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from shipgate_config import ROOT, ConfigError, load_config

FIXTURES = ROOT / "tests" / "fixtures" / "config"
EXPECTED: dict[str, str | None] = json.loads((FIXTURES / "expected.json").read_text())


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_fixture(name: str) -> None:
    want = EXPECTED[name]
    if want is None:
        cfg = load_config(FIXTURES / name)
        assert cfg.owner and cfg.name and cfg.repo == f"{cfg.owner}/{cfg.name}"
        assert cfg.source_dir == "src/humanize" and cfg.tests_dir == "tests"  # trailing '/' normalised
    else:
        with pytest.raises(ConfigError) as exc:
            load_config(FIXTURES / name)
        assert f"{name}: {want}: " in str(exc.value)


def test_dotted_repo_splits_owner_and_name() -> None:
    cfg = load_config(FIXTURES / "valid-dotted-repo.yaml")
    assert (cfg.owner, cfg.name) == ("acme", "my.pkg_x")


def test_committed_config_is_the_demo() -> None:
    cfg = load_config(ROOT / "shipgate.yaml")
    assert cfg.repo == "vishnuverse/humanize" and cfg.default_branch == "main"
    assert cfg.test == ".venv/bin/python -m pytest -q -p no:cacheprovider --benchmark-disable --color=no"
    assert cfg.install == '.venv/bin/pip install -q --disable-pip-version-check -e ".[tests]"'
    assert cfg.description.startswith("humanize is a Python library") and "\n" not in cfg.description


def test_env_var_points_at_another_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SHIPGATE_CONFIG", str(FIXTURES / "valid-dotted-repo.yaml"))
    assert load_config().repo == "acme/my.pkg_x"


def test_cli_prints_one_value_and_exits_2_on_a_config_error() -> None:
    cmd = [sys.executable, str(ROOT / "scripts" / "shipgate_config.py"), "target.repo"]
    env = {k: v for k, v in os.environ.items() if k != "SHIPGATE_CONFIG"}
    ok = subprocess.run(cmd, capture_output=True, text=True, env=env)
    assert ok.returncode == 0 and ok.stdout == "vishnuverse/humanize\n"
    bad = subprocess.run(
        cmd, capture_output=True, text=True, env={**env, "SHIPGATE_CONFIG": str(FIXTURES / "bad-repo.yaml")}
    )
    assert bad.returncode == 2 and "target.repo" in bad.stderr
    usage = subprocess.run(cmd[:2] + ["nope"], capture_output=True, text=True, env=env)
    assert usage.returncode == 2
```

- [ ] **Step 4: Run them to verify they fail**

Run: `uv run pytest tests/check/test_config.py -q`
Expected: FAIL (collection) with `ModuleNotFoundError: No module named 'shipgate_config'`.

- [ ] **Step 5: Write the Python loader**

Create `scripts/shipgate_config.py`:

```python
"""shipgate.yaml: the one target repo and its commands (docs/superpowers/specs/2026-09-26-any-repo-setup-design.md §2).

Read by the scorer, the triage MCP and reset.sh; orchestrator/src/config.ts applies the same rules, and both run the
fixtures in tests/fixtures/config/. SHIPGATE_CONFIG=<path> points both at another file.
Shell use:  uv run python scripts/shipgate_config.py target.repo   (prints one value; exit 2 on a config error)
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPO_RE = re.compile(r"^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$")
URL_RE = re.compile(r"^https?://[^\s/]+")
MAX_DESCRIPTION = 500
SCHEMA: dict[str, tuple[str, ...]] = {
    "target": ("repo", "default_branch", "description"),
    "python": ("install", "test", "source_dir", "tests_dir"),
    "trueforge": ("url", "model"),
}


class ConfigError(ValueError):
    """shipgate.yaml is missing or invalid; the message names the file and the key."""


@dataclass(frozen=True)
class Config:
    repo: str
    default_branch: str
    description: str
    install: str
    test: str
    source_dir: str
    tests_dir: str
    trueforge_url: str
    model: str

    @property
    def owner(self) -> str:
        return self.repo.split("/", 1)[0]

    @property
    def name(self) -> str:
        return self.repo.split("/", 1)[1]


def config_path() -> Path:
    return Path(os.environ.get("SHIPGATE_CONFIG") or ROOT / "shipgate.yaml")


def _relative(value: str) -> bool:
    return not value.startswith("/") and ".." not in value.split("/") and not re.match(r"^[A-Za-z]:", value)


def load_config(path: Path | str | None = None) -> Config:
    p = Path(path) if path is not None else config_path()

    def err(key: str, problem: str) -> ConfigError:
        return ConfigError(f"{p.name}: {key}: {problem}")

    try:
        data = yaml.safe_load(p.read_text(encoding="utf-8"))
    except OSError as exc:
        raise err("(file)", f"cannot read {p} ({exc.strerror})") from exc
    except yaml.YAMLError as exc:
        raise err("(file)", "invalid YAML") from exc
    if not isinstance(data, dict):
        raise err("(root)", "must be a mapping")
    for key in data:
        if key not in SCHEMA:
            raise err(str(key), "unknown key")
    v: dict[str, str] = {}
    for section, keys in SCHEMA.items():
        block = data.get(section)
        if not isinstance(block, dict):
            raise err(section, "missing or not a mapping")
        for key in block:
            if key not in keys:
                raise err(f"{section}.{key}", "unknown key")
        for key in keys:
            value = block.get(key)
            if not isinstance(value, str) or not value.strip():
                raise err(f"{section}.{key}", "missing or empty")
            v[f"{section}.{key}"] = value.strip()
    if not REPO_RE.match(v["target.repo"]):
        raise err("target.repo", "must be owner/name")
    if len(v["target.description"]) > MAX_DESCRIPTION:
        raise err("target.description", f"longer than {MAX_DESCRIPTION} characters")
    for key in ("python.install", "python.test"):
        if "`" in v[key]:
            raise err(key, "must not contain a backtick")
    for key in ("python.source_dir", "python.tests_dir"):
        if not _relative(v[key]):
            raise err(key, "must be a relative path without '..'")
        v[key] = v[key].rstrip("/")
    if not URL_RE.match(v["trueforge.url"]):
        raise err("trueforge.url", "must be an http(s) URL")
    return Config(
        repo=v["target.repo"],
        default_branch=v["target.default_branch"],
        description=v["target.description"],
        install=v["python.install"],
        test=v["python.test"],
        source_dir=v["python.source_dir"],
        tests_dir=v["python.tests_dir"],
        trueforge_url=v["trueforge.url"],
        model=v["trueforge.model"],
    )


GETTERS: dict[str, Callable[[Config], str]] = {
    "target.repo": lambda c: c.repo,
    "target.owner": lambda c: c.owner,
    "target.name": lambda c: c.name,
    "target.default_branch": lambda c: c.default_branch,
    "trueforge.url": lambda c: c.trueforge_url,
    "trueforge.model": lambda c: c.model,
}


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] not in GETTERS:
        print(f"usage: shipgate_config.py <{'|'.join(GETTERS)}>", file=sys.stderr)
        return 2
    try:
        cfg = load_config()
    except ConfigError as exc:
        print(f"shipgate_config: {exc}", file=sys.stderr)
        return 2
    print(GETTERS[argv[0]](cfg))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 6: Run the Python tests**

Run: `uv run pytest tests/check/test_config.py -q`
Expected: PASS, `22 passed` (18 fixtures + 4).

- [ ] **Step 7: Write the failing TS tests, then the TS loader**

Create `orchestrator/test/config.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, ROOT, loadConfig } from "../src/config.ts";

const FIXTURES = join(ROOT, "tests", "fixtures", "config");
const EXPECTED = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8")) as Record<string, string | null>;

for (const [name, want] of Object.entries(EXPECTED)) {
  test(`config fixture ${name} (parity with scripts/shipgate_config.py)`, () => {
    if (want === null) {
      const c = loadConfig(join(FIXTURES, name));
      assert.equal(c.repo, `${c.owner}/${c.name}`);
      assert.equal(c.sourceDir, "src/humanize");
      assert.equal(c.testsDir, "tests");
    } else {
      assert.throws(
        () => loadConfig(join(FIXTURES, name)),
        (e: unknown) => e instanceof ConfigError && e.message.includes(`${name}: ${want}: `),
      );
    }
  });
}

test("committed shipgate.yaml is the demo", () => {
  const c = loadConfig(join(ROOT, "shipgate.yaml"));
  assert.equal(c.repo, "vishnuverse/humanize");
  assert.equal(c.defaultBranch, "main");
  assert.equal(c.model, "openrouter/deepseek-v4-flash");
  assert.ok(!c.description.includes("\n"));
});

test("dotted repo names split into owner and name", () => {
  const c = loadConfig(join(FIXTURES, "valid-dotted-repo.yaml"));
  assert.deepEqual([c.owner, c.name], ["acme", "my.pkg_x"]);
});

test("SHIPGATE_CONFIG points at another file", () => {
  const before = process.env.SHIPGATE_CONFIG;
  process.env.SHIPGATE_CONFIG = join(FIXTURES, "valid-dotted-repo.yaml");
  try {
    assert.equal(loadConfig().repo, "acme/my.pkg_x");
  } finally {
    if (before === undefined) delete process.env.SHIPGATE_CONFIG;
    else process.env.SHIPGATE_CONFIG = before;
  }
});
```

Run: `npm --prefix orchestrator test 2>&1 | tail -5`
Expected: FAIL: cannot find module `../src/config.ts`.

Create `orchestrator/src/config.ts`:

```ts
// shipgate.yaml loader (spec docs/superpowers/specs/2026-09-26-any-repo-setup-design.md §2). Same rules as
// scripts/shipgate_config.py; both run tests/fixtures/config/. SHIPGATE_CONFIG=<path> overrides the location.
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const URL_RE = /^https?:\/\/[^\s/]+/;
const MAX_DESCRIPTION = 500;
const SCHEMA: Record<string, readonly string[]> = {
  target: ["repo", "default_branch", "description"],
  python: ["install", "test", "source_dir", "tests_dir"],
  trueforge: ["url", "model"],
};

export class ConfigError extends Error {}

export interface Config {
  repo: string;
  owner: string;
  name: string;
  defaultBranch: string;
  description: string;
  install: string;
  test: string;
  sourceDir: string;
  testsDir: string;
  trueforgeUrl: string;
  model: string;
}

export function configPath(): string {
  return process.env.SHIPGATE_CONFIG || resolve(ROOT, "shipgate.yaml");
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function relative(v: string): boolean {
  return !v.startsWith("/") && !v.split("/").includes("..") && !/^[A-Za-z]:/.test(v);
}

export function loadConfig(path: string = configPath()): Config {
  const file = basename(path);
  const err = (key: string, problem: string) => new ConfigError(`${file}: ${key}: ${problem}`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw err("(file)", `cannot read ${path} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch {
    throw err("(file)", "invalid YAML");
  }
  if (!isMapping(data)) throw err("(root)", "must be a mapping");
  for (const key of Object.keys(data)) if (!(key in SCHEMA)) throw err(key, "unknown key");
  const v: Record<string, string> = {};
  for (const [section, keys] of Object.entries(SCHEMA)) {
    const block = data[section];
    if (!isMapping(block)) throw err(section, "missing or not a mapping");
    for (const key of Object.keys(block)) if (!keys.includes(key)) throw err(`${section}.${key}`, "unknown key");
    for (const key of keys) {
      const value = block[key];
      if (typeof value !== "string" || value.trim() === "") throw err(`${section}.${key}`, "missing or empty");
      v[`${section}.${key}`] = value.trim();
    }
  }
  const get = (k: string): string => v[k] ?? "";
  if (!REPO_RE.test(get("target.repo"))) throw err("target.repo", "must be owner/name");
  if (get("target.description").length > MAX_DESCRIPTION) {
    throw err("target.description", `longer than ${MAX_DESCRIPTION} characters`);
  }
  for (const key of ["python.install", "python.test"]) {
    if (get(key).includes("`")) throw err(key, "must not contain a backtick");
  }
  for (const key of ["python.source_dir", "python.tests_dir"]) {
    if (!relative(get(key))) throw err(key, "must be a relative path without '..'");
    v[key] = get(key).replace(/\/+$/, "");
  }
  if (!URL_RE.test(get("trueforge.url"))) throw err("trueforge.url", "must be an http(s) URL");
  const repo = get("target.repo");
  const [owner, name] = repo.split("/", 2) as [string, string];
  return {
    repo,
    owner,
    name,
    defaultBranch: get("target.default_branch"),
    description: get("target.description"),
    install: get("python.install"),
    test: get("python.test"),
    sourceDir: get("python.source_dir"),
    testsDir: get("python.tests_dir"),
    trueforgeUrl: get("trueforge.url"),
    model: get("trueforge.model"),
  };
}
```

Run: `npm --prefix orchestrator test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`, with passes = 72 + 21 = 93.

- [ ] **Step 8: Whole suites, lint, commit**

Run: `uv run pytest -q; echo "exit $?"` → Expected: `exit 0`.
Run: `uv run ruff format scripts tests && uv run ruff check scripts tests` → Expected: `All checks passed!`

```bash
git add shipgate.yaml scripts/shipgate_config.py orchestrator/src/config.ts tests/fixtures/config tests/check/test_config.py orchestrator/test/config.test.ts
git commit -m "feat(config): shipgate.yaml with matching Python and TypeScript loaders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The scorer and scenarios read the target from config

**Files:**
- Modify: `scripts/shipgate_check/constants.py:1-7`, `scripts/shipgate_check/scenario.py`
- Modify: `tests/scenarios/TR-*.yaml` (13 files)
- Modify: `tests/check/test_check.py`

**Interfaces:**
- Consumes: `shipgate_config.load_config`, `ConfigError` (Task 1).
- Produces:
  - `constants.OWNER` and `constants.REPO` (both lowercased) and `FULL_REPO`, now from config
  - `Scenario.repo: str`
  - the required scenario key `repo`, which must equal the config target (case-insensitive), else `ScenarioError`

- [ ] **Step 1: Write the failing tests**

Append to `tests/check/test_check.py`:

```python
def _scenario_yaml(sid: str, repo: str) -> str:
    return (
        f"id: {sid}\ntitle: t\nissue: 1\nrepo: {repo}\nreset: true\ntimeout_min: 15\nmust_pass: false\n"
        "approvals: []\nexpect: {}\n"
    )


def test_every_scenario_names_the_demo_repo() -> None:
    assert {s.repo for s in load_all(SCENARIOS)} == {"vishnuverse/humanize"}


def test_scenario_for_another_repo_is_refused(tmp_path: Path) -> None:
    from shipgate_check.scenario import ScenarioError, load_scenario

    p = tmp_path / "TR-98.yaml"
    p.write_text(_scenario_yaml("TR-98", "acme/widgets"))
    with pytest.raises(ScenarioError, match="configured target"):
        load_scenario(p)


def test_check_exits_2_for_a_scenario_of_another_repo(tmp_path: Path) -> None:
    import io

    from shipgate_check.cli import main

    (tmp_path / "TR-98.yaml").write_text(_scenario_yaml("TR-98", "acme/widgets"))
    argv = ["TR-98", "--scenarios-dir", str(tmp_path), "--runs-dir", str(tmp_path / "runs"), "--offline"]
    assert main(argv, out=io.StringIO(), root=tmp_path) == 2
```

In `test_unknown_triage_key_is_rejected`, change the YAML string's first line to
`"id: TR-99\ntitle: t\nissue: 1\nrepo: vishnuverse/humanize\nreset: true\ntimeout_min: 15\nmust_pass: false\napprovals: []\n"`,
so that it still reaches the `expect.triage` error.

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/check -q -k "names_the_demo_repo or another_repo" 2>&1 | tail -5`
Expected: 3 failed (`Scenario` has no attribute `repo`; no `ScenarioError`).

- [ ] **Step 3: Read the target from config**

In `scripts/shipgate_check/constants.py`, replace the docstring through the `FULL_REPO` line with:

```python
"""Fixed facts the scorer grades against (docs/SPEC.md §4, docs/contracts.md). The target repo comes from
shipgate.yaml (scripts/shipgate_config.py); the scenarios and fixtures are demo-only."""

from __future__ import annotations

import sys

from shipgate_config import ConfigError, load_config

try:
    _CONFIG = load_config()
except ConfigError as exc:
    print(f"check.py: {exc}", file=sys.stderr)
    raise SystemExit(2) from None

OWNER = _CONFIG.owner.lower()
REPO = _CONFIG.name.lower()
FULL_REPO = _CONFIG.repo
```

In `scripts/shipgate_check/scenario.py`:
- import `FULL_REPO` from `.constants`, alongside `DECISIONS` and `GATED_TOOLS`
- add `"repo"` to the required-keys tuple in `load_scenario`, right after `"issue"`
- after the `issue` validation, add:

```python
    repo = data["repo"]
    if not isinstance(repo, str) or repo.lower() != FULL_REPO.lower():
        raise _fail(
            path,
            f"repo {repo!r} is not the configured target {FULL_REPO!r} (shipgate.yaml); scenarios are demo-only",
        )
```

- add the field `repo: str = ""` to `@dataclass Scenario`, after `raw`, and pass `repo=repo` in the constructor call

- [ ] **Step 4: Name the repo in every scenario**

```bash
uv run python - <<'EOF'
import re
from pathlib import Path
for p in sorted(Path("tests/scenarios").glob("TR-*.yaml")):
    s = p.read_text()
    assert "\nrepo:" not in s, p
    s2, n = re.subn(r"(?m)^(issue: \d+)$", r"\1\nrepo: vishnuverse/humanize", s, count=1)
    assert n == 1, p
    p.write_text(s2)
print("ok")
EOF
```

Also change the `GitHubClient` docstring in `scripts/shipgate_check/clients.py` from "pinned to vishnuverse/humanize"
to "pinned to the shipgate.yaml target".

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest -q; echo "exit $?"`
Expected: `exit 0`; the three new tests pass, and every earlier test is unchanged.
Run: `grep -rln "vishnuverse/humanize" scripts --include=*.py | grep -v bakeoff || echo clean` → Expected: `clean`.

- [ ] **Step 6: Lint and commit**

Run: `uv run ruff format scripts tests && uv run ruff check scripts tests` → Expected: `All checks passed!`

```bash
git add scripts/shipgate_check/constants.py scripts/shipgate_check/scenario.py scripts/shipgate_check/clients.py tests/scenarios tests/check/test_check.py
git commit -m "feat(check): scorer target from shipgate.yaml; scenarios name their demo repo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The orchestrator reads the target from config

**Files:**
- Modify: `orchestrator/src/labels.ts`, `orchestrator/src/runner.ts`, `orchestrator/src/cli.ts`
- Modify: `orchestrator/test/runner.test.ts` (add `repo` to the options it builds), `orchestrator/test/cli.test.ts`,
  `orchestrator/test/labels.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `ConfigError` (Task 1).
- Produces:
  - `labels.ts`: `targetRepo(): string`; the `TARGET_REPO` constant is removed
  - `RunOptions.repo: string`
  - `defaultPrompt(issue, mode, today = localDate(), repo = targetRepo())`
  - the CLI exits 2 on a `ConfigError`

- [ ] **Step 1: Write the failing tests**

In `orchestrator/test/cli.test.ts`, add:

```ts
test("the kickoff prompt names the configured repo", () => {
  assert.equal(
    defaultPrompt(7, "script", "2026-09-26", "acme/widgets"),
    "Resolve GitHub issue #7 in acme/widgets. Approval mode: script. Today is 2026-09-26.",
  );
});
```

In `orchestrator/test/labels.test.ts`, change the import to also bring in `targetRepo`, add
`import { fileURLToPath } from "node:url";`, and add:

```ts
test("labels are pinned to the configured repo", () => {
  assert.equal(targetRepo(), "vishnuverse/humanize");
  const before = process.env.SHIPGATE_CONFIG;
  process.env.SHIPGATE_CONFIG = fileURLToPath(new URL("../../tests/fixtures/config/valid-dotted-repo.yaml", import.meta.url));
  try {
    assert.equal(targetRepo(), "acme/my.pkg_x");
    assert.throws(() => new GitHubLabels("vishnuverse/humanize", "tkn"), /refusing/);
    assert.doesNotThrow(() => new GitHubLabels("acme/my.pkg_x", "tkn"));
  } finally {
    if (before === undefined) delete process.env.SHIPGATE_CONFIG;
    else process.env.SHIPGATE_CONFIG = before;
  }
});
```

Run: `npm --prefix orchestrator test 2>&1 | grep -E "^ℹ fail|error TS" | head -5`
Expected: failures, including a type error: `defaultPrompt` takes 3 arguments, and `targetRepo` is not exported.

- [ ] **Step 2: Implement**

`orchestrator/src/labels.ts`:
- replace `export const TARGET_REPO = "vishnuverse/humanize";` with:

```ts
import { loadConfig } from "./config.ts";

/** The one repo whose labels may change: shipgate.yaml target.repo. */
export function targetRepo(): string {
  return loadConfig().repo;
}
```

- change the guard line to
  `if (repo.toLowerCase() !== targetRepo().toLowerCase()) throw new Error(\`refusing to change labels on ${repo}; only ${targetRepo()}\`);`
- change the header comment's "Only vishnuverse/humanize" to "Only the shipgate.yaml target"

`orchestrator/src/runner.ts`:
- delete `export const REPO = "vishnuverse/humanize";`
- add `repo: string;` to `interface RunOptions`, after `trueforgeUrl`
- replace both `repo: REPO,` with `repo: opts.repo,`

`orchestrator/src/cli.ts`:
- change the import to `import { GitHubLabels, targetRepo } from "./labels.ts";` and add
  `import { ConfigError } from "./config.ts";`
- change `defaultPrompt`'s signature to
  `export function defaultPrompt(issue: number, mode: Mode, today: string = localDate(), repo: string = targetRepo()): string`
  and use `${repo}` in place of `${TARGET_REPO}`
- in `main`, add `const repo = targetRepo();` right after `const args = parseCli(argv);`
- replace the other two `TARGET_REPO` uses with `repo`
- add `repo,` to the `opts` object
- change `prompt: args.prompt ?? defaultPrompt(issue, args.mode),` to
  `prompt: args.prompt ?? defaultPrompt(issue, args.mode, localDate(), repo),`
- in the entry-point error handler, add this before the `UsageError` line:

```ts
      if (e instanceof ConfigError) {
        process.stderr.write(`shipgate: ${e.message}\n`);
        process.exit(2);
      }
```

`orchestrator/test/runner.test.ts`: add `repo: "vishnuverse/humanize",` next to `trueforgeUrl: "http://localhost:8790",`
in its options object.

- [ ] **Step 3: Run the tests**

Run: `npm --prefix orchestrator test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `fail 0`, 95 tests.

Run: `grep -rn "vishnuverse" orchestrator/src || echo clean`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add orchestrator/src orchestrator/test
git commit -m "feat(orchestrator): target repo from shipgate.yaml; config errors exit 2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The triage server reads the target and context from config

**Files:**
- Modify: `mcp/triage/github.py`, `mcp/triage/jev.py`, `mcp/triage/policy.py`, `mcp/triage/server.py`
- Modify: `tests/mcp/test_triage_clients.py`, `tests/mcp/test_triage_server.py`, `tests/mcp/test_triage_live.py`

**Interfaces:**
- Consumes: `shipgate_config.Config`, `load_config` (Task 1).
- Produces:
  - `github.fetch_issue(n, *, repo: str, token, client)`
  - `jev.ask(title, body, *, context: str, api_key, client)`
  - `server.context_sha(text: str) -> str` (12 hex characters)
  - `server.triage(issue_number, *, client, env, audit_log, config: Config)`
  - `server.build_app(*, client=None, env=None, audit_log=AUDIT_LOG, config=None)`, with log level `WARNING`
  - verdict key `context_sha`, and `"context_sha"` added to `AUDIT_KEYS`
  - CLI `uv run mcp/triage/server.py --smoke <issue>`
  - `policy.CONTEXT` is removed

- [ ] **Step 1: Update the tests first**

In `tests/mcp/test_triage_clients.py`:
- every `github.fetch_issue(1, token=…, client=…)` call gains `repo="vishnuverse/humanize"`, and the 404 test uses
  `github.fetch_issue(99, repo="vishnuverse/humanize", …)`
- every `jev.ask("t", …)` call gains `context="ctx"`
- in `test_ask_sends_pinned_model_questions_and_truncated_body`, replace
  `assert sent["state"]["repository"] == policy.CONTEXT` with `assert sent["state"]["repository"] == "ctx"`
- add:

```python
def test_fetch_issue_uses_the_given_repo() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=ISSUE)

    github.fetch_issue(4, repo="acme/my.pkg_x", token=None, client=client(handler))
    assert str(seen[0].url) == "https://api.github.com/repos/acme/my.pkg_x/issues/4"
```

In `tests/mcp/test_triage_server.py`:
- add, after the `ENV` line:

```python
from shipgate_config import Config

CFG = Config(
    repo="vishnuverse/humanize", default_branch="main", description="humanize is a Python library.",
    install="x", test="y", source_dir="src/humanize", tests_dir="tests",
    trueforge_url="http://localhost:8790", model="m",
)  # fmt: skip
```

- add `config=CFG` to every `server.triage(...)` call (the `run` helper and the unwritable-audit test) and to every
  `server.build_app(...)` call
- change `test_happy_path_returns_verdict_and_one_clean_audit_line`'s key assertion to
  `assert set(entry) == {"ts", *server.AUDIT_KEYS, "latency_ms"}` (unchanged text; `AUDIT_KEYS` now includes
  `context_sha`)
- add:

```python
def test_verdict_and_audit_carry_the_context_sha(tmp_path: Path) -> None:
    v = run(World(), tmp_path)
    assert v["context_sha"] == server.context_sha(CFG.description) and len(v["context_sha"]) == 12
    entry = json.loads((tmp_path / "t.jsonl").read_text())
    assert entry["context_sha"] == v["context_sha"]
    assert run(World(jev_status=401), tmp_path)["context_sha"] == v["context_sha"]  # error verdicts too


def test_issue_and_context_come_from_the_config(tmp_path: Path) -> None:
    w = World()
    cfg = Config(**{**CFG.__dict__, "repo": "acme/widgets", "description": "widgets is a Python package."})
    server.triage(1, client=w.client(), env=ENV, audit_log=tmp_path / "t.jsonl", config=cfg)
    gh, ts = w.requests
    assert gh.url.path == "/repos/acme/widgets/issues/1"
    assert json.loads(ts.content)["state"]["repository"] == "widgets is a Python package."


def test_app_logs_at_warning_level() -> None:
    assert server.build_app(client=World().client(), env=ENV, config=CFG).settings.log_level == "WARNING"
```

In `tests/mcp/test_triage_live.py`:
- add `from shipgate_config import load_config`
- pass `config=load_config()` in `_triage`

Run: `uv run pytest tests/mcp -q 2>&1 | tail -3`
Expected: FAIL: unexpected keyword `repo` / `context` / `config`.

- [ ] **Step 2: Implement**

`mcp/triage/github.py`:
- delete the `OWNER, REPO = …` line
- change the signature to `def fetch_issue(n: int, *, repo: str, token: str | None, client: httpx.Client) -> dict[str, str]:`
- change the URL to `f"{API}/repos/{repo}/issues/{n}"`
- update the docstring to "Read one issue of the configured target repo … Read-only."

`mcp/triage/jev.py`:
- change the signature to
  `def ask(title: str, body: str, *, context: str, api_key: str | None, client: httpx.Client) -> tuple[dict[str, Any], str | None]:`
- in the payload, `"repository": context`

`mcp/triage/policy.py`:
- delete the `CONTEXT = (…)` block
- add one line to the module docstring: "The repository context comes from shipgate.yaml target.description
  (recorded as context_sha)."

`mcp/triage/server.py`:
- add `import hashlib` and `import sys` to the stdlib imports
- after the `ROOT = …` line, add:

```python
sys.path.insert(0, str(ROOT / "scripts"))  # shipgate_config lives in scripts/
from shipgate_config import Config, ConfigError, load_config  # noqa: E402
```

- add `"context_sha",` to `AUDIT_KEYS`, after `"policy",`
- add:

```python
def context_sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
```

- in `triage`:
  - add the keyword parameter `config: Config`
  - call `github.fetch_issue(issue_number, repo=config.repo, token=…, client=client)`
  - call `jev.ask(issue["title"], issue["body"], context=config.description, api_key=…, client=client)`
  - add `verdict["context_sha"] = context_sha(config.description)` right before `_audit(...)`
- in `build_app`:
  - add the keyword parameter `config: Config | None = None`
  - set `target = config if config is not None else load_config()`
  - pass `config=target` to `triage`
  - construct `FastMCP("triage", host=HOST, port=PORT, streamable_http_path="/mcp", log_level="WARNING")`
- replace the `if __name__ == "__main__":` block with:

```python
def smoke(issue: int) -> int:
    """setup.sh --smoke: one real triage call (GitHub + TypeSafe), printing the verdict without secrets."""
    try:
        cfg = load_config()
    except ConfigError as exc:
        print(f"triage: {exc}", file=sys.stderr)
        return 2
    with httpx.Client() as client:
        v = triage(issue, client=client, env=load_env(ROOT / ".env", os.environ), audit_log=AUDIT_LOG, config=cfg)
    print(f"triage #{issue} on {cfg.repo}: {v['route']} · {v['card_line']}")
    return 1 if v["route"] == "error" else 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--smoke" and sys.argv[2].isdigit():
        sys.exit(smoke(int(sys.argv[2])))
    build_app().run(transport="streamable-http")
```

- [ ] **Step 3: Run the tests**

Run: `uv run pytest -q; echo "exit $?"` → Expected: `exit 0`.
Run: `grep -rn "vishnuverse" mcp/ || echo clean` → Expected: `clean`.

- [ ] **Step 4: Lint and commit**

Run: `uv run ruff format mcp tests && uv run ruff check mcp tests` → Expected: `All checks passed!`

```bash
git add mcp/triage tests/mcp
git commit -m "feat(triage): target repo and Jev context from shipgate.yaml; context_sha; --smoke

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Skill and agent templates, rendered at registration

**Files:**
- Create: `orchestrator/src/render.ts`, `orchestrator/test/render.test.ts`
- Create: `tests/fixtures/skill/ticket-resolver.humanize.md`, `tests/fixtures/skill/ticket-resolver.humanize.json`,
  `tests/fixtures/skill/acme.yaml`
- Modify: `skills/ticket-resolver/SKILL.md`, `agents/ticket-resolver.json` (become templates)
- Modify: `scripts/setup_agents.ts`

**Interfaces:**
- Consumes: `Config` and `loadConfig` (Task 1).
- Produces (`render.ts`):
  - `class RenderError extends Error`
  - `templateValues(c: Config): Record<string, string>`
  - `renderText(text, values, where?)`, `renderDeep<T>(value: T, values, where?) -> T`
  - `exampleMask(lines: string[]): boolean[]`

- [ ] **Step 1: Freeze the golden humanize outputs**

These are the pre-template files, with only the intended wording changes applied.

```bash
uv run python - <<'EOF'
import json
from pathlib import Path
d = Path("tests/fixtures/skill"); d.mkdir(parents=True, exist_ok=True)
skill = Path("skills/ticket-resolver/SKILL.md").read_text()
pairs = [
    ("Never the upstream python-humanize, never another", "Never an upstream repo, never another"),
    ('(number.py has "⁰¹²³")', "(e.g. the demo repo's number.py has \"⁰¹²³\")"),
]
for old, new in pairs:
    assert skill.count(old) == 1, old; skill = skill.replace(old, new)
lines = [("Example (demo repo vishnuverse/humanize, " + l[len("Example ("):]) if l.startswith("Example (") else l
         for l in skill.split("\n")]
(d / "ticket-resolver.humanize.md").write_text("\n".join(lines))
agent = json.loads(Path("agents/ticket-resolver.json").read_text())
(d / "ticket-resolver.humanize.json").write_text(json.dumps(agent, indent=2, ensure_ascii=False) + "\n")
(d / "acme.yaml").write_text(
    "target:\n  repo: acme/widgets\n  default_branch: trunk\n  description: widgets is a Python package.\n"
    "python:\n  install: .venv/bin/pip install -q -e .[dev]\n  test: .venv/bin/python -m pytest -q\n"
    "  source_dir: src/widgets/\n  tests_dir: test\n"
    "trueforge:\n  url: http://localhost:8790\n  model: openrouter/glm-5-3-flash\n")
print("golden written")
EOF
```

- [ ] **Step 2: Write the failing tests**

Create `orchestrator/test/render.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, loadConfig } from "../src/config.ts";
import { RenderError, exampleMask, renderDeep, renderText, templateValues } from "../src/render.ts";

const SKILL = readFileSync(join(ROOT, "skills", "ticket-resolver", "SKILL.md"), "utf8");
const AGENT = JSON.parse(readFileSync(join(ROOT, "agents", "ticket-resolver.json"), "utf8")) as unknown;
const FIX = join(ROOT, "tests", "fixtures", "skill");
const humanize = templateValues(loadConfig(join(ROOT, "shipgate.yaml")));
const acme = templateValues(loadConfig(join(FIX, "acme.yaml")));

function outsideExamples(text: string): string {
  const lines = text.split("\n");
  const mask = exampleMask(lines);
  return lines.filter((_, i) => !mask[i]).join("\n");
}

test("renderText fills values and inserts them literally", () => {
  assert.equal(renderText("a {{repo}} b {{ name }}", { repo: "x/$&y", name: "n" }), "a x/$&y b n");
});

test("renderText refuses a missing value or a leftover '{{'", () => {
  assert.throws(() => renderText("{{nope}}", {}), RenderError);
  assert.throws(() => renderText("{{repo}} {{", { repo: "r" }), RenderError);
});

test("renderDeep walks JSON", () => {
  assert.deepEqual(renderDeep({ a: ["{{x}}", 1, { b: "{{x}}!" }] }, { x: "q" }), { a: ["q", 1, { b: "q!" }] });
});

test("the templates are templates", () => {
  assert.ok(SKILL.includes("{{repo}}") && SKILL.includes("{{tests_dir}}") && SKILL.includes("{{default_branch}}"));
  assert.ok(JSON.stringify(AGENT).includes("{{model}}"));
});

test("humanize config renders the golden skill and agent", () => {
  assert.equal(renderText(SKILL, humanize, "SKILL.md"), readFileSync(join(FIX, "ticket-resolver.humanize.md"), "utf8"));
  assert.deepEqual(
    renderDeep(AGENT, humanize, "agent"),
    JSON.parse(readFileSync(join(FIX, "ticket-resolver.humanize.json"), "utf8")),
  );
});

test("another repo leaves no demo names outside the labelled examples", () => {
  const skill = outsideExamples(renderText(SKILL, acme, "SKILL.md"));
  for (const bad of ["vishnuverse", "src/humanize", "python-humanize", "benchmark-disable"]) {
    assert.ok(!skill.includes(bad), bad);
  }
  assert.ok(!/\bmain\b/.test(skill), "default branch 'main' left in the skill");
  assert.ok(skill.includes("acme/widgets") && skill.includes("src/widgets/<file>") && skill.includes("test/test_issue_<n>.py"));
  assert.ok(skill.includes("fix/issue-<n> → trunk"));
  const agent = JSON.stringify(renderDeep(AGENT, acme, "agent"));
  assert.ok(!agent.includes("vishnuverse") && agent.includes("openrouter/glm-5-3-flash"));
});

test("exampleMask covers fenced and unfenced examples", () => {
  const lines = ["x", "Example (a):", "~~~", "in", "~~~", "y", "Example (b):", "text", "</reply>", "z"];
  assert.deepEqual(exampleMask(lines), [false, true, true, true, true, false, true, true, false, false]);
});
```

Run: `npm --prefix orchestrator test 2>&1 | grep -E "^ℹ fail|Cannot find"`
Expected: FAIL: cannot find `../src/render.ts`.

- [ ] **Step 3: Write `render.ts`**

Create `orchestrator/src/render.ts`:

```ts
// Fill {{placeholders}} in the skill and agent spec from shipgate.yaml (spec any-repo §3).
import type { Config } from "./config.ts";

export class RenderError extends Error {}

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function templateValues(c: Config): Record<string, string> {
  return {
    repo: c.repo,
    owner: c.owner,
    name: c.name,
    default_branch: c.defaultBranch,
    install: c.install,
    test: c.test,
    source_dir: c.sourceDir,
    tests_dir: c.testsDir,
    model: c.model,
  };
}

export function renderText(text: string, values: Record<string, string>, where = "template"): string {
  const out = text.replace(PLACEHOLDER, (_m, key: string) => {
    const v = values[key];
    if (v === undefined) throw new RenderError(`${where}: no value for {{${key}}}`);
    return v;
  });
  if (out.includes("{{")) throw new RenderError(`${where}: '{{' left after rendering`);
  return out;
}

export function renderDeep<T>(value: T, values: Record<string, string>, where = "template"): T {
  if (typeof value === "string") return renderText(value, values, where) as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, values, where)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, values, where)])) as T;
  }
  return value;
}

/** Lines of worked examples from the demo repo, which stay literal: an `Example (` line through the end of the next
 *  ~~~ fenced block, or up to a closing `</tag>` line when no fence comes first. */
export function exampleMask(lines: string[]): boolean[] {
  const mask = lines.map(() => false);
  let i = 0;
  while (i < lines.length) {
    if (!(lines[i] ?? "").startsWith("Example (")) {
      i++;
      continue;
    }
    let j = i;
    let fenceOpen = false;
    for (; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (line.startsWith("~~~")) {
        mask[j] = true;
        if (fenceOpen) break;
        fenceOpen = true;
        continue;
      }
      if (line.startsWith("</") && !fenceOpen) {
        j--;
        break;
      }
      mask[j] = true;
    }
    i = j + 1;
  }
  return mask;
}
```

- [ ] **Step 4: Turn the skill and agent spec into templates**

```bash
uv run python - <<'EOF'
import json, re
from pathlib import Path

def mask(lines):
    m = [False] * len(lines); i = 0
    while i < len(lines):
        if not lines[i].startswith("Example ("):
            i += 1; continue
        j, fence = i, False
        while j < len(lines):
            l = lines[j]
            if l.startswith("~~~"):
                m[j] = True
                if fence: break
                fence = True
            elif l.startswith("</") and not fence:
                j -= 1; break
            else:
                m[j] = True
            j += 1
        i = j + 1
    return m

PAIRS = [  # most specific first
    ('https://github.com/vishnuverse/humanize humanize && cd humanize', 'https://github.com/{{repo}} {{name}} && cd {{name}}'),
    ("REPO = WORK/humanize", "REPO = WORK/{{name}}"),
    ('owner "vishnuverse" and repo "humanize". Never the upstream python-humanize, never another',
     'owner "{{owner}}" and repo "{{name}}". Never an upstream repo, never another'),
    ('owner "vishnuverse", repo "humanize"', 'owner "{{owner}}", repo "{{name}}"'),
    ('"vishnuverse:fix/issue-<n>"', '"{{owner}}:fix/issue-<n>"'),
    ('.venv/bin/pip install -q --disable-pip-version-check -e ".[tests]"', "{{install}}"),
    (".venv/bin/python -m pytest -q -p no:cacheprovider --benchmark-disable --color=no", "{{test}}"),
    ("vishnuverse/humanize", "{{repo}}"),
    ("src/humanize", "{{source_dir}}"),
    ("tests/test_", "{{tests_dir}}/test_"),
    ("` M tests/...`", "` M {{tests_dir}}/...`"),
    ("git checkout -- tests/", "git checkout -- {{tests_dir}}/"),
    ('path "tests")', 'path "{{tests_dir}}")'),
    ("Bug not in humanize code", "Bug not in {{name}} code"),
    ("not in humanize. Can you reproduce it with humanize alone?", "not in {{name}}. Can you reproduce it with {{name}} alone?"),
    ("a humanize defect", "a {{name}} defect"),
    ('(number.py has "⁰¹²³")', "(e.g. the demo repo's number.py has \"⁰¹²³\")"),
]
p = Path("skills/ticket-resolver/SKILL.md")
lines = p.read_text().split("\n"); m = mask(lines); used = set()
for i, line in enumerate(lines):
    if m[i]:
        if line.startswith("Example ("):
            lines[i] = "Example (demo repo vishnuverse/humanize, " + line[len("Example ("):]
        continue
    for old, new in PAIRS:
        if old in line:
            line = line.replace(old, new); used.add(old)
    line = re.sub(r"\bmain\b", "{{default_branch}}", line)
    lines[i] = line
missing = [o for o, _ in PAIRS if o not in used]
assert not missing, missing
text = "\n".join(lines)
out = "\n".join(l for l, k in zip(text.split("\n"), mask(text.split("\n"))) if not k)
for bad in ("vishnuverse", "src/humanize", "python-humanize"):
    assert bad not in out, bad
assert not re.search(r"\bmain\b", out)
p.write_text(text)

a = Path("agents/ticket-resolver.json"); agent = json.loads(a.read_text())
def walk(v):
    if isinstance(v, str):
        for old, new in [('owner \\"vishnuverse\\" and repo \\"humanize\\"', 'owner \\"{{owner}}\\" and repo \\"{{name}}\\"'),
                         ('owner "vishnuverse" and repo "humanize"', 'owner "{{owner}}" and repo "{{name}}"'),
                         ("vishnuverse/humanize", "{{repo}}"), ("src/humanize", "{{source_dir}}")]:
            v = v.replace(old, new)
        return v
    if isinstance(v, list): return [walk(x) for x in v]
    if isinstance(v, dict): return {k: walk(x) for k, x in v.items()}
    return v
agent = walk(agent)
assert agent["manifest"]["model"]["name"] == "openrouter/deepseek-v4-flash"
agent["manifest"]["model"]["name"] = "{{model}}"
assert "vishnuverse" not in json.dumps(agent)
a.write_text(json.dumps(agent, indent=2, ensure_ascii=False) + "\n")
print("templated")
EOF
```

Expected: `templated`. If an assertion names a pair or a leftover, read that skill line and add the exact phrasing to
`PAIRS` as a ruling. Never edit the golden file to match.

- [ ] **Step 5: Render at registration**

In `scripts/setup_agents.ts`:
- add these imports:

```ts
import { ConfigError, loadConfig } from "../orchestrator/src/config.ts";
import { RenderError, renderDeep, renderText, templateValues } from "../orchestrator/src/render.ts";
```

- change `readLocalSkill(root: string, name: string)` to
  `readLocalSkill(root: string, name: string, values: Record<string, string>)`, and right after
  `const text = readFileSync(path, "utf8");` insert a rendered copy, using it in place of `text` below:

```ts
  let rendered: string;
  try {
    rendered = renderText(text, values, `${dir}/SKILL.md`);
  } catch (err) {
    fail((err as Error).message);
  }
```

  (Rename the later uses of `text` in that function to `rendered`; render the extras' `content` the same way.)
- change `readAgents(root: string)` to `readAgents(root: string, values: Record<string, string>)`, and after the
  object shape is validated, return `renderDeep({ file, name, description, manifest }, values, file)` wrapped in the
  same `try { … } catch (err) { fail((err as Error).message); }`
- in `main`, before `const base = …`, add:

```ts
  let values: Record<string, string>;
  let configUrl: string;
  try {
    const cfg = loadConfig();
    values = templateValues(cfg);
    configUrl = cfg.trueforgeUrl;
  } catch (err) {
    if (err instanceof ConfigError || err instanceof RenderError) fail(err.message);
    throw err;
  }
```

- change `const base = (process.env.TRUEFORGE_URL ?? "http://localhost:8790")` to
  `const base = (process.env.TRUEFORGE_URL ?? configUrl)`
- pass `values` to `readAgents(root, values)` and to `readLocalSkill(root, name, values)`
- update the header comment's "No npm dependencies" sentence to "Uses orchestrator/src/config.ts and render.ts
  (run `npm --prefix orchestrator ci` first)"

- [ ] **Step 6: Run the tests and a dry registration check**

Run: `npm --prefix orchestrator test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → Expected: `fail 0`.
Run: `uv run pytest -q; echo "exit $?"`
Expected: `exit 0`. `tests/check/test_agent_and_skill.py` reads the template files; if a needle there contains a
now-templated value, change that needle to the template form (for example `{{tests_dir}}`) and record it as a ruling.

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/render.ts orchestrator/test/render.test.ts tests/fixtures/skill skills/ticket-resolver/SKILL.md agents/ticket-resolver.json scripts/setup_agents.ts tests/check
git commit -m "feat(agent): skill and agent spec are templates rendered from shipgate.yaml

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `reset.sh` is demo-only

**Files:**
- Modify: `scripts/reset.sh` (after the `GH_REPO`/`SHIPGATE_REPO` guard loop)
- Create: `tests/check/test_reset_guard.py`

**Interfaces:**
- Consumes: the `shipgate_config.py target.repo` CLI (Task 1).
- Produces: `reset.sh` exits 2 before any network call unless the config target is `vishnuverse/humanize`.

- [ ] **Step 1: Write the failing test**

Create `tests/check/test_reset_guard.py`:

```python
"""reset.sh closes PRs and deletes branches: it must refuse any target but the demo fork (spec any-repo §5)."""

from __future__ import annotations

import os
import subprocess

from shipgate_config import ROOT

FIXTURES = ROOT / "tests" / "fixtures" / "config"


def test_reset_refuses_a_configured_target_that_is_not_the_demo() -> None:
    env = {**os.environ, "SHIPGATE_CONFIG": str(FIXTURES / "valid-dotted-repo.yaml"), "GITHUB_PAT": ""}
    r = subprocess.run(["bash", str(ROOT / "scripts" / "reset.sh")], capture_output=True, text=True, env=env, cwd=ROOT)
    assert r.returncode == 2
    assert "acme/my.pkg_x" in r.stderr and "demo" in r.stderr
```

Run: `uv run pytest tests/check/test_reset_guard.py -q`
Expected: FAIL. Without the guard, the dry run proceeds and does not exit 2 with that message.

- [ ] **Step 2: Add the guard**

In `scripts/reset.sh`, right after the `for var in GH_REPO SHIPGATE_REPO; do … done` block, insert:

```bash
# Demo-only: this script closes PRs, deletes branches and rewrites labels, so it never runs against a user's repo.
CFG_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && uv run --quiet python scripts/shipgate_config.py target.repo)" || {
  echo "reset.sh: cannot read shipgate.yaml; refusing" >&2
  exit 2
}
if [ "$(printf '%s' "$CFG_REPO" | tr 'A-Z' 'a-z')" != "$REPO" ]; then
  echo "reset.sh: refusing: shipgate.yaml targets $CFG_REPO; this script only resets the demo fork $REPO" >&2
  exit 2
fi
```

- [ ] **Step 3: Run the tests and commit**

Run: `uv run pytest -q; echo "exit $?"` → Expected: `exit 0`.
Run: `bash -n scripts/reset.sh && echo ok` → Expected: `ok`.

```bash
git add scripts/reset.sh tests/check/test_reset_guard.py
git commit -m "fix(reset): refuse to run unless shipgate.yaml targets the demo fork

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: TrueForge registration and doctor (`setup.ts`)

**Files:**
- Create: `orchestrator/src/setup.ts`, `orchestrator/test/setup.test.ts`, `scripts/setup_trueforge.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 1).
- Produces (`setup.ts`):
  - `type FetchLike`, `class SetupError`
  - `interface Secrets {openrouterKey?, githubPat?}`, `interface SetupOptions {rotateKeys, allowRemote}`
  - `isLoopback(url)`
  - `registerAll(base, secrets, opts, fetchFn?, log?) -> Promise<Step[]>`
  - `doctor(base, fetchFn?) -> Promise<Check[]>`
  - constants `OPENROUTER_MODELS`, `GITHUB_MCP_URL`, `TRIAGE_MCP_URL`
- Produces (CLI): `npx --yes tsx scripts/setup_trueforge.ts [--rotate-keys] [--allow-remote] [--check]`, exiting
  0/1/2

- [ ] **Step 1: Write the failing tests**

Create `orchestrator/test/setup.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { OPENROUTER_MODELS, SetupError, doctor, isLoopback, registerAll, type FetchLike } from "../src/setup.ts";

const KEY = "sk-or-test-not-real";
const PAT = "github_pat_test_not_real";
type Row = { name: string; manifest: Record<string, unknown>; auth_status?: { status: string } };

function fakeTrueForge(providers: Row[] = [], servers: Row[] = [], agent: Record<string, unknown> | null = null) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path: u.pathname + u.search, body });
    const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (u.pathname === "/api/v1/settings/model-providers") {
      if (init.method === "PUT") {
        const m = body.manifest;
        providers = [...providers.filter((p) => p.name !== m.name), { name: m.name, manifest: m }];
        return json({ name: m.name, manifest: m });
      }
      return json(providers);
    }
    if (u.pathname === "/api/v1/settings/mcp-servers") {
      if (init.method === "PUT") {
        const m = body.manifest;
        servers = [...servers.filter((s) => s.name !== m.name), { name: m.name, manifest: m, auth_status: { status: m.auth ? "authenticated" : "not_required" } }];
        return json({ name: m.name, manifest: m });
      }
      return json(servers);
    }
    if (u.pathname === "/api/v1/agents") return json(agent ? [{ id: "a1", name: "ticket-resolver" }] : []);
    if (u.pathname === "/api/v1/agents/a1") return json(agent);
    return new Response("{}", { status: 404 });
  };
  return { fetchFn, calls, state: () => ({ providers, servers }) };
}

const logs: string[] = [];
const log = (s: string) => logs.push(s);
const opts = { rotateKeys: false, allowRemote: false };

test("creates the provider and both connectors on an empty TrueForge", async () => {
  const tf = fakeTrueForge();
  const steps = await registerAll("http://localhost:8790", { openrouterKey: KEY, githubPat: PAT }, opts, tf.fetchFn, log);
  assert.deepEqual(steps.map((s) => s.action), ["created", "created", "created"]);
  const [provider] = tf.state().providers;
  assert.equal(provider?.manifest.base_url, "https://openrouter.ai/api/v1");
  assert.deepEqual(provider?.manifest.models, OPENROUTER_MODELS);
  const gh = tf.state().servers.find((s) => s.name === "github");
  assert.deepEqual((gh?.manifest.auth as Record<string, unknown>).headers, { Authorization: `Bearer ${PAT}` });
  const triage = tf.state().servers.find((s) => s.name === "triage");
  assert.equal(triage?.manifest.url, "http://127.0.0.1:8803/mcp");
  assert.equal(triage?.manifest.auth, undefined);
});

test("keeps what exists and sends no secret", async () => {
  const tf = fakeTrueForge(
    [{ name: "openrouter", manifest: { name: "openrouter", models: [] } }],
    [{ name: "github", manifest: {} }, { name: "triage", manifest: {} }],
  );
  const steps = await registerAll("http://localhost:8790", {}, opts, tf.fetchFn, log);
  assert.deepEqual(steps.map((s) => s.action), ["kept", "kept", "kept"]);
  assert.equal(tf.calls.filter((c) => c.method === "PUT").length, 0);
});

test("rotating keys keeps the user's extra models", async () => {
  const extra = { name: "gpt-5-nano", model_id: "openai/gpt-5-nano", properties: { context_length: 400000, max_output_tokens: 128000 } };
  const tf = fakeTrueForge(
    [{ name: "openrouter", manifest: { type: "custom", name: "openrouter", base_url: "https://openrouter.ai/api/v1", models: [extra], auth: { api_key: "***" } } }],
    [{ name: "github", manifest: {} }, { name: "triage", manifest: {} }],
  );
  await registerAll("http://localhost:8790", { openrouterKey: KEY, githubPat: PAT }, { ...opts, rotateKeys: true }, tf.fetchFn, log);
  const provider = tf.state().providers.find((p) => p.name === "openrouter");
  assert.deepEqual(provider?.manifest.models, [extra]);
  assert.deepEqual(provider?.manifest.auth, { api_key: KEY });
  assert.equal(tf.calls.filter((c) => c.method === "PUT" && c.path.includes("mcp-servers")).length, 1); // github only
});

test("refuses to send keys to a non-local TrueForge unless allowed", async () => {
  const tf = fakeTrueForge();
  await assert.rejects(
    registerAll("https://tf.example.com", { openrouterKey: KEY, githubPat: PAT }, opts, tf.fetchFn, log),
    (e: unknown) => e instanceof SetupError && /not local/.test(e.message),
  );
  assert.equal(tf.calls.length, 0);
  await registerAll("https://tf.example.com", { openrouterKey: KEY, githubPat: PAT }, { ...opts, allowRemote: true }, tf.fetchFn, log);
  assert.ok(tf.calls.length > 0);
  assert.ok(isLoopback("http://127.0.0.1:8790") && isLoopback("http://[::1]:8790") && !isLoopback("http://10.0.0.2"));
});

test("a missing key is named, never shown", async () => {
  const tf = fakeTrueForge();
  await assert.rejects(registerAll("http://localhost:8790", { githubPat: PAT }, opts, tf.fetchFn, log), /OPENROUTER_API_KEY/);
});

test("HTTP errors never echo the response body, and logs never hold a key", async () => {
  const leaky: FetchLike = async () => new Response(`{"echo":"${KEY}"}`, { status: 500 });
  await assert.rejects(
    registerAll("http://localhost:8790", { openrouterKey: KEY, githubPat: PAT }, opts, leaky, log),
    (e: unknown) => e instanceof SetupError && !e.message.includes(KEY),
  );
  assert.ok(logs.every((l) => !l.includes(KEY) && !l.includes(PAT)));
});

test("doctor passes a good install and names each problem", async () => {
  const good = {
    name: "ticket-resolver",
    manifest: {
      mcp_servers: [
        { name: "github", require_approval_for_tools: ["create_pull_request", "add_issue_comment"] },
        { name: "triage", enable_tools: ["triage_ticket"], require_approval_for_tools: [] },
      ],
      config: { web_search: { enabled: false } },
    },
  };
  const servers: Row[] = [
    { name: "github", manifest: {}, auth_status: { status: "authenticated" } },
    { name: "triage", manifest: {}, auth_status: { status: "not_required" } },
  ];
  const ok = await doctor("http://localhost:8790", fakeTrueForge([{ name: "openrouter", manifest: {} }], servers, good).fetchFn);
  assert.ok(ok.every((c) => c.ok), JSON.stringify(ok));
  const bad = structuredClone(good);
  (bad.manifest.config.web_search as { enabled: boolean }).enabled = true;
  bad.manifest.mcp_servers[0]!.require_approval_for_tools = ["create_pull_request"];
  const res = await doctor("http://localhost:8790", fakeTrueForge([], servers.slice(0, 1), bad).fetchFn);
  const failed = res.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed.sort(), ["agent gates", "agent web_search", "connector triage", "provider openrouter"].sort());
});
```

Run: `npm --prefix orchestrator test 2>&1 | grep -E "^ℹ fail|Cannot find"`
Expected: FAIL: cannot find `../src/setup.ts`.

- [ ] **Step 2: Write `setup.ts`**

Create `orchestrator/src/setup.ts`:

```ts
// Register what Ticket Resolver needs in TrueForge 0.2.1, and check it (spec any-repo §4 steps 4 and 6).
// REST bodies are snake_case; PUT on settings/* creates or replaces one entry by name. Keys are sent only to a
// loopback TrueForge (unless allowRemote), only when an entry is missing or rotateKeys is set, and never logged.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export class SetupError extends Error {}
export interface Secrets {
  openrouterKey?: string;
  githubPat?: string;
}
export interface SetupOptions {
  rotateKeys: boolean;
  allowRemote: boolean;
}
export interface Step {
  item: string;
  action: "created" | "kept" | "rotated";
}
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODELS = [
  {
    name: "deepseek-v4-flash",
    model_id: "deepseek/deepseek-v4-flash",
    properties: { context_length: 1048576, max_output_tokens: 384000, reasoning_efforts: ["high", "xhigh"] },
  },
  {
    name: "glm-5-3-flash",
    model_id: "z-ai/glm-5.3-flash",
    properties: { context_length: 1310720, max_output_tokens: 128000, reasoning_efforts: ["low", "high", "max"] },
  },
];
export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
export const TRIAGE_MCP_URL = "http://127.0.0.1:8803/mcp";
const GATES = ["add_issue_comment", "create_pull_request"];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

class Api {
  constructor(
    private readonly base: string,
    private readonly fetchFn: FetchLike,
  ) {}

  async call(method: "GET" | "PUT", path: string, body?: unknown): Promise<Json> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/api/v1${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new SetupError(`cannot reach TrueForge at ${this.base} (${(err as Error).message})`);
    }
    const text = await res.text();
    if (!res.ok) throw new SetupError(`${method} ${path}: HTTP ${res.status}`); // never echo the body
    try {
      return text ? (JSON.parse(text) as Json) : {};
    } catch {
      throw new SetupError(`${method} ${path}: reply is not JSON`);
    }
  }

  async list(path: string): Promise<Json[]> {
    const res = await this.call("GET", path);
    return Array.isArray(res.data) ? res.data.filter(isObj) : [];
  }
}

const nameOf = (row: Json): string => {
  const m = isObj(row.manifest) ? row.manifest : {};
  return String(row.name ?? m.name ?? "");
};

export async function registerAll(
  base: string,
  secrets: Secrets,
  opts: SetupOptions,
  fetchFn: FetchLike = fetch,
  log: (s: string) => void = console.log,
): Promise<Step[]> {
  if (!isLoopback(base) && !opts.allowRemote) {
    throw new SetupError(`refusing to send keys to ${new URL(base).host}: TrueForge is not local (--allow-remote overrides)`);
  }
  const api = new Api(base.replace(/\/+$/, ""), fetchFn);
  const steps: Step[] = [];

  const provider = (await api.list("/settings/model-providers")).find((p) => nameOf(p) === "openrouter");
  if (provider === undefined || opts.rotateKeys) {
    if (!secrets.openrouterKey) throw new SetupError("OPENROUTER_API_KEY is not set in .env");
    const existing = provider && isObj(provider.manifest) ? provider.manifest : undefined;
    const manifest = existing
      ? { ...existing, auth: { api_key: secrets.openrouterKey } }
      : { type: "custom", name: "openrouter", base_url: OPENROUTER_BASE_URL, models: OPENROUTER_MODELS, auth: { api_key: secrets.openrouterKey } };
    await api.call("PUT", "/settings/model-providers", { manifest });
    steps.push({ item: "model provider openrouter", action: provider ? "rotated" : "created" });
  } else {
    steps.push({ item: "model provider openrouter", action: "kept" });
  }

  const servers = await api.list("/settings/mcp-servers");
  const github = servers.find((s) => nameOf(s) === "github");
  if (github === undefined || opts.rotateKeys) {
    if (!secrets.githubPat) throw new SetupError("GITHUB_PAT is not set in .env");
    await api.call("PUT", "/settings/mcp-servers", {
      manifest: {
        type: "remote",
        name: "github",
        url: GITHUB_MCP_URL,
        description: "GitHub remote MCP (issues, branches, pull requests)",
        auth: { type: "header", headers: { Authorization: `Bearer ${secrets.githubPat}` } },
      },
    });
    steps.push({ item: "connector github", action: github ? "rotated" : "created" });
  } else {
    steps.push({ item: "connector github", action: "kept" });
  }
  if (servers.some((s) => nameOf(s) === "triage")) {
    steps.push({ item: "connector triage", action: "kept" });
  } else {
    await api.call("PUT", "/settings/mcp-servers", {
      manifest: { type: "remote", name: "triage", url: TRIAGE_MCP_URL, description: "Jev triage pre-check (triage-v1), read-only" },
    });
    steps.push({ item: "connector triage", action: "created" });
  }
  for (const s of steps) log(`✓ ${s.item}: ${s.action}`);
  return steps;
}

export async function doctor(base: string, fetchFn: FetchLike = fetch): Promise<Check[]> {
  const api = new Api(base.replace(/\/+$/, ""), fetchFn);
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const providers = await api.list("/settings/model-providers");
  add("provider openrouter", providers.some((p) => nameOf(p) === "openrouter"), "model provider registered");
  const servers = await api.list("/settings/mcp-servers");
  for (const want of ["github", "triage"]) {
    const row = servers.find((s) => nameOf(s) === want);
    const status = row && isObj(row.auth_status) ? String(row.auth_status.status) : "missing";
    add(`connector ${want}`, status === "authenticated" || status === "not_required", `auth ${status}`);
  }
  const agents = await api.list("/agents?agent_name=ticket-resolver&limit=100");
  const id = agents.find((a) => a.name === "ticket-resolver")?.id;
  const agent = typeof id === "string" ? (await api.call("GET", `/agents/${encodeURIComponent(id)}`)).data : undefined;
  const manifest = isObj(agent) && isObj(agent.manifest) ? agent.manifest : {};
  const mcp = Array.isArray(manifest.mcp_servers) ? manifest.mcp_servers.filter(isObj) : [];
  const gates = mcp.find((s) => s.name === "github")?.require_approval_for_tools;
  const sorted = Array.isArray(gates) ? gates.map(String).sort() : [];
  add("agent gates", JSON.stringify(sorted) === JSON.stringify(GATES), `github gates [${sorted.join(", ")}]`);
  add("agent triage", mcp.some((s) => s.name === "triage"), "triage server enabled");
  const config = isObj(manifest.config) ? manifest.config : {};
  const web = isObj(config.web_search) ? config.web_search.enabled : undefined;
  add("agent web_search", web === false, `web_search.enabled = ${String(web)}`);
  return checks;
}
```

Create `scripts/setup_trueforge.ts`:

```ts
/**
 * Register the model provider, connectors and doctor-check TrueForge for Ticket Resolver (spec any-repo §4).
 *   npx --yes tsx scripts/setup_trueforge.ts [--rotate-keys] [--allow-remote]   # register (keys from .env)
 *   npx --yes tsx scripts/setup_trueforge.ts --check                            # doctor only
 * Exit 0 ok, 1 a step failed, 2 usage/config error. Never prints key values.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, ROOT, loadConfig } from "../orchestrator/src/config.ts";
import { SetupError, doctor, registerAll } from "../orchestrator/src/setup.ts";

async function main(argv: string[]): Promise<number> {
  const known = new Set(["--rotate-keys", "--allow-remote", "--check"]);
  const bad = argv.find((a) => !known.has(a));
  if (bad !== undefined) {
    console.error(`setup_trueforge: unknown argument '${bad}'`);
    return 2;
  }
  const envFile = process.env.SHIPGATE_ENV_FILE ?? join(ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  let base: string;
  try {
    base = (process.env.TRUEFORGE_URL ?? loadConfig().trueforgeUrl).replace(/\/+$/, "");
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`setup_trueforge: ${err.message}`);
      return 2;
    }
    throw err;
  }
  try {
    if (argv.includes("--check")) {
      const checks = await doctor(base);
      for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
      return checks.every((c) => c.ok) ? 0 : 1;
    }
    await registerAll(
      base,
      { openrouterKey: process.env.OPENROUTER_API_KEY, githubPat: process.env.GITHUB_PAT },
      { rotateKeys: argv.includes("--rotate-keys"), allowRemote: argv.includes("--allow-remote") },
    );
    return 0;
  } catch (err) {
    if (err instanceof SetupError) {
      console.error(`✗ ${err.message}`);
      return 1;
    }
    throw err;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
```

- [ ] **Step 3: Run the tests and commit**

Run: `npm --prefix orchestrator test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → Expected: `fail 0`.

```bash
git add orchestrator/src/setup.ts orchestrator/test/setup.test.ts scripts/setup_trueforge.ts
git commit -m "feat(setup): register provider and connectors via the TrueForge API; doctor checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `scripts/setup.sh` and `scripts/stop.sh`

**Files:**
- Create: `scripts/setup.sh`, `scripts/stop.sh`, `tests/check/test_setup_sh.py`

**Interfaces:**
- Consumes:
  - `shipgate_config.py <key>` (Task 1)
  - `setup_trueforge.ts` (Task 7)
  - `setup_agents.ts` (Task 5)
  - `mcp/triage/server.py --smoke` (Task 4)
- Produces:
  - `scripts/setup.sh [--dry-run|--check] [--no-start] [--rotate-keys] [--allow-remote] [--allow-unprotected] [--smoke <issue>]`
  - `scripts/stop.sh`
  - env overrides `SHIPGATE_ENV_FILE` and `SHIPGATE_PID_DIR`

- [ ] **Step 1: Write the failing tests**

Create `tests/check/test_setup_sh.py`:

```python
"""scripts/setup.sh and stop.sh (spec any-repo §4): the offline paths. Real registration is the live task."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from shipgate_config import ROOT

FAKE = {"GITHUB_PAT": "ghp_fake_value_1234", "OPENROUTER_API_KEY": "sk-or-fake-5678", "TYPESAFE_API_KEY": "ts-fake-9012"}


def run(*args: str, env_file: Path | None = None, extra: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k not in ("SHIPGATE_CONFIG", *FAKE)}
    if env_file is not None:
        env["SHIPGATE_ENV_FILE"] = str(env_file)
    env.update(extra or {})
    return subprocess.run(["bash", *args], capture_output=True, text=True, env=env, cwd=ROOT, timeout=120)


def env_file(tmp_path: Path, lines: list[str]) -> Path:
    p = tmp_path / ".env"
    p.write_text("\n".join(lines) + "\n")
    return p


def test_dry_run_prints_the_plan_and_no_secret(tmp_path: Path) -> None:
    pids = tmp_path / "pids"
    r = run(
        "scripts/setup.sh", "--dry-run",
        env_file=env_file(tmp_path, [f"{k}={v}" for k, v in FAKE.items()]),
        extra={"SHIPGATE_PID_DIR": str(pids)},
    )  # fmt: skip
    assert r.returncode == 0, r.stderr
    out = r.stdout + r.stderr
    for phrase in ("would start TrueForge", "would register", "vishnuverse/humanize", "would create missing labels"):
        assert phrase in out, phrase
    assert all(v not in out for v in FAKE.values())
    assert not pids.exists()


def test_export_and_quoted_env_lines_count(tmp_path: Path) -> None:
    lines = ['export GITHUB_PAT="ghp_fake_value_1234"', "OPENROUTER_API_KEY='sk-or-fake-5678'", "TYPESAFE_API_KEY=ts-fake-9012"]
    r = run("scripts/setup.sh", "--dry-run", env_file=env_file(tmp_path, lines))
    assert r.returncode == 0, r.stderr


def test_empty_key_is_a_usage_error_naming_the_key(tmp_path: Path) -> None:
    r = run("scripts/setup.sh", "--dry-run", env_file=env_file(tmp_path, ["GITHUB_PAT=x", "OPENROUTER_API_KEY=", "TYPESAFE_API_KEY=y"]))
    assert r.returncode == 2 and "OPENROUTER_API_KEY" in r.stderr


def test_config_error_exits_2(tmp_path: Path) -> None:
    bad = ROOT / "tests" / "fixtures" / "config" / "bad-repo.yaml"
    r = run(
        "scripts/setup.sh", "--dry-run",
        env_file=env_file(tmp_path, [f"{k}={v}" for k, v in FAKE.items()]),
        extra={"SHIPGATE_CONFIG": str(bad)},
    )  # fmt: skip
    assert r.returncode == 2 and "target.repo" in r.stderr


def test_unknown_flag_exits_2() -> None:
    assert run("scripts/setup.sh", "--nope").returncode == 2


def test_stop_with_nothing_started(tmp_path: Path) -> None:
    r = run("scripts/stop.sh", extra={"SHIPGATE_PID_DIR": str(tmp_path / "pids")})
    assert r.returncode == 0 and "nothing to stop" in r.stdout
```

Run: `uv run pytest tests/check/test_setup_sh.py -q 2>&1 | tail -3`
Expected: 6 failed (no such file).

- [ ] **Step 2: Write `setup.sh`**

Create `scripts/setup.sh` (mode 755):

```bash
#!/usr/bin/env bash
# One-command setup for Ticket Resolver on the repo named in shipgate.yaml
# (docs/superpowers/specs/2026-09-26-any-repo-setup-design.md §4).
#
#   scripts/setup.sh                 preflight, install, start services, register in TrueForge, check the repo, doctor
#   scripts/setup.sh --dry-run       print the plan: no network, no writes, no keys sent, nothing started
#   scripts/setup.sh --check         doctor only (services must be running)
#   options: --no-start --rotate-keys --allow-remote --allow-unprotected --smoke <issue>
# Exit 0 ok, 1 a step failed, 2 usage/config error. Never prints key values. Works with macOS bash 3.2.
set -o pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

DRY=0 CHECK=0 NOSTART=0 ROTATE=0 REMOTE=0 UNPROT=0 SMOKE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --check) CHECK=1 ;;
    --no-start) NOSTART=1 ;;
    --rotate-keys) ROTATE=1 ;;
    --allow-remote) REMOTE=1 ;;
    --allow-unprotected) UNPROT=1 ;;
    --smoke)
      shift
      case "$1" in '' | *[!0-9]*) echo "setup.sh: --smoke needs an issue number" >&2; exit 2 ;; esac
      SMOKE="$1"
      ;;
    -h | --help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "setup.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
  shift
done

ENV_FILE="${SHIPGATE_ENV_FILE:-$ROOT/.env}"
PID_DIR="${SHIPGATE_PID_DIR:-$ROOT/runs/pids}"
LOG_DIR="$ROOT/runs/logs"
ok() { printf '✓ %s\n' "$1"; }
plan() { printf '• would %s\n' "$1"; }
die() { printf '✗ %s\n' "$1" >&2; exit "${2:-1}"; }

# Value of KEY in the env file: accepts `export KEY=v`, "v" and 'v'; prints nothing else.
env_value() {
  local v
  v="$(sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1=//p" "$ENV_FILE" 2>/dev/null | tail -1)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}
cfg() {
  local offline=""
  [ "$DRY" = 1 ] && offline="--offline"
  uv run $offline --quiet python scripts/shipgate_config.py "$1"
}
# GitHub REST with the token on stdin (never on the command line).
gh_api() {
  local method="$1" path="$2"
  shift 2
  printf 'Authorization: Bearer %s\n' "$GITHUB_PAT_VALUE" |
    curl -sS -m 20 -X "$method" -H @- -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' "https://api.github.com$path" "$@"
}
answers() { [ "$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$1")" != "000" ]; }
# The program listening on a port (empty if free), so a busy port is named instead of timing out.
port_owner() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fc 2>/dev/null | sed -n 's/^c//p' | head -1; }
url_port() { printf '%s' "$1" | sed -n 's|^https\{0,1\}://[^:/]*:\([0-9]*\).*|\1|p'; }
wait_for() {
  local url="$1" name="$2" i=0
  while [ $i -lt 90 ]; do answers "$url" && return 0; sleep 1; i=$((i + 1)); done
  printf '✗ %s did not answer within 90 s; last lines of %s:\n' "$name" "$LOG_DIR/$name.log" >&2
  tail -20 "$LOG_DIR/$name.log" >&2
  exit 1
}
start_bg() {
  local name="$1"
  shift
  mkdir -p "$PID_DIR" "$LOG_DIR"
  nohup "$@" >"$LOG_DIR/$name.log" 2>&1 &
  echo $! >"$PID_DIR/$name.pid"
}
json_has() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(eval(process.argv[1])(JSON.parse(s))?0:1)}catch{process.exit(1)}})' "$1"; }

# 1. Preflight
for tool in node uv git curl; do command -v "$tool" >/dev/null 2>&1 || die "$tool not found; install it first (README)" 1; done
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=14)?0:1)' ||
  die "Node >= 22.14 required (have $(node -v))" 1
[ -f "$ENV_FILE" ] || die "$ENV_FILE missing: cp .env.example .env and fill it" 2
for key in GITHUB_PAT OPENROUTER_API_KEY TYPESAFE_API_KEY; do
  [ -n "$(env_value "$key")" ] || die "$ENV_FILE: $key is empty" 2
done
ok ".env has GITHUB_PAT, OPENROUTER_API_KEY, TYPESAFE_API_KEY (values not shown)"
TARGET="$(cfg target.repo)" || exit 2
BRANCH="$(cfg target.default_branch)" || exit 2
TF_URL="${TRUEFORGE_URL:-$(cfg trueforge.url)}" || exit 2
TF_URL="${TF_URL%/}"
ok "shipgate.yaml: target $TARGET (default branch $BRANCH), TrueForge $TF_URL"
LABELS="bug:d73a4a triaged:fbca04 fix-proposed:0e8a16 cannot-reproduce:cfd3d7 needs-human:b60205"

if [ "$DRY" = 1 ]; then
  plan "install dependencies: uv sync; npm --prefix orchestrator ci"
  [ "$NOSTART" = 1 ] || plan "start TrueForge 0.2.1 at $TF_URL (20-min turns, loopback allow-list) and the triage MCP on 127.0.0.1:8803, unless already running"
  plan "register in TrueForge: model provider openrouter, connectors github and triage (keys from .env, sent only to a local TrueForge$([ "$ROTATE" = 1 ] && echo ', rotated')), then the ticket-resolver agent rendered from shipgate.yaml"
  plan "require branch protection on $TARGET@$BRANCH$([ "$UNPROT" = 1 ] && echo ' (override given)')"
  plan "create missing labels on $TARGET: $(printf '%s ' $LABELS | sed 's/:[0-9a-f]*//g')"
  plan "run the doctor$([ -n "$SMOKE" ] && echo " and a triage smoke call on #$SMOKE")"
  exit 0
fi

GITHUB_PAT_VALUE="$(env_value GITHUB_PAT)"
code="$(gh_api GET "/repos/$TARGET" -o /dev/null -w '%{http_code}')"
[ "$code" = 200 ] || die "the GitHub token cannot read $TARGET (HTTP $code)" 1
ok "GitHub token reads $TARGET"

if [ "$CHECK" = 0 ]; then
  # 2. Install
  uv sync --quiet || die "uv sync failed" 1
  npm --prefix orchestrator ci --silent >/dev/null || die "npm ci failed" 1
  ok "dependencies installed"

  # 3. Services
  if [ "$NOSTART" = 0 ]; then
    if answers "$TF_URL/"; then
      ok "TrueForge already running at $TF_URL (not restarted; it must run with OUTBOUND_URL_ALLOWED_HOSTS='[\"127.0.0.1\"]')"
    else
      tf_port="$(url_port "$TF_URL")"
      owner="$(port_owner "${tf_port:-80}")"
      [ -z "$owner" ] || die "port ${tf_port:-80} is used by '$owner' but TrueForge does not answer at $TF_URL" 1
      start_bg trueforge env SERVER_EXECUTION_TIMEOUT_SECONDS=1200 'OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1"]' \
        npx --yes @truefoundry/trueforge@0.2.1
      wait_for "$TF_URL/" trueforge
      ok "TrueForge started (log runs/logs/trueforge.log)"
    fi
    if answers "http://127.0.0.1:8803/mcp"; then
      ok "triage MCP already running on 127.0.0.1:8803"
    else
      owner="$(port_owner 8803)"
      [ -z "$owner" ] || die "port 8803 is used by '$owner' but the triage MCP does not answer" 1
      start_bg triage uv run mcp/triage/server.py
      wait_for "http://127.0.0.1:8803/mcp" triage
      ok "triage MCP started (log runs/logs/triage.log)"
    fi
  fi

  # 4. Register
  args=""
  [ "$ROTATE" = 1 ] && args="$args --rotate-keys"
  [ "$REMOTE" = 1 ] && args="$args --allow-remote"
  TRUEFORGE_URL="$TF_URL" SHIPGATE_ENV_FILE="$ENV_FILE" npx --yes tsx scripts/setup_trueforge.ts $args || exit 1
  TRUEFORGE_URL="$TF_URL" npx --yes tsx scripts/setup_agents.ts --inline-skill || die "agent registration failed" 1
fi

# 5. Target repo: branch protection (read), labels (only write)
protected=0
gh_api GET "/repos/$TARGET/rules/branches/$BRANCH" | json_has 'r=>Array.isArray(r)&&r.some(x=>x.type==="pull_request")' && protected=1
[ $protected = 1 ] || { gh_api GET "/repos/$TARGET/branches/$BRANCH" | json_has 'b=>b.protected===true' && protected=1; }
if [ $protected = 1 ]; then
  ok "$TARGET@$BRANCH is protected"
elif [ "$UNPROT" = 1 ]; then
  printf '! %s@%s is NOT protected: create_branch/push_files are ungated, so nothing stops a push to it\n' "$TARGET" "$BRANCH" >&2
else
  die "$TARGET@$BRANCH is not protected; add a ruleset requiring pull requests (no bypass), or pass --allow-unprotected" 1
fi
if [ "$CHECK" = 0 ]; then
  missing=""
  for pair in $LABELS; do
    name="${pair%%:*}"
    [ "$(gh_api GET "/repos/$TARGET/labels/$name" -o /dev/null -w '%{http_code}')" = 200 ] || missing="$missing $pair"
  done
  if [ -n "$missing" ]; then
    echo "creating labels on $TARGET:$(printf ' %s' $missing | sed 's/:[0-9a-f]*//g')"
    for pair in $missing; do
      code="$(gh_api POST "/repos/$TARGET/labels" -o /dev/null -w '%{http_code}' \
        -d "{\"name\":\"${pair%%:*}\",\"color\":\"${pair##*:}\"}")"
      [ "$code" = 201 ] || die "creating label ${pair%%:*} failed (HTTP $code)" 1
    done
  fi
  ok "labels present on $TARGET"
fi

# 6. Doctor
answers "http://127.0.0.1:8803/mcp" || die "triage MCP not answering on 127.0.0.1:8803 (uv run mcp/triage/server.py)" 1
TRUEFORGE_URL="$TF_URL" npx --yes tsx scripts/setup_trueforge.ts --check || die "doctor found problems (above)" 1
if [ -n "$SMOKE" ]; then
  uv run mcp/triage/server.py --smoke "$SMOKE" || die "triage smoke call failed (above)" 1
fi
ok "ready. Next: npm --prefix orchestrator run shipgate -- run --issue <n> --approve terminal"
```

- [ ] **Step 3: Write `stop.sh`**

Create `scripts/stop.sh` (mode 755):

```bash
#!/usr/bin/env bash
# Stop what scripts/setup.sh started (pid files in runs/pids), and nothing else. Works with macOS bash 3.2.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="${SHIPGATE_PID_DIR:-$ROOT/runs/pids}"
stopped=0
for f in "$PID_DIR"/trueforge.pid "$PID_DIR"/triage.pid; do
  [ -f "$f" ] || continue
  pid="$(cat "$f")"
  case "$(ps -o command= -p "$pid" 2>/dev/null)" in
    *trueforge* | *mcp/triage/server.py*) kill "$pid" && echo "stopped $(basename "$f" .pid) (pid $pid)" && stopped=1 ;;
    *) echo "$(basename "$f" .pid): pid $pid is not ours any more; left alone" ;;
  esac
  rm -f "$f"
done
[ $stopped = 1 ] || echo "nothing to stop"
```

- [ ] **Step 4: Run the tests**

Run: `chmod +x scripts/setup.sh scripts/stop.sh && bash -n scripts/setup.sh && bash -n scripts/stop.sh && echo syntax-ok`
Expected: `syntax-ok`.

Run: `uv run pytest tests/check/test_setup_sh.py -q` → Expected: `6 passed`.
Run: `uv run pytest -q; echo "exit $?"` → Expected: `exit 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup.sh scripts/stop.sh tests/check/test_setup_sh.py
git commit -m "feat(setup): one-command setup.sh (dry-run, check, smoke) and stop.sh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `docs/SPEC.md`, `docs/contracts.md`, `AGENTS.md`, `.env.example`,
  `docs/MEMORY.md`, `docs/HANDOVER.md`

- [ ] **Step 1: README**

1. **Replace the "Quick start (fresh laptop)" code block and Settings list with:**

```bash
git clone https://github.com/vishnuverse/trueforge-shipgate && cd trueforge-shipgate
cp .env.example .env          # fill GITHUB_PAT, OPENROUTER_API_KEY, TYPESAFE_API_KEY (never commit .env)
$EDITOR shipgate.yaml         # your repo, install/test commands, source dir (the committed values run the demo)
scripts/setup.sh              # installs, starts TrueForge + triage MCP, registers everything, checks, then prints:
npm --prefix orchestrator run shipgate -- run --issue 1 --approve terminal   # or --approve ui
```

   Follow it with one sentence: "`scripts/setup.sh --dry-run` shows the plan without doing anything;
   `scripts/stop.sh` stops what it started; re-running it changes nothing that's already set up."
2. **Rename "Using your own fork" to "Using your own repo":**
   - Requirements: a Python package tested with pytest; the default branch protected by a ruleset requiring pull
     requests with no bypass; a fine-grained token for that repo only (Contents, Issues, Pull requests: read/write).
   - The keys of `shipgate.yaml`, with one line each.
   - Limits: Jev's thresholds were tuned on humanize (expect more held tickets); the TR scenarios and scorecard are
     for the demo fork only, and `reset.sh` refuses any other repo.
   - Keep the existing fork instructions under a sub-heading "Scored demo (the humanize fork)".
3. **Add to the organisers' checklist, rule 5:** "our own OpenRouter, TypeSafe and GitHub accounts".

- [ ] **Step 2: CLAUDE.md, SPEC, contracts, AGENTS, `.env.example`, MEMORY, HANDOVER**

- **CLAUDE.md:**
  - The Setup block becomes `cp .env.example .env`, `$EDITOR shipgate.yaml`, `scripts/setup.sh`.
  - The Run block becomes `scripts/setup.sh --check` plus the shipgate run line.
  - Add `scripts/stop.sh`.
  - Boundary 7 becomes: "**Target repo = `shipgate.yaml` `target.repo`** (demo: fork `vishnuverse/humanize`). Its
    default branch must be protected with no bypass; `setup.sh` refuses otherwise. Agents never get
    `merge_pull_request` or `issue_write` and always pass the configured owner/repo."
  - Layout: add `shipgate.yaml`.
- **SPEC:**
  - §4.1: add the row `| Target | shipgate.yaml (target.repo, commands, source/tests dirs); skill and agent rendered at registration |`.
  - §4.7: add the note "Scenarios name `repo:`; `check.py` refuses a scenario whose repo differs from shipgate.yaml."
- **contracts.md:** add `## 9. shipgate.yaml` holding the schema and validation rules from spec §2, verbatim. Add a
  `SHIPGATE_CONFIG`, `SHIPGATE_ENV_FILE`, `SHIPGATE_PID_DIR` row to §6.
- **AGENTS.md:** add `shipgate.yaml`, `scripts/setup.sh` and `stop.sh`, and `orchestrator/src/config.ts`,
  `render.ts`, `setup.ts` to the directory map.
- **`.env.example`:** comment each key with who reads it (`setup.sh` registers `OPENROUTER_API_KEY` and
  `GITHUB_PAT` in TrueForge; the triage MCP reads `TYPESAFE_API_KEY`).
- **MEMORY:** one line per planning decision, 1–5 above.
- **HANDOVER:** a new top entry (done / next).

Run: `grep -rn "Using your own fork" README.md || echo clean` → Expected: `clean`.
Run: `uv run pytest -q; echo "exit $?"` → Expected: `exit 0`.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md docs/SPEC.md docs/contracts.md AGENTS.md .env.example docs/MEMORY.md docs/HANDOVER.md
git commit -m "docs: any-repo configuration and one-command setup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Live acceptance

**Files:**
- Modify: `docs/HANDOVER.md`, `README.md` (Status) with the results

- [ ] **Step 1: Re-run against the current install**

The re-run must send nothing secret. TrueForge and the triage MCP are already running here.

Run: `scripts/setup.sh --no-start; echo "exit $?"`
Expected:
- `✓ model provider openrouter: kept`, `✓ connector github: kept`, `✓ connector triage: kept`
- the agent updated, `✓ vishnuverse/humanize@main is protected`, `✓ labels present`
- doctor all `✓`, `ready.`, and `exit 0`

A `created` or `rotated` line here is a finding: stop and report it.

- [ ] **Step 2: Doctor with a smoke test**

Run: `scripts/setup.sh --check --smoke 1; echo "exit $?"`
Expected: `triage #1 on vishnuverse/humanize: defect · defect … patch allowed` and `exit 0`.

- [ ] **Step 3: Fresh clone**

```bash
T="$(mktemp -d)/shipgate" && git clone -q "$PWD" "$T" && cp .env "$T/.env" && cd "$T" && git checkout -q feat/any-repo \
  && scripts/setup.sh --no-start && scripts/score.sh TR-01; echo "exit $?"; cd - >/dev/null
```

Expected:
- `setup.sh` ends with `ready.`
- `score.sh TR-01` prints `# RESULT TR-01` with S8, S9 and S10 PASS; any failures are the known H4 habit only

Record the result.

- [ ] **Step 4: A second repo, only if the user named one**

1. Copy `shipgate.yaml` to a temporary file, set `target.*` and `python.*` for the user's repo, and export
   `SHIPGATE_CONFIG` to it.
2. Run `scripts/setup.sh --no-start --smoke <issue>`, then
   `npm --prefix orchestrator run shipgate -- run --issue <issue> --approve terminal`.
3. The user answers the gates.
4. Unset `SHIPGATE_CONFIG` and re-run `scripts/setup.sh --no-start` to put the demo agent back.

If the user named no repo, add the line "any-repo flow proven on the humanize fork only" to the README.

- [ ] **Step 5: Record and commit**

Update `docs/HANDOVER.md` and the README Status table with the results of Steps 1–4.

```bash
git add docs/HANDOVER.md README.md
git commit -m "docs: any-repo setup live acceptance results

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
