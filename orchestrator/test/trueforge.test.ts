import assert from "node:assert/strict";
import { test } from "node:test";
import { TrueForgeClient } from "../src/trueforge.ts";

interface Seen {
  method: string;
  url: URL;
  body: unknown;
}

function fakeFetch(handler: (req: Seen) => unknown) {
  const seen: Seen[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const raw = init?.body;
    const body = typeof raw === "string" && raw !== "" ? (JSON.parse(raw) as unknown) : undefined;
    const req = { method: init?.method ?? "GET", url, body };
    seen.push(req);
    return new Response(JSON.stringify(handler(req)), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fn, seen };
}

test("listEvents merges pages (newest first) into one oldest-first list, verbatim", async () => {
  const ev = (n: number) => ({ turn_id: "t1", event: { type: "model.message", id: `e${n}`, tool_calls: [], thread_id: "main" } });
  const f = fakeFetch(({ url }) =>
    url.searchParams.get("page_token") === "p2"
      ? { data: [ev(1)], pagination: { limit: 100 } }
      : { data: [ev(3), ev(2)], pagination: { limit: 100, next_page_token: "p2" } },
  );
  const tf = new TrueForgeClient("http://localhost:8790", f.fn);
  const out = await tf.listEvents("s1");
  assert.deepEqual(out, [ev(1), ev(2), ev(3)]);
  assert.equal(f.seen.length, 2);
  assert.equal(f.seen[0]?.url.pathname, "/api/v1/sessions/s1/events");
  assert.equal(f.seen[0]?.url.searchParams.get("limit"), "100");
  assert.equal(f.seen[1]?.url.searchParams.get("page_token"), "p2");
});

test("createTurn sends approvals in wire format through the SDK", async () => {
  const f = fakeFetch(() => ({
    data: { id: "t9", session_id: "s1", created_at: "2026-09-26T00:00:00Z", previous_turn_id: "t8", state: { status: "running" } },
  }));
  const tf = new TrueForgeClient("http://localhost:8790", f.fn);
  const id = await tf.createTurn("s1", [
    { type: "user.tool_approval", thread_id: "main", tool_call_id: "call_1", approval: { status: "deny", reason: "REVISE: x" } },
    { type: "user.tool_approval", thread_id: "main", tool_call_id: "call_2", approval: { status: "allow" } },
  ]);
  assert.equal(id, "t9");
  assert.equal(f.seen[0]?.method, "POST");
  assert.equal(f.seen[0]?.url.pathname, "/api/v1/sessions/s1/turns");
  assert.deepEqual(f.seen[0]?.body, {
    input: [
      { type: "user.tool_approval", thread_id: "main", tool_call_id: "call_1", approval: { status: "deny", reason: "REVISE: x" } },
      { type: "user.tool_approval", thread_id: "main", tool_call_id: "call_2", approval: { status: "allow" } },
    ],
    stream: false,
  });
});

test("createSession passes a snake_case inline spec through unchanged", async () => {
  const f = fakeFetch(() => ({ data: { id: "s7", agent: { type: "inline", spec: { model: { name: "m" } } }, created_at: "x", updated_at: "x" } }));
  const tf = new TrueForgeClient("http://localhost:8790", f.fn);
  const spec = {
    model: { name: "google-gemini/gemini-3-6-flash", params: { reasoning_effort: "high" } },
    instructions: "x",
    mcp_servers: [{ name: "github", enable_tools: ["get_me"], require_approval_for_tools: ["get_me"] }],
    config: { sandbox: { enabled: true }, iteration_limit: 60 },
  };
  assert.equal(await tf.createSession({ spec }, { issue: "1" }), "s7");
  assert.deepEqual(f.seen[0]?.body, { agent: { spec }, metadata: { issue: "1" } });
  await tf.createSession({ name: "ticket-resolver" }, {});
  assert.deepEqual(f.seen[1]?.body, { agent: { name: "ticket-resolver" }, metadata: {} });
});

test("listTurns maps SDK turns back to wire-format input items", async () => {
  const f = fakeFetch(() => ({
    data: [
      {
        id: "t2",
        session_id: "s1",
        created_at: "2026-09-26T00:00:02Z",
        previous_turn_id: "t1",
        input: [{ type: "user.tool_approval", thread_id: "main", tool_call_id: "call_1", approval: { status: "allow" } }],
        state: { status: "running" },
      },
    ],
    pagination: { limit: 25 },
  }));
  const tf = new TrueForgeClient("http://localhost:8790", f.fn);
  assert.deepEqual(await tf.listTurns("s1"), [
    {
      turnId: "t2",
      previousTurnId: "t1",
      createdAt: "2026-09-26T00:00:02Z",
      input: [{ type: "user.tool_approval", thread_id: "main", tool_call_id: "call_1", approval: { status: "allow" } }],
    },
  ]);
});
