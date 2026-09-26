import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ConfigError, ROOT, configPath, loadConfig } from "../src/config.ts";

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

test("a git-ignored shipgate.local.yaml overrides the committed file; SHIPGATE_CONFIG overrides both", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipgate-"));
  writeFileSync(join(dir, "shipgate.yaml"), readFileSync(join(FIXTURES, "valid.yaml"), "utf8"));
  const before = process.env.SHIPGATE_CONFIG;
  delete process.env.SHIPGATE_CONFIG;
  try {
    assert.equal(configPath(dir), join(dir, "shipgate.yaml"));
    writeFileSync(join(dir, "shipgate.local.yaml"), readFileSync(join(FIXTURES, "valid-dotted-repo.yaml"), "utf8"));
    assert.equal(configPath(dir), join(dir, "shipgate.local.yaml"));
    assert.equal(loadConfig(configPath(dir)).repo, "acme/my.pkg_x");
    process.env.SHIPGATE_CONFIG = join(dir, "shipgate.yaml");
    assert.equal(configPath(dir), join(dir, "shipgate.yaml"));
  } finally {
    if (before === undefined) delete process.env.SHIPGATE_CONFIG;
    else process.env.SHIPGATE_CONFIG = before;
  }
});

