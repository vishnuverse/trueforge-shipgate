import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPrompt, parseCli, resolveTimeoutMin } from "../src/cli.ts";
import { parseDotenv } from "../src/env.ts";
import { uiSessionUrl, utcStamp } from "../src/runner.ts";

test("cli: defaults", () => {
  assert.deepEqual(parseCli(["run", "--issue", "1"]), {
    issue: 1,
    mode: "terminal",
    scenario: null,
    agent: "ticket-resolver",
    timeoutMin: null,
    inlineSpec: null,
    prompt: null,
    labels: true,
  });
});

test("cli: all flags", () => {
  const a = parseCli([
    "run",
    "--issue=3",
    "--approve",
    "script",
    "--scenario",
    "TR-03",
    "--agent",
    "other",
    "--timeout-min",
    "2.5",
    "--inline-spec",
    "spec.json",
    "--prompt",
    "hi",
    "--no-labels",
  ]);
  assert.equal(a.mode, "script");
  assert.equal(a.scenario, "TR-03");
  assert.equal(a.timeoutMin, 2.5);
  assert.equal(a.inlineSpec, "spec.json");
  assert.equal(a.prompt, "hi");
  assert.equal(a.labels, false);
});

test("cli: refusals", () => {
  assert.throws(() => parseCli([]), /usage/);
  assert.throws(() => parseCli(["go", "--issue", "1"]), /usage/);
  assert.throws(() => parseCli(["run", "--issue", "1", "--approve", "auto"]), /ui, terminal or script/);
  assert.throws(() => parseCli(["run", "--issue", "1", "--approve", "script"]), /requires --scenario/);
  assert.throws(() => parseCli(["run", "--issue", "0"]), /positive integer/);
  assert.throws(() => parseCli(["run", "--issue", "1", "--timeout-min", "0"]), /> 0/);
  assert.throws(() => parseCli(["run", "--issue", "1", "--bogus"]));
});

test("first message and UI link", () => {
  assert.equal(
    defaultPrompt(7, "script", "2026-09-26"),
    "Resolve GitHub issue #7 in vishnuverse/humanize. Approval mode: script. Today is 2026-09-26.",
  );
  assert.equal(uiSessionUrl("http://localhost:8790/", "01abc"), "http://localhost:8790/sessions/01abc");
  assert.equal(utcStamp(new Date("2026-09-26T07:04:05.678Z")), "20260926T070405Z");
});

test(".env parsing", () => {
  assert.deepEqual(
    parseDotenv(
      ["# comment", "", "TRUEFORGE_URL=http://localhost:8790", "export GITHUB_PAT='abc#1'", 'X="a b" ', "Y=z # trailing", "bad line"].join(
        "\n",
      ),
    ),
    { TRUEFORGE_URL: "http://localhost:8790", GITHUB_PAT: "abc#1", X: "a b", Y: "z" },
  );
});

test("timeout: explicit flag wins, then the scenario, then a human-friendly default", () => {
  assert.equal(resolveTimeoutMin(30, 15, "ui"), 30);
  assert.equal(resolveTimeoutMin(null, 15, "script"), 15);
  // The deadline keeps running while a person reads the approval card, so human modes get room.
  assert.equal(resolveTimeoutMin(null, null, "ui"), 60);
  assert.equal(resolveTimeoutMin(null, null, "terminal"), 60);
});
