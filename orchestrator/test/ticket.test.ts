import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../src/config.ts";
import {
  defaultAgent,
  jiraKickoff,
  parseJiraKey,
  requireJira,
  ticketId,
  ticketRef,
  ticketRunId,
  type Ticket,
} from "../src/ticket.ts";

// The committed shipgate.yaml (npm test pins SHIPGATE_CONFIG): vishnuverse/humanize + jira KAN.
const config = loadConfig();
const jira = requireJira(config);

test("jira keys: only upper-case keys of the configured project", () => {
  assert.equal(parseJiraKey("KAN-4", jira), "KAN-4");
  assert.equal(parseJiraKey("KAN-123", jira), "KAN-123");
  assert.throws(() => parseJiraKey("kan-4", jira), /not a KAN ticket key.*upper case: KAN-4/);
  assert.throws(() => parseJiraKey("SAM-4", jira), /not a KAN ticket key.*only project KAN is configured/);
  for (const bad of ["KAN-0", "KAN-", "KAN-4a", "4", "KAN 4", " KAN-4", "KAN-4\n", ""]) {
    assert.throws(() => parseJiraKey(bad, jira), /not a KAN ticket key/, JSON.stringify(bad));
  }
});

test("jira kickoff: the exact first message the Jira skill parses", () => {
  assert.equal(
    jiraKickoff("KAN-4", config, "terminal", "2026-09-26"),
    "Resolve Jira ticket KAN-4 (https://developertunnel.atlassian.net/browse/KAN-4) for the GitHub repo " +
      "vishnuverse/humanize. cloudId: ce61dd8b-2e04-4815-9b7b-60a570df782b. Branch: fix/kan-4. " +
      "Test file: tests/test_kan_4.py. Approval mode: terminal. Today is 2026-09-26.",
  );
  assert.match(
    jiraKickoff("KAN-12", config, "script", "2026-09-27"),
    /Branch: fix\/kan-12\. Test file: tests\/test_kan_12\.py\. Approval mode: script\. Today is 2026-09-27\.$/,
  );
  assert.throws(() => jiraKickoff("kan-4", config, "terminal", "2026-09-26"), /upper case/);
});

test("no jira section: a ConfigError (the CLI exits 2)", () => {
  const github = { ...config, jira: null };
  assert.throws(() => requireJira(github), (e: unknown) => e instanceof ConfigError && /jira: not configured/.test(e.message));
  assert.throws(() => jiraKickoff("KAN-4", github, "terminal", "2026-09-26"), ConfigError);
});

test("ref, run id, label id and default agent per source", () => {
  const gh: Ticket = { source: "github", number: 1 };
  const jr: Ticket = { source: "jira", key: "KAN-4" };
  assert.equal(ticketRef(gh, "vishnuverse/humanize"), "vishnuverse/humanize#1");
  assert.equal(ticketRef(jr, "vishnuverse/humanize"), "KAN-4");
  assert.equal(ticketRunId(gh), "issue-1");
  assert.equal(ticketRunId(jr), "KAN-4");
  assert.equal(ticketRunId(jr, "TR-J01"), "TR-J01");
  assert.equal(ticketId(gh), 1);
  assert.equal(ticketId(jr), "KAN-4");
  assert.equal(defaultAgent(gh), "ticket-resolver");
  assert.equal(defaultAgent(jr), "ticket-resolver-jira");
});
