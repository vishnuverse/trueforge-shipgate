import assert from "node:assert/strict";
import { test } from "node:test";
import { argsSha256 } from "../src/canonical.ts";
import {
  evidenceBefore,
  findApprovalDecision,
  lastModelMessage,
  pendingFromRequiredActions,
  resolveGate,
  turnsFromEvents,
  type EventItem,
} from "../src/events.ts";
import { extractHandoff, parsePrefix } from "../src/protocol.ts";
import { DECISION_TURN, GATED_TURN, loadFixture } from "./helpers.ts";

function gatedTurnDone(events: EventItem[]) {
  const done = events.find((e) => e.turn_id === GATED_TURN && e.event.type === "turn.done");
  assert.ok(done);
  return (done.event.state as { required_actions: unknown[] }).required_actions;
}

test("fixture: pending approval from turn.done required_actions (wire, snake_case)", () => {
  const { pending, other } = pendingFromRequiredActions(gatedTurnDone(loadFixture()));
  assert.deepEqual(other, []);
  assert.deepEqual(pending, [
    { threadId: "main", toolCallId: "call_233096", sourceEventId: "01m3d0h2tt8ffbqsjz5fmtt1nt" },
  ]);
});

test("required_actions from the SDK (camelCase) parse the same; other actions are reported", () => {
  const { pending, other } = pendingFromRequiredActions([
    { type: "tool.approval_required", threadId: "main", toolCalls: [{ id: "call_1", sourceEventId: "ev1" }] },
    { type: "mcp.auth_required" },
  ]);
  assert.deepEqual(pending, [{ threadId: "main", toolCallId: "call_1", sourceEventId: "ev1" }]);
  assert.deepEqual(other, ["mcp.auth_required"]);
});

test("fixture: gate resolves to github / get_me via call_tool", () => {
  const events = loadFixture();
  const [p] = pendingFromRequiredActions(gatedTurnDone(events)).pending;
  assert.ok(p);
  const g = resolveGate(events, p);
  assert.equal(g.tool, "get_me");
  assert.equal(g.mcpServer, "github");
  assert.equal(g.toolCallId, "call_233096");
  assert.equal(g.functionName, "call_tool");
  assert.equal(g.turnId, GATED_TURN);
  assert.equal(g.threadId, "main");
  assert.deepEqual(g.input, {});
  assert.equal(g.argsSha256, argsSha256({}));
});

test("gate lookup falls back to searching all messages when source_event_id is missing", () => {
  const events = loadFixture();
  const g = resolveGate(events, { threadId: "main", toolCallId: "call_233096", sourceEventId: null });
  assert.equal(g.tool, "get_me");
  assert.throws(() => resolveGate(events, { threadId: "main", toolCallId: "call_nope", sourceEventId: null }), /not found/);
});

test("direct MCP function names use tool_info and hash the whole argument object", () => {
  const events: EventItem[] = [
    {
      turn_id: "t1",
      event: {
        type: "model.message",
        id: "ev1",
        content: "EVIDENCE · gh#1 · vishnuverse/humanize @ 392aef7",
        tool_calls: [
          {
            id: "call_9",
            function: { name: "create_pull_request", arguments: '{"owner":"vishnuverse","repo":"humanize","draft":false,"n":1.0}' },
            tool_info: { type: "mcp", name: "create_pull_request", server_name: "github", server_id: "x" },
          },
        ],
      },
    },
  ];
  const g = resolveGate(events, { threadId: "main", toolCallId: "call_9", sourceEventId: "ev1" });
  assert.equal(g.mcpServer, "github");
  assert.equal(g.tool, "create_pull_request");
  // 1.0 stays a float, as Python would keep it: {"draft":false,"n":1.0,"owner":"vishnuverse","repo":"humanize"}
  assert.equal(g.argsSha256, "e0553f586988e45a7826803e6647456e59fb5b199849bb11b4e56de6ee3fbd86");
  assert.notEqual(g.argsSha256, argsSha256({ owner: "vishnuverse", repo: "humanize", draft: false, n: 1 }));
  assert.equal(evidenceBefore(events, "ev1"), "EVIDENCE · gh#1 · vishnuverse/humanize @ 392aef7");
});

test("fixture: no evidence text before the gate (tool-call-only messages)", () => {
  assert.equal(evidenceBefore(loadFixture(), "01m3d0h2tt8ffbqsjz5fmtt1nt"), null);
});

test("evidence is the latest non-empty model.message at or before the gated call", () => {
  const events: EventItem[] = [
    { turn_id: "t", event: { type: "model.message", id: "a", content: "old card" } },
    { turn_id: "t", event: { type: "model.message", id: "b", content: "EVIDENCE card" } },
    { turn_id: "t", event: { type: "tool.response", id: "c", tool_call_id: "x", content: "{}" } },
    { turn_id: "t", event: { type: "model.message", id: "d", content: null, tool_calls: [] } },
    { turn_id: "t", event: { type: "model.message", id: "e", content: "after" } },
  ];
  assert.equal(evidenceBefore(events, "d"), "EVIDENCE card");
});

test("fixture: the deny decision is found in the later turn.created", () => {
  const turns = turnsFromEvents(loadFixture());
  assert.equal(turns.length, 2);
  const d = findApprovalDecision(turns, "call_233096", GATED_TURN);
  assert.deepEqual(d, {
    turnId: DECISION_TURN,
    createdAt: "2026-09-25T19:26:46.611Z",
    decision: "deny",
    reason: "setup smoke test: gate verified, not needed",
  });
  assert.equal(parsePrefix(d.decision, d.reason), "NONE");
  assert.equal(findApprovalDecision(turns, "call_other", GATED_TURN), null);
});

test("fixture: final message of the last turn; its json block is not a handoff", () => {
  const events = loadFixture();
  const text = lastModelMessage(events, DECISION_TURN);
  assert.ok(text?.startsWith("### Step 1: Sandbox Command Raw Output"));
  assert.equal(lastModelMessage(events, GATED_TURN), null); // tool-call messages carry no content
  const h = extractHandoff(text);
  assert.equal(h.ok, false);
  assert.match((h as { error: string }).error, /missing stage, status, outcome/);
});
