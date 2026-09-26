import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderGate,
  sanitize,
  ScriptDecider,
  TerminalDecider,
  UiDecider,
  type GateContext,
  type LineReader,
} from "../src/decide.ts";
import type { TurnInputRecord } from "../src/events.ts";

function ctx(over: Partial<GateContext> = {}): GateContext {
  return {
    sessionId: "s1",
    gatedTurnId: "t1",
    gate: {
      toolCallId: "call_1",
      threadId: "main",
      sourceEventId: "ev1",
      turnId: "t1",
      mcpServer: "github",
      tool: "create_pull_request",
      functionName: "call_tool",
      input: { title: "fix(ordinal): 12th", body: "x".repeat(2000) },
      argsSha256: "fb4b7e1382b28cbd8d0789701b5a0ee69efec57b9d487c5fbcc84abef0ce27f4",
      rawArguments: "{}",
    },
    evidence: "EVIDENCE · gh#1 · drax0945/humanize @ 392aef7",
    gateNumber: 1,
    uiUrl: "http://localhost:8790/sessions/s1",
    ...over,
  };
}

/** Feeds scripted lines; null = end of input. Records prompts and output. */
function fakeIO(lines: (string | null)[]): LineReader & { out: string[]; prompts: string[] } {
  const out: string[] = [];
  const prompts: string[] = [];
  return {
    out,
    prompts,
    print: (t) => out.push(t),
    readLine: async (prompt) => {
      prompts.push(prompt);
      if (lines.length === 0) return null;
      return lines.shift() as string | null;
    },
  };
}

const signal = new AbortController().signal;

