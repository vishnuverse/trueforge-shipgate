import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadScenario, parseScenario, ScriptCursor } from "../src/scenario.ts";

const TR10 = `id: TR-10
title: Human says REVISE at the PR gate
issue: 1
reset: true
timeout_min: 10
approvals:
  - {tool: create_pull_request, decision: deny, reason: "REVISE: start the PR title with 'fix(ordinal):'"}
  - {tool: create_pull_request, decision: allow}
  - {tool: add_issue_comment, decision: allow}
expect:
  status: ok
  outcome: fixed
`;

test("parse the contract's example scenario", () => {
  const s = parseScenario(TR10, "TR-10.yaml", "TR-10");
  assert.equal(s.id, "TR-10");
  assert.equal(s.issue, 1);
  assert.equal(s.timeoutMin, 10);
  assert.equal(s.approvals.length, 3);
  assert.deepEqual(s.approvals[0], {
    tool: "create_pull_request",
    decision: "deny",
    reason: "REVISE: start the PR title with 'fix(ordinal):'",
  });
  assert.deepEqual(s.approvals[1], { tool: "create_pull_request", decision: "allow" });
});

test("load from a scenarios dir; bad ids and mismatched ids are refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipgate-scen-"));
  writeFileSync(join(dir, "TR-10.yaml"), TR10);
  assert.equal(loadScenario(dir, "TR-10").approvals.length, 3);
  assert.throws(() => loadScenario(dir, "../etc/passwd"), /bad scenario id/);
  writeFileSync(join(dir, "TR-99.yaml"), TR10);
  assert.throws(() => loadScenario(dir, "TR-99"), /does not match/);
  assert.throws(() => parseScenario("approvals: [{tool: x, decision: maybe}]", "x.yaml"), /allow\|deny/);
});

test("a Jira scenario names ticket: instead of issue:", () => {
  const j01 = `id: TR-J01
ticket: KAN-4
timeout_min: 15
approvals:
  - {tool: create_pull_request, decision: allow}
  - {tool: addOrEditJiraIssueComment, decision: allow}
`;
  const s = parseScenario(j01, "TR-J01.yaml", "TR-J01");
  assert.equal(s.ticket, "KAN-4");
  assert.equal(s.issue, null);
  assert.deepEqual(
    s.approvals.map((a) => a.tool),
    ["create_pull_request", "addOrEditJiraIssueComment"],
  );
  assert.equal(parseScenario(TR10, "TR-10.yaml").ticket, null);
});

test("exactly one of issue / ticket; a ticket must look like a Jira key", () => {
  assert.throws(() => parseScenario("id: X\nissue: 1\nticket: KAN-4\n", "X.yaml"), /exactly one of issue/);
  assert.throws(() => parseScenario("id: X\napprovals: []\n", "X.yaml"), /exactly one of issue/);
  assert.throws(() => parseScenario("id: X\nticket: kan-4\n", "X.yaml"), /Jira key such as KAN-4/);
  assert.throws(() => parseScenario("id: X\nticket: 4\n", "X.yaml"), /Jira key such as KAN-4/);
});

test("script mode: entries are consumed in order", () => {
  const c = new ScriptCursor(parseScenario(TR10, "TR-10.yaml").approvals);
  assert.deepEqual(c.answer("create_pull_request"), {
    decision: "deny",
    reason: "REVISE: start the PR title with 'fix(ordinal):'",
    unexpected: false,
    expectedTool: "create_pull_request",
  });
  assert.equal(c.answer("create_pull_request").decision, "allow");
  assert.equal(c.answer("add_issue_comment").decision, "allow");
  assert.equal(c.remaining, 0);
});

test("script mode: a tool mismatch answers STOP, unexpected, and every later gate too", () => {
  const c = new ScriptCursor(parseScenario(TR10, "TR-10.yaml").approvals);
  assert.deepEqual(c.answer("add_issue_comment"), {
    decision: "deny",
    reason: "STOP",
    unexpected: true,
    expectedTool: "create_pull_request",
  });
  // even a tool that would have matched the next entry is now STOP
  assert.equal(c.answer("create_pull_request").unexpected, true);
});

test("script mode: an exhausted list answers STOP, unexpected", () => {
  const c = new ScriptCursor([{ tool: "get_me", decision: "allow" }]);
  assert.equal(c.answer("get_me").decision, "allow");
  assert.deepEqual(c.answer("get_me"), { decision: "deny", reason: "STOP", unexpected: true, expectedTool: null });
});

test("script mode: deny without a reason is sent as STOP", () => {
  const c = new ScriptCursor([{ tool: "get_me", decision: "deny" }]);
  assert.deepEqual(c.answer("get_me"), { decision: "deny", reason: "STOP", unexpected: false, expectedTool: "get_me" });
});
