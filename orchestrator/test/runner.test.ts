import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { argsSha256 } from "../src/canonical.ts";
import { ScriptDecider, type Decider } from "../src/decide.ts";
import type { EventItem } from "../src/events.ts";
import type { LabelOps } from "../src/labels.ts";
import { NUDGE, runOnce, type RunOptions } from "../src/runner.ts";
import type { AgentRef, TrueForgeApi, TurnInfo, TurnInput } from "../src/trueforge.ts";
import { DECISION_TURN, GATED_TURN, loadFixture } from "./helpers.ts";

const HANDOFF = { stage: "resolve", status: "ok", outcome: "stopped", reason: "human said STOP" };

/** Replays the real fixture: turn 1 pauses on github/get_me, the resume turn finishes. */
class FakeTrueForge implements TrueForgeApi {
  created: { agent: AgentRef; metadata: Record<string, string> }[] = [];
  turnInputs: TurnInput[][] = [];
  cancelled = 0;
  private resumed = false;

  constructor(
    private readonly events: EventItem[],
    private readonly hang = false,
  ) {}

  async createSession(agent: AgentRef, metadata: Record<string, string>): Promise<string> {
    this.created.push({ agent, metadata });
    return "sess_fixture";
  }
  async createTurn(_s: string, input: TurnInput[]): Promise<string> {
    this.turnInputs.push(input);
    if (this.turnInputs.length === 1) return GATED_TURN;
    this.resumed = true;
    return DECISION_TURN;
  }
  async waitForTurn(_s: string, turnId: string, signal: AbortSignal): Promise<TurnInfo> {
    if (this.hang) {
      await new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    return this.getTurn(_s, turnId);
  }
  async getTurn(_s: string, turnId: string): Promise<TurnInfo> {
    if (this.cancelled > 0) return { id: turnId, status: "cancelled", requiredActions: [], outputText: null, errorMessage: null };
    const done = this.events.find((e) => e.turn_id === turnId && e.event.type === "turn.done");
    if (this.hang || !done) return { id: turnId, status: "running", requiredActions: [], outputText: null, errorMessage: null };
    const state = done.event.state as { required_actions: unknown[]; output: { content: string } | null };
    return {
      id: turnId,
      status: "done",
      requiredActions: state.required_actions,
      outputText: state.output?.content ?? null,
      errorMessage: null,
    };
  }
  async listEvents(): Promise<EventItem[]> {
    return this.resumed ? this.events : this.events.filter((e) => e.turn_id === GATED_TURN);
  }
  async listTurns() {
    return [];
  }
  async cancel(): Promise<void> {
    this.cancelled++;
  }
}

function withFinalMessage(events: EventItem[], content: string): EventItem[] {
  const copy = structuredClone(events);
  for (let k = copy.length - 1; k >= 0; k--) {
    const e = copy[k] as EventItem;
    if (e.event.type === "model.message") {
      e.event.content = content;
      break;
    }
  }
  return copy;
}

function options(root: string, over: Partial<RunOptions> = {}): RunOptions {
  return {
    issue: 1,
    mode: "script",
    scenarioId: "TR-DEV",
    agent: { spec: { model: { name: "m" } } },
    agentLabel: "inline:test",
    prompt: "Call the github get_me tool now.",
    timeoutMin: 1,
    repoRoot: root,
    trueforgeUrl: "http://localhost:8790",
    repo: "vishnuverse/humanize",
    ...over,
  };
}

function readRun(runDir: string) {
  const read = (f: string) => readFileSync(join(runDir, f), "utf8");
  return {
    files: readdirSync(runDir).sort(),
    meta: JSON.parse(read("meta.json")) as Record<string, unknown>,
    events: JSON.parse(read("events.json")) as EventItem[],
    handoff: JSON.parse(read("handoff.json")) as unknown,
    final: read("final_message.md"),
    approvals: read("approvals.jsonl"),
  };
}

const quiet = () => {};

test("script run on the fixture: STOP relayed, files written, no handoff -> exit 4", async () => {
  const root = mkdtempSync(join(tmpdir(), "shipgate-run-"));
  const fixture = loadFixture();
  const tf = new FakeTrueForge(fixture);
  const decider = new ScriptDecider([{ tool: "get_me", decision: "deny", reason: "STOP" }], { print: quiet });
  const res = await runOnce(options(root), { tf, decider, labels: null, log: quiet });

  assert.equal(res.status, "no_handoff");
  assert.equal(res.exitCode, 4);
  assert.match(res.runDir, /runs\/TR-DEV\/\d{8}T\d{6}Z$/);
  // the resume turn carries exactly the scripted answer; the fixture never writes a handoff, so two nudges follow
  assert.equal(readRun(res.runDir).meta.nudges, 2);
  assert.deepEqual(tf.turnInputs.slice(2), [
    [{ type: "user.message", content: NUDGE }],
    [{ type: "user.message", content: NUDGE }],
  ]);
  assert.deepEqual(tf.turnInputs.slice(0, 2), [
    [{ type: "user.message", content: "Call the github get_me tool now." }],
    [
      {
        type: "user.tool_approval",
        thread_id: "main",
        tool_call_id: "call_233096",
        approval: { status: "deny", reason: "STOP" },
      },
    ],
  ]);
  assert.equal(tf.created[0]?.metadata.shipgate_run_id, "TR-DEV");

  const run = readRun(res.runDir);
  assert.deepEqual(run.files, ["approvals.jsonl", "events.json", "final_message.md", "handoff.json", "meta.json"]);
  assert.deepEqual(run.events, fixture); // oldest first, exactly as the API returned them
  assert.equal(run.handoff, null);
  assert.ok(run.final.startsWith("### Step 1"));
  assert.equal(run.meta.status, "no_handoff");
  assert.equal(run.meta.exit_code, 4);
  assert.equal(run.meta.session_id, "sess_fixture");
  const turnIds = run.meta.turn_ids as string[];
  assert.deepEqual(turnIds.slice(0, 2), [GATED_TURN, DECISION_TURN]);
  assert.equal(turnIds.length, 4); // + 2 nudge turns
  assert.equal(run.meta.unexpected_gate, false);
  for (const k of ["run_id", "scenario", "issue", "repo", "agent", "mode", "started_at", "finished_at"]) {
    assert.ok(k in run.meta, k);
  }
  assert.equal(run.meta.repo, "vishnuverse/humanize");

  const lines = run.approvals.trim().split("\n");
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.deepEqual(Object.keys(rec), [
    "ts",
    "run_id",
    "scenario",
    "session_id",
    "turn_id",
    "thread_id",
    "tool_call_id",
    "mcp_server",
    "tool",
    "args_sha256",
    "decision",
    "prefix",
    "reason",
    "mode",
    "unexpected",
  ]);
  assert.deepEqual(
    { ...rec, ts: "x" },
    {
      ts: "x",
      run_id: "TR-DEV",
      scenario: "TR-DEV",
      session_id: "sess_fixture",
      turn_id: GATED_TURN,
      thread_id: "main",
      tool_call_id: "call_233096",
      mcp_server: "github",
      tool: "get_me",
      args_sha256: argsSha256({}),
      decision: "deny",
      prefix: "STOP",
      reason: "STOP",
      mode: "script",
      unexpected: false,
    },
  );
  assert.match(String(rec.ts), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  // same line appended to <root>/approvals.log
  assert.equal(readFileSync(join(root, "approvals.log"), "utf8"), run.approvals);
});

test("valid handoff -> exit 0, handoff.json written, end label from outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "shipgate-run-"));
  const events = withFinalMessage(loadFixture(), `Stopped.\n\n\`\`\`json\n${JSON.stringify(HANDOFF)}\n\`\`\``);
  const calls: string[] = [];
  const labels: LabelOps = {
    onStart: async (n) => {
      calls.push(`start ${n}`);
      return ["+triaged", "-bug"];
    },
    onEnd: async (n, outcome) => {
      calls.push(`end ${n} ${String(outcome)}`);
      return [];
    },
  };
  const decider = new ScriptDecider([{ tool: "get_me", decision: "allow" }], { print: quiet });
  const tf = new FakeTrueForge(events);
  const res = await runOnce(options(root), { tf, decider, labels, log: quiet });
  assert.equal(res.exitCode, 0);
  assert.equal(res.status, "completed");
  assert.deepEqual(readRun(res.runDir).handoff, HANDOFF);
  assert.deepEqual(calls, ["start 1", "end 1 stopped"]);
  assert.deepEqual(tf.turnInputs[1], [
    { type: "user.tool_approval", thread_id: "main", tool_call_id: "call_233096", approval: { status: "allow" } },
  ]);
  const rec = res.records[0];
  assert.equal(rec?.prefix, "APPROVE");
  assert.equal(rec?.reason, null);
  assert.deepEqual((readRun(res.runDir).meta.labels as { start: string[] }).start, ["+triaged", "-bug"]);
});

test("unexpected gate in script mode -> deny STOP, unexpected record, exit 3", async () => {
  const root = mkdtempSync(join(tmpdir(), "shipgate-run-"));
  const events = withFinalMessage(loadFixture(), `\`\`\`json\n${JSON.stringify(HANDOFF)}\n\`\`\``);
  const tf = new FakeTrueForge(events);
  const decider = new ScriptDecider([{ tool: "create_pull_request", decision: "allow" }], { print: quiet });
  const res = await runOnce(options(root), { tf, decider, labels: null, log: quiet });
  assert.equal(res.exitCode, 3);
  assert.equal(res.status, "unexpected_gate");
  assert.equal(res.records[0]?.unexpected, true);
  assert.equal(res.records[0]?.reason, "STOP");
  assert.deepEqual(tf.turnInputs[1]?.[0], {
    type: "user.tool_approval",
    thread_id: "main",
    tool_call_id: "call_233096",
    approval: { status: "deny", reason: "STOP" },
  });
  const meta = readRun(res.runDir).meta;
  assert.equal(meta.unexpected_gate, true);
  assert.deepEqual(meta.unexpected_detail, {
    tool: "get_me",
    mcp_server: "github",
    tool_call_id: "call_233096",
    expected_tool: "create_pull_request",
  });
  assert.deepEqual(readRun(res.runDir).handoff, HANDOFF); // still saved
});

test("ui mode: the runner follows the turn the UI created instead of answering itself", async () => {
  const root = mkdtempSync(join(tmpdir(), "shipgate-run-"));
  const tf = new FakeTrueForge(loadFixture());
  (tf as unknown as { resumed: boolean }).resumed = true; // the UI's turn is already in the events
  const decider: Decider = {
    mode: "ui",
    close: () => {},
    decide: async () => ({
      decision: "deny",
      reason: "setup smoke test: gate verified, not needed",
      unexpected: false,
      submittedTurnId: DECISION_TURN,
      submittedAt: "2026-09-25T19:26:46.611Z",
    }),
  };
  const res = await runOnce(options(root, { mode: "ui", scenarioId: null }), { tf, decider, labels: null, log: quiet });
  // no approval sent by us: only the first user message and the two nudges (the fixture has no handoff)
  assert.ok(tf.turnInputs.flat().every((i) => i.type === "user.message"));
  assert.deepEqual(res.meta.turn_ids.slice(0, 2), [GATED_TURN, DECISION_TURN]);
  assert.equal(res.records[0]?.mode, "ui");
  assert.equal(res.records[0]?.prefix, "NONE");
  assert.equal(res.records[0]?.run_id, "issue-1");
  assert.match(res.runDir, /runs\/issue-1\//);
  assert.equal(res.meta.ui_url, "http://localhost:8790/sessions/sess_fixture");
});

test("timeout cancels the running turn and exits 2", async () => {
  const root = mkdtempSync(join(tmpdir(), "shipgate-run-"));
  const tf = new FakeTrueForge(loadFixture(), true);
  const decider = new ScriptDecider([], { print: quiet });
  const res = await runOnce(options(root, { timeoutMin: 0.0005 }), { tf, decider, labels: null, log: quiet });
  assert.equal(res.status, "timeout");
  assert.equal(res.exitCode, 2);
  assert.equal(tf.cancelled, 1);
  assert.equal(readRun(res.runDir).meta.status, "timeout");
});

test("a TrueForge failure before the session is an error (exit 1) and touches no labels", async () => {
  const root = mkdtempSync(join(tmpdir(), "shipgate-run-"));
  const tf = new FakeTrueForge(loadFixture());
  tf.createSession = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8790");
  };
  let labelCalls = 0;
  const labels: LabelOps = {
    onStart: async () => {
      labelCalls++;
      return [];
    },
    onEnd: async () => {
      labelCalls++;
      return [];
    },
  };
  const decider = new ScriptDecider([], { print: quiet });
  const res = await runOnce(options(root), { tf, decider, labels, log: quiet });
  assert.equal(res.exitCode, 1);
  assert.equal(res.meta.session_id, null);
  assert.match(String(res.meta.error), /ECONNREFUSED/);
  assert.equal(labelCalls, 0);
});

/** Every turn finishes with no gate; `outputs[i]` is turn i+1's final text. */
class SilentThenFake implements TrueForgeApi {
  turnInputs: TurnInput[][] = [];
  constructor(private readonly outputs: string[]) {}
  async createSession(): Promise<string> {
    return "sess_nudge";
  }
  async createTurn(_s: string, input: TurnInput[]): Promise<string> {
    this.turnInputs.push(input);
    return `turn_${this.turnInputs.length}`;
  }
  async waitForTurn(s: string, t: string): Promise<TurnInfo> {
    return this.getTurn(s, t);
  }
  async getTurn(_s: string, t: string): Promise<TurnInfo> {
    const text = this.outputs[Number(t.split("_")[1]) - 1] ?? "";
    return { id: t, status: "done", requiredActions: [], outputText: text || null, errorMessage: null };
  }
  async listEvents(): Promise<EventItem[]> {
    return this.turnInputs.map(
      (_, i) =>
        ({ turn_id: `turn_${i + 1}`, event: { type: "model.message", content: this.outputs[i] ?? "", tool_calls: [] } }) as EventItem,
    );
  }
  async listTurns() {
    return [];
  }
  async cancel(): Promise<void> {}
}

const HANDOFF_TEXT = `Done.\n\n\`\`\`json\n${JSON.stringify(HANDOFF)}\n\`\`\``;

test("an empty final message gets one 'continue' nudge, then the handoff completes the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "shipgate-run-"));
  const tf = new SilentThenFake(["", HANDOFF_TEXT]);
  const res = await runOnce(options(root), { tf, decider: new ScriptDecider([], { print: quiet }), labels: null, log: quiet });
  assert.equal(res.exitCode, 0);
  assert.equal(tf.turnInputs.length, 2);
  const nudge = tf.turnInputs[1]?.[0] as { type: string; content: string };
  assert.equal(nudge.type, "user.message");
  assert.match(nudge.content, /continue/i);
  assert.equal(readRun(res.runDir).meta.nudges, 1);
});

