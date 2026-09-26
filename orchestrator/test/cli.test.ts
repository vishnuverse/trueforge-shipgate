import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultPrompt,
  kickoff,
  parseCli,
  resolveTarget,
  resolveTimeoutMin,
  resolveTrueforgeUrl,
  UsageError,
} from "../src/cli.ts";
import { ConfigError, loadConfig } from "../src/config.ts";
import { parseDotenv } from "../src/env.ts";
import { uiSessionUrl, utcStamp } from "../src/runner.ts";
import type { Scenario } from "../src/scenario.ts";

test("cli: defaults", () => {
  assert.deepEqual(parseCli(["run", "--issue", "1"]), {
    issue: 1,
    ticket: null,
    mode: "terminal",
    scenario: null,
    agent: null, // not given: resolveTarget picks the source's agent (ticket-resolver for --issue)
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

test("TrueForge URL: env TRUEFORGE_URL overrides shipgate.yaml trueforge.url; trailing slashes dropped", () => {
  assert.equal(resolveTrueforgeUrl(undefined, "http://tf.example:9000/"), "http://tf.example:9000");
  assert.equal(resolveTrueforgeUrl("", "http://tf.example:9000"), "http://tf.example:9000");
  assert.equal(resolveTrueforgeUrl("http://localhost:8790//", "http://tf.example:9000"), "http://localhost:8790");
});

test("the kickoff prompt names the configured repo", () => {
  assert.equal(
    defaultPrompt(7, "script", "2026-09-26", "acme/widgets"),
    "Resolve GitHub issue #7 in acme/widgets. Approval mode: script. Today is 2026-09-26.",
  );
});

// ---------- --ticket (Jira) ----------

const config = loadConfig(); // committed shipgate.yaml: vishnuverse/humanize + jira KAN
const scenario = (over: Partial<Scenario>): Scenario => ({
  id: "TR-X",
  issue: null,
  ticket: null,
  timeoutMin: null,
  approvals: [],
  path: "TR-X.yaml",
  ...over,
});

test("cli: --ticket parses; the agent stays unset until the source is known", () => {
  const a = parseCli(["run", "--ticket", "KAN-4"]);
  assert.equal(a.ticket, "KAN-4");
  assert.equal(a.issue, null);
  assert.equal(a.agent, null);
  assert.equal(parseCli(["run", "--ticket", "KAN-4", "--agent", "mine"]).agent, "mine");
});

test("cli: exactly one of --issue / --ticket (neither only with a scenario that names one)", () => {
  assert.throws(() => parseCli(["run", "--issue", "1", "--ticket", "KAN-4"]), /not both/);
  assert.throws(() => parseCli(["run"]), /--issue <n> or --ticket <KEY> is required/);
  assert.throws(() => parseCli(["run", "--approve", "ui"]), /--issue <n> or --ticket <KEY> is required/);
  assert.throws(() => parseCli(["run", "--ticket", ""]), /Jira key such as KAN-4/);
  assert.throws(() => parseCli(["run", "--issue", "1", "--agent", ""]), /--agent must not be empty/);
  const s = parseCli(["run", "--approve", "script", "--scenario", "TR-J01"]);
  assert.equal(s.issue, null);
  assert.equal(s.ticket, null);
});

test("agent default per source; --agent wins", () => {
  assert.deepEqual(resolveTarget(parseCli(["run", "--issue", "1"]), null, config), {
    ticket: { source: "github", number: 1 },
    agent: "ticket-resolver",
  });
  assert.deepEqual(resolveTarget(parseCli(["run", "--ticket", "KAN-4"]), null, config), {
    ticket: { source: "jira", key: "KAN-4" },
    agent: "ticket-resolver-jira",
  });
  assert.equal(resolveTarget(parseCli(["run", "--ticket", "KAN-4", "--agent", "other"]), null, config).agent, "other");
  assert.equal(resolveTarget(parseCli(["run", "--issue", "2", "--agent", "other"]), null, config).agent, "other");
});

test("--ticket: bad keys are usage errors; no jira section is a config error (exit 2)", () => {
  assert.throws(
    () => resolveTarget(parseCli(["run", "--ticket", "kan-4"]), null, config),
    (e: unknown) => e instanceof UsageError && /upper case: KAN-4/.test(e.message),
  );
  assert.throws(() => resolveTarget(parseCli(["run", "--ticket", "SAM-4"]), null, config), /only project KAN/);
  assert.throws(
    () => resolveTarget(parseCli(["run", "--ticket", "KAN-4"]), null, { ...config, jira: null }),
    (e: unknown) => e instanceof ConfigError && /jira: not configured/.test(e.message),
  );
  // a GitHub run never needs the jira section
  assert.equal(resolveTarget(parseCli(["run", "--issue", "1"]), null, { ...config, jira: null }).agent, "ticket-resolver");
});

test("a scenario names its ticket; the flag must match it", () => {
  const j01 = scenario({ id: "TR-J01", ticket: "KAN-4" });
  const tr01 = scenario({ id: "TR-01", issue: 1 });
  const script = (...more: string[]) => parseCli(["run", "--approve", "script", "--scenario", "TR-X", ...more]);
  assert.deepEqual(resolveTarget(script(), j01, config), {
    ticket: { source: "jira", key: "KAN-4" },
    agent: "ticket-resolver-jira",
  });
  assert.deepEqual(resolveTarget(script("--ticket", "KAN-4"), j01, config).ticket, { source: "jira", key: "KAN-4" });
  assert.throws(
    () => resolveTarget(script("--ticket", "KAN-5"), j01, config),
    /--ticket KAN-5 does not match scenario TR-J01 \(ticket KAN-4\)/,
  );
  assert.throws(() => resolveTarget(script("--issue", "4"), j01, config), /--issue 4 does not match scenario TR-J01 \(ticket KAN-4\)/);
  assert.throws(() => resolveTarget(script("--ticket", "KAN-1"), tr01, config), /--ticket KAN-1 does not match scenario TR-01 \(issue 1\)/);
  // the GitHub checks behave as before
  assert.throws(() => resolveTarget(script("--issue", "2"), tr01, config), /--issue 2 does not match scenario TR-01 \(issue 1\)/);
  assert.deepEqual(resolveTarget(script(), tr01, config), { ticket: { source: "github", number: 1 }, agent: "ticket-resolver" });
});

test("kickoff: GitHub prompt unchanged, Jira the exact kickoff", () => {
  assert.equal(
    kickoff({ source: "github", number: 7 }, "script", "2026-09-26", config),
    defaultPrompt(7, "script", "2026-09-26", "vishnuverse/humanize"),
  );
  assert.equal(
    kickoff({ source: "jira", key: "KAN-4" }, "terminal", "2026-09-26", config),
    "Resolve Jira ticket KAN-4 (https://developertunnel.atlassian.net/browse/KAN-4) for the GitHub repo " +
      "vishnuverse/humanize. cloudId: ce61dd8b-2e04-4815-9b7b-60a570df782b. Branch: fix/kan-4. " +
      "Test file: tests/test_kan_4.py. Approval mode: terminal. Today is 2026-09-26.",
  );
});
