// One run: start a session, relay every approval gate, save what happened. The agent makes every judgement.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitize, toolLabel, type Decider, type Decision, type Mode } from "./decide.ts";
import {
  evidenceBefore,
  lastModelMessage,
  pendingFromRequiredActions,
  resolveGate,
  type EventItem,
  type PendingCall,
  type ResolvedGate,
} from "./events.ts";
import type { LabelOps } from "./labels.ts";
import { extractHandoff, parsePrefix, type Prefix } from "./protocol.ts";
import { sleep, type AgentRef, type TrueForgeApi, type TurnInfo, type TurnInput } from "./trueforge.ts";

export type RunStatus = "completed" | "timeout" | "error" | "unexpected_gate" | "no_handoff";

export const EXIT: Record<RunStatus, number> = {
  completed: 0,
  error: 1,
  timeout: 2,
  unexpected_gate: 3,
  no_handoff: 4,
};

export interface RunOptions {
  issue: number;
  mode: Mode;
  scenarioId: string | null;
  /** Saved agent name, or an inline spec (dev only). */
  agent: AgentRef;
  agentLabel: string;
  prompt: string;
  timeoutMin: number;
  repoRoot: string;
  trueforgeUrl: string;
  repo: string;
}

export interface RunDeps {
  tf: TrueForgeApi;
  decider: Decider;
  labels: LabelOps | null;
  log: (line: string) => void;
  /** External abort (Ctrl-C). */
  signal?: AbortSignal;
  now?: () => Date;
}

export interface ApprovalRecord {
  ts: string;
  run_id: string;
  scenario: string | null;
  session_id: string;
  turn_id: string;
  thread_id: string;
  tool_call_id: string;
  mcp_server: string | null;
  tool: string;
  args_sha256: string;
  decision: "allow" | "deny";
  prefix: Prefix;
  reason: string | null;
  mode: Mode;
  unexpected: boolean;
}

export interface RunMeta {
  run_id: string;
  scenario: string | null;
  issue: number;
  repo: string;
  agent: string;
  session_id: string | null;
  mode: Mode;
  started_at: string;
  finished_at: string;
  status: RunStatus;
  exit_code: number;
  turn_ids: string[];
  unexpected_gate: boolean;
  /** "continue" messages sent after a turn ended with no gate and no handoff. */
  nudges: number;
  // extras (not in the contract, safe to ignore)
  unexpected_detail: { tool: string; mcp_server: string | null; tool_call_id: string; expected_tool: string | null } | null;
  error: string | null;
  handoff_error: string | null;
  approvals: number;
  labels: { enabled: boolean; start: string[]; end: string[]; errors: string[] };
  trueforge_url: string;
  ui_url: string | null;
}

export interface RunResult {
  status: RunStatus;
  exitCode: number;
  runDir: string;
  meta: RunMeta;
  records: ApprovalRecord[];
}

/** 2026-09-26T12:34:56Z */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 20260926T123456Z */
export function utcStamp(d: Date): string {
  return isoSeconds(d).replace(/[-:]/g, "");
}

export function uiSessionUrl(trueforgeUrl: string, sessionId: string): string {
  return `${trueforgeUrl.replace(/\/+$/, "")}/sessions/${encodeURIComponent(sessionId)}`;
}

class TimeoutError extends Error {
  constructor(min: number) {
    super(`run exceeded ${min} min`);
    this.name = "TimeoutError";
  }
}

function approvalInput(p: PendingCall, d: Decision): TurnInput {
  return {
    type: "user.tool_approval",
    thread_id: p.threadId,
    tool_call_id: p.toolCallId,
    approval: d.decision === "allow" ? { status: "allow" } : { status: "deny", reason: d.reason ?? "STOP" },
  };
}

/** Compact progress line for a streamed event (SDK camelCase). */
function progressLine(ev: Record<string, unknown>): string | null {
  const type = ev.type;
  if (type === "model.message") {
    const calls = (ev.toolCalls ?? ev.tool_calls) as { function?: { name?: string; arguments?: string } }[] | undefined;
    if (calls && calls.length > 0) {
      return calls
        .map((c) => {
          const name = c.function?.name ?? "?";
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(c.function?.arguments ?? "{}") as Record<string, unknown>;
          } catch {
            // keep empty
          }
          if (name === "exec") return `  exec  ${String(args.intent ?? "")} | ${String(args.command ?? "").slice(0, 140)}`;
          if (name === "call_tool") return `  mcp   ${String(args.mcp_server)}/${String(args.tool_name)}`;
          return `  tool  ${name}`;
        })
        .join("\n");
    }
    const content = typeof ev.content === "string" ? ev.content.trim() : "";
    if (content) return `  agent ${content.split("\n")[0]?.slice(0, 140) ?? ""}`;
    return null;
  }
  if (type === "tool.response" && typeof ev.content === "string" && ev.content.startsWith('{"success"')) {
    try {
      const r = JSON.parse(ev.content) as { success?: boolean; response?: { exitCode?: number } };
      if (r.response?.exitCode !== undefined) return `  exit  ${r.response.exitCode}`;
    } catch {
      // not a sandbox result
    }
    return null;
  }
  if (type === "tool.approval_required") return "  gate  paused for approval";
  if (type === "sandbox.created") return "  sandbox created";
  return null;
}