test("a silent agent is nudged at most twice, then the run ends without a handoff (exit 4)", async () => {
  const root = mkdtempSync(join(tmpdir(), "shipgate-run-"));
  const tf = new SilentThenFake(["", "", "", ""]);
  const res = await runOnce(options(root), { tf, decider: new ScriptDecider([], { print: quiet }), labels: null, log: quiet });
  assert.equal(res.exitCode, 4);
  assert.equal(tf.turnInputs.length, 3);
  assert.equal(readRun(res.runDir).meta.nudges, 2);
});

/** Allows every gate and remembers the Jira context each gate was shown with. */
function recordingDecider(seen: unknown[]): Decider {
  return {
    mode: "script",
    close: () => {},
    decide: async (c) => {
      seen.push(c.jira ?? null);
      return { decision: "allow", reason: null, unexpected: false };
    },
  };
}

function recordingLabels(calls: string[], failStart = false): LabelOps {
  return {
    onStart: async (t) => {
      calls.push(`start ${JSON.stringify(t)}`);
      if (failStart) throw new Error("Jira GET /rest/api/2/issue/KAN-4 -> 401");
      return ["+triaged", "status:To Do->In Progress"];
    },
    onEnd: async (t, outcome) => {
      calls.push(`end ${JSON.stringify(t)} ${String(outcome)}`);
      return [];
    },
  };
}