test("terminal: approve", async () => {
  const io = fakeIO(["a"]);
  assert.deepEqual(await new TerminalDecider(io).decide(ctx(), signal), {
    decision: "allow",
    reason: null,
    unexpected: false,
  });
  const shown = io.out.join("\n");
  assert.match(shown, /GATE 1 · github\/create_pull_request · call_1/);
  assert.match(shown, /EVIDENCE · gh#1/);
  assert.match(shown, /\+1400 chars/); // long input values are shortened on the card
  assert.match(io.prompts[0] ?? "", /\[a\]pprove {2}\[r\]evise {2}\[e\]dit {2}\[s\]top {2}\[v\]iew full input/);
});

test("terminal: revise asks for a note", async () => {
  const io = fakeIO(["r", "  start the PR title with 'fix(ordinal):'  "]);
  assert.deepEqual(await new TerminalDecider(io).decide(ctx(), signal), {
    decision: "deny",
    reason: "REVISE: start the PR title with 'fix(ordinal):'",
    unexpected: false,
  });
});

test("terminal: revise with an empty note goes back to the menu", async () => {
  const io = fakeIO(["r", "", "s"]);
  const d = await new TerminalDecider(io).decide(ctx(), signal);
  assert.equal(d.reason, "STOP");
});

test("terminal: edit reads lines until a lone '.'", async () => {
  const io = fakeIO(["e", "Thanks for the report!", "", "Fixed in the linked PR.", "."]);
  assert.deepEqual(await new TerminalDecider(io).decide(ctx(), signal), {
    decision: "deny",
    reason: "EDIT: Thanks for the report!\n\nFixed in the linked PR.",
    unexpected: false,
  });
});

test("terminal: stop", async () => {
  assert.deepEqual(await new TerminalDecider(fakeIO(["s"])).decide(ctx(), signal), {
    decision: "deny",
    reason: "STOP",
    unexpected: false,
  });
});

test("terminal: view prints the full input, bad answers re-prompt", async () => {
  const io = fakeIO(["v", "maybe", "APPROVE"]);
  const d = await new TerminalDecider(io).decide(ctx(), signal);
  assert.equal(d.decision, "allow");
  assert.ok(io.out.some((l) => l.includes("x".repeat(2000))));
  assert.ok(io.out.some((l) => l.startsWith("Answer a, r, e, s or v")));
  assert.equal(io.prompts.length, 3);
});

test("terminal: end of input answers STOP (never allow)", async () => {
  assert.equal((await new TerminalDecider(fakeIO([])).decide(ctx(), signal)).reason, "STOP");
  assert.equal((await new TerminalDecider(fakeIO(["e", "half a reply"])).decide(ctx(), signal)).reason, "STOP");
});

test("terminal: evidence is sanitised (no escape sequences or zero-width chars)", () => {
  const card = renderGate(ctx({ evidence: "ok\u001b[2J\u001b[31mred\u200b\u0007 done" }));
  assert.match(card, /okred done/);
  assert.equal(sanitize("a\u202eb\tc\nd"), "ab\tc\nd");
});

test("script decider reports unexpected gates", async () => {
  const out: string[] = [];
  const d = new ScriptDecider([{ tool: "create_pull_request", decision: "allow" }], { print: (t) => out.push(t) });
  assert.equal((await d.decide(ctx())).decision, "allow");
  const second = await d.decide(ctx({ gateNumber: 2 }));
  assert.deepEqual(second, { decision: "deny", reason: "STOP", unexpected: true, expectedTool: null });
  assert.match(out[1] ?? "", /UNEXPECTED/);
});

test("ui: polls turns until the approval for this tool call appears", async () => {
  let polls = 0;
  const later: TurnInputRecord = {
    turnId: "t2",
    previousTurnId: "t1",
    createdAt: "2026-09-26T12:00:00.000Z",
    input: [
      {
        type: "user.tool_approval",
        thread_id: "main",
        tool_call_id: "call_1",
        approval: { status: "deny", reason: "REVISE: shorter title" },
      },
    ],
  };
  const listTurns = async (): Promise<TurnInputRecord[]> => {
    polls++;
    if (polls === 1) throw new Error("ECONNRESET");
    if (polls < 3) return [{ turnId: "t1", previousTurnId: null, createdAt: null, input: [] }];
    return [later];
  };
  const out: string[] = [];
  const d = await new UiDecider(listTurns, { print: (t) => out.push(t) }, 5).decide(ctx(), signal);
  assert.deepEqual(d, {
    decision: "deny",
    reason: "REVISE: shorter title",
    unexpected: false,
    submittedTurnId: "t2",
    submittedAt: "2026-09-26T12:00:00.000Z",
  });
  assert.equal(polls, 3);
  assert.ok(out.some((l) => l === "Decide in TrueForge: http://localhost:8790/sessions/s1"));
  assert.ok(out.some((l) => l.startsWith("warning: could not list turns")));
});

test("ui: gives up when the run is aborted (timeout)", async () => {
  const ac = new AbortController();
  const p = new UiDecider(async () => [], { print: () => {} }, 5).decide(ctx(), ac.signal);
  setTimeout(() => ac.abort(new Error("deadline")), 20);
  await assert.rejects(p, /deadline/);
});

test("gate shows the evidence card from the PR body in full, even past the input truncation", () => {
  const cardText = [
    "EVIDENCE · gh#1 · drax0945/humanize @ 3145c20",
    "Repro before patch : 3/3 fail  (assert '12nd' == '12th')",
    "Next action        : create_pull_request fix/issue-1 → main  (reply follows, gated separately)",
  ].join("\n");
  const body = "Fixes #1\n\n" + "summary ".repeat(120) + "\n\n```text\n" + cardText + "\n```\n\ntail";
  const base = ctx();
  const shown = renderGate(ctx({ evidence: "Now for Gate 1.", gate: { ...base.gate, input: { title: "t", body } } }));
  assert.match(shown, /--- evidence card \(from the PR body\) ---/);
  assert.ok(shown.includes(cardText), shown);
});

test("gate without a card in the body adds no card section", () => {
  const shown = renderGate(ctx({ evidence: "hi" }));
  assert.doesNotMatch(shown, /evidence card \(from the PR body\)/);
});