/** Sent when a turn ends with no gate and no handoff (e.g. the model returned an empty completion). */
export const NUDGE =
  "Your last turn ended without the handoff JSON. If the procedure is finished or was stopped by a human, reply " +
  "with only the handoff JSON block and nothing else. Otherwise continue with the next step of the procedure.";
export const MAX_NUDGES = 2;

export async function runOnce(opts: RunOptions, deps: RunDeps): Promise<RunResult> {
  const now = deps.now ?? (() => new Date());
  const { tf, decider, labels, log } = deps;
  const started = now();
  const runId = opts.scenarioId ?? `issue-${opts.issue}`;
  const runDir = join(opts.repoRoot, "runs", runId, utcStamp(started));
  mkdirSync(runDir, { recursive: true });
  const approvalsLog = join(opts.repoRoot, "approvals.log");
  writeFileSync(join(runDir, "approvals.jsonl"), "");

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new TimeoutError(opts.timeoutMin)), opts.timeoutMin * 60_000);
  const signal = deps.signal ? AbortSignal.any([deadline.signal, deps.signal]) : deadline.signal;

  const records: ApprovalRecord[] = [];
  const turnIds: string[] = [];
  const labelInfo = { enabled: labels !== null, start: [] as string[], end: [] as string[], errors: [] as string[] };
  let sessionId: string | null = null;
  let lastInfo: TurnInfo | null = null;
  let status: RunStatus = "completed";
  let error: string | null = null;
  let unexpectedDetail: RunMeta["unexpected_detail"] = null;
  let nudges = 0;
  const seen = new Set<string>();
  const onEvent = (ev: Record<string, unknown>) => {
    const id = typeof ev.id === "string" ? ev.id : null;
    if (id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    const line = progressLine(ev);
    if (line) log(sanitize(line));
  };

  const record = (gatedTurnId: string, gate: ResolvedGate, d: Decision): ApprovalRecord => {
    const rec: ApprovalRecord = {
      ts: isoSeconds(now()),
      run_id: runId,
      scenario: opts.scenarioId,
      session_id: sessionId as string,
      turn_id: gatedTurnId,
      thread_id: gate.threadId,
      tool_call_id: gate.toolCallId,
      mcp_server: gate.mcpServer,
      tool: gate.tool,
      args_sha256: gate.argsSha256,
      decision: d.decision,
      prefix: parsePrefix(d.decision, d.reason),
      reason: d.decision === "allow" ? null : d.reason,
      mode: decider.mode,
      unexpected: d.unexpected,
    };
    const line = `${JSON.stringify(rec)}\n`;
    appendFileSync(join(runDir, "approvals.jsonl"), line);
    appendFileSync(approvalsLog, line);
    records.push(rec);
    return rec;
  };

  try {
    sessionId = await tf.createSession(opts.agent, {
      shipgate_run_id: runId,
      issue: String(opts.issue),
      repo: opts.repo,
      approve_mode: opts.mode,
    });
    log(`session ${sessionId}  (${uiSessionUrl(opts.trueforgeUrl, sessionId)})`);

    if (labels) {
      try {
        labelInfo.start = await labels.onStart(opts.issue);
        log(`labels: ${labelInfo.start.join(" ") || "no change"}`);
      } catch (e) {
        labelInfo.errors.push(`start: ${(e as Error).message}`);
        log(`warning: label update failed: ${(e as Error).message}`);
      }
    }

    let turnId = await tf.createTurn(sessionId, [{ type: "user.message", content: opts.prompt }]);
    turnIds.push(turnId);
    log(`turn ${turnId}: ${opts.prompt}`);
    let gateNumber = 0;

    for (;;) {
      lastInfo = await tf.waitForTurn(sessionId, turnId, signal, onEvent);
      if (lastInfo.status === "error") throw new Error(`turn ${turnId} failed: ${lastInfo.errorMessage ?? "unknown"}`);
      if (lastInfo.status !== "done") throw new Error(`turn ${turnId} ended ${lastInfo.status}`);
      const { pending, other } = pendingFromRequiredActions(lastInfo.requiredActions);
      if (other.length > 0) throw new Error(`turn ${turnId} needs unsupported action(s): ${other.join(", ")}`);
      if (pending.length === 0) {
        // Relay only: a turn that stops with no gate and no handoff gets a fixed "continue" (max MAX_NUDGES).
        if (nudges < MAX_NUDGES && !extractHandoff(lastInfo.outputText).ok) {
          nudges++;
          turnId = await tf.createTurn(sessionId, [{ type: "user.message", content: NUDGE }]);
          turnIds.push(turnId);
          log(`nudge ${nudges}/${MAX_NUDGES}: turn ended without a gate or a handoff`);
          continue;
        }
        break;
      }

      const events = await tf.listEvents(sessionId);
      const answers: TurnInput[] = [];
      const submitted = new Map<string, string>(); // ui mode: turns the UI created, id -> created_at
      for (const p of pending) {
        gateNumber++;
        const gate = resolveGate(events, p);
        const ctx = {
          sessionId,
          gatedTurnId: turnId,
          gate,
          evidence: evidenceBefore(events, gate.sourceEventId),
          gateNumber,
          uiUrl: uiSessionUrl(opts.trueforgeUrl, sessionId),
        };
        const d = await decider.decide(ctx, signal);
        const rec = record(turnId, gate, d);
        if (d.unexpected && !unexpectedDetail) {
          unexpectedDetail = {
            tool: gate.tool,
            mcp_server: gate.mcpServer,
            tool_call_id: gate.toolCallId,
            expected_tool: d.expectedTool ?? null,
          };
        }
        if (decider.mode !== "script") log(`recorded ${toolLabel(gate)}: ${rec.decision} ${rec.prefix}`);
        if (d.submittedTurnId) {
          submitted.set(d.submittedTurnId, d.submittedAt ?? d.submittedTurnId);
        } else {
          answers.push(approvalInput(p, d));
        }
      }
      if (answers.length > 0) {
        turnId = await tf.createTurn(sessionId, answers);
        turnIds.push(turnId);
      } else if (submitted.size > 0) {
        // The UI may answer several pending calls in separate turns; follow the newest one.
        const ordered = [...submitted].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([id]) => id);
        turnIds.push(...ordered);
        turnId = ordered[ordered.length - 1] as string;
      } else {
        throw new Error("gate answered without a turn to follow");
      }
    }
    status = unexpectedDetail ? "unexpected_gate" : "completed";
  } catch (e) {
    if (deadline.signal.aborted) {
      status = "timeout";
      error = (deadline.signal.reason as Error).message;
    } else {
      status = "error";
      error = deps.signal?.aborted ? "interrupted" : (e as Error).message;
    }
    log(`${status}: ${error}`);
    if (sessionId && (status === "timeout" || error === "interrupted")) {
      try {
        await tf.cancel(sessionId);
        log("cancelled the running turn");
        const last = turnIds[turnIds.length - 1];
        for (let k = 0; last && k < 10; k++) {
          const t = await tf.getTurn(sessionId, last);
          if (t.status !== "running") break;
          await sleep(1000);
        }
      } catch (ce) {
        log(`warning: cancel failed: ${(ce as Error).message}`);
      }
    }
  } finally {
    clearTimeout(timer);
  }

  // ---- save everything ----
  let events: EventItem[] = [];
  if (sessionId) {
    try {
      events = await tf.listEvents(sessionId);
    } catch (e) {
      log(`warning: could not fetch events: ${(e as Error).message}`);
      if (!error) error = `events: ${(e as Error).message}`;
    }
  }
  const lastTurn = turnIds[turnIds.length - 1] ?? null;
  const finalText = (lastTurn ? lastModelMessage(events, lastTurn) : null) ?? lastInfo?.outputText ?? null;
  const handoff = extractHandoff(finalText);
  if (status === "completed" && !handoff.ok) status = "no_handoff";
  const handoffObj = handoff.ok ? handoff.handoff : null;

  if (labels && sessionId) {
    try {
      labelInfo.end = await labels.onEnd(opts.issue, (handoffObj?.outcome as string | undefined) ?? null);
      log(`labels: ${labelInfo.end.join(" ") || "no change"}`);
    } catch (e) {
      labelInfo.errors.push(`end: ${(e as Error).message}`);
      log(`warning: label update failed: ${(e as Error).message}`);
    }
  }

  const meta: RunMeta = {
    run_id: runId,
    scenario: opts.scenarioId,
    issue: opts.issue,
    repo: opts.repo,
    agent: opts.agentLabel,
    session_id: sessionId,
    mode: opts.mode,
    started_at: isoSeconds(started),
    finished_at: isoSeconds(now()),
    status,
    exit_code: EXIT[status],
    turn_ids: turnIds,
    unexpected_gate: unexpectedDetail !== null,
    nudges,
    unexpected_detail: unexpectedDetail,
    error,
    handoff_error: handoff.ok ? null : handoff.error,
    approvals: records.length,
    labels: labelInfo,
    trueforge_url: opts.trueforgeUrl,
    ui_url: sessionId ? uiSessionUrl(opts.trueforgeUrl, sessionId) : null,
  };
  writeFileSync(join(runDir, "events.json"), `${JSON.stringify(events, null, 2)}\n`);
  writeFileSync(join(runDir, "handoff.json"), `${JSON.stringify(handoffObj, null, 2)}\n`);
  writeFileSync(join(runDir, "final_message.md"), finalText ?? "");
  writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return { status, exitCode: EXIT[status], runDir, meta, records };
}