test("jira run: runs/<KEY>/, meta issue null + ticket + source, session metadata, labels get the key", async () => {
  const root = mkdtempSync(join(tmpdir(), "shipgate-run-"));
  const tf = new FakeTrueForge(withFinalMessage(loadFixture(), HANDOFF_TEXT));
  const calls: string[] = [];
  const seen: unknown[] = [];
  const opts = options(root, { issue: null, ticket: "KAN-4", jiraCloudId: "cloud-1", scenarioId: null });
  const res = await runOnce(opts, { tf, decider: recordingDecider(seen), labels: recordingLabels(calls), log: quiet });
  assert.equal(res.status, "completed");
  assert.match(res.runDir, /runs\/KAN-4\/\d{8}T\d{6}Z$/);
  assert.deepEqual(tf.created[0]?.metadata, {
    shipgate_run_id: "KAN-4",
    ticket: "KAN-4",
    source: "jira",
    repo: "vishnuverse/humanize",
    approve_mode: "script",
  });
  assert.deepEqual(calls, ['start "KAN-4"', 'end "KAN-4" stopped']);
  assert.deepEqual(seen, [{ key: "KAN-4", cloudId: "cloud-1" }]);
  assert.equal(res.records[0]?.run_id, "KAN-4");
  const meta = readRun(res.runDir).meta;
  assert.deepEqual(Object.keys(meta).slice(0, 6), ["run_id", "scenario", "issue", "ticket", "source", "repo"]);
  assert.equal(meta.run_id, "KAN-4");
  assert.equal(meta.issue, null);
  assert.equal(meta.ticket, "KAN-4");
  assert.equal(meta.source, "jira");
  // a scenario id still names the run
  const scen = await runOnce(options(root, { issue: null, ticket: "KAN-4", scenarioId: "TR-J01" }), {
    tf: new FakeTrueForge(withFinalMessage(loadFixture(), HANDOFF_TEXT)),
    decider: recordingDecider([]),
    labels: null,
    log: quiet,
  });
  assert.match(scen.runDir, /runs\/TR-J01\//);
  assert.equal(scen.meta.ticket, "KAN-4");
});

test("github run: meta has no ticket/source keys, session metadata as before, no Jira context at the gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "shipgate-run-"));
  const tf = new FakeTrueForge(withFinalMessage(loadFixture(), HANDOFF_TEXT));
  const calls: string[] = [];
  const seen: unknown[] = [];
  const res = await runOnce(options(root), { tf, decider: recordingDecider(seen), labels: recordingLabels(calls), log: quiet });
  assert.deepEqual(tf.created[0]?.metadata, {
    shipgate_run_id: "TR-DEV",
    issue: "1",
    repo: "vishnuverse/humanize",
    approve_mode: "script",
  });
  assert.deepEqual(calls, ["start 1", "end 1 stopped"]);
  assert.deepEqual(seen, [null]);
  const meta = readRun(res.runDir).meta;
  assert.equal(meta.issue, 1);
  assert.ok(!("ticket" in meta) && !("source" in meta));
});

test("a Jira status failure is recorded and the run goes on", async () => {
  const root = mkdtempSync(join(tmpdir(), "shipgate-run-"));
  const tf = new FakeTrueForge(withFinalMessage(loadFixture(), HANDOFF_TEXT));
  const calls: string[] = [];
  const opts = options(root, { issue: null, ticket: "KAN-4", scenarioId: null });
  const res = await runOnce(opts, { tf, decider: recordingDecider([]), labels: recordingLabels(calls, true), log: quiet });
  assert.equal(res.status, "completed");
  assert.deepEqual(res.meta.labels.errors, ["start: Jira GET /rest/api/2/issue/KAN-4 -> 401"]);
  assert.equal(calls.length, 2); // the end update still ran
});

test("run options need exactly one of issue / ticket", async () => {
  const root = mkdtempSync(join(tmpdir(), "shipgate-run-"));
  const deps = { tf: new FakeTrueForge(loadFixture()), decider: recordingDecider([]), labels: null, log: quiet };
  await assert.rejects(runOnce(options(root, { ticket: "KAN-4" }), deps), /not both/);
  await assert.rejects(runOnce(options(root, { issue: null }), deps), /issue or ticket is required/);
  assert.equal(deps.tf.created.length, 0);
});

test("a run that ends with a handoff is never nudged", async () => {
  const root = mkdtempSync(join(tmpdir(), "shipgate-run-"));
  const tf = new SilentThenFake([HANDOFF_TEXT]);
  const res = await runOnce(options(root), { tf, decider: new ScriptDecider([], { print: quiet }), labels: null, log: quiet });
  assert.equal(res.exitCode, 0);
  assert.equal(tf.turnInputs.length, 1);
  assert.equal(readRun(res.runDir).meta.nudges, 0);
});
