// Reading TrueForge session events (wire format, snake_case, contracts §5). No decisions here.
import { argsSha256, parseJsonLossless, toPlain, type JsonValue } from "./canonical.ts";

export interface WireEvent {
  type: string;
  id?: string;
  turn_id?: string;
  thread_id?: string | null;
  created_at?: string;
  content?: unknown;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  input?: WireInputItem[];
  [key: string]: unknown;
}

export interface WireToolCall {
  id: string;
  function?: { name?: string; arguments?: string };
  tool_info?: { type?: string; name?: string; server_name?: string; server_id?: string };
  source_event_id?: string;
}

export interface WireInputItem {
  type: string;
  content?: unknown;
  thread_id?: string;
  tool_call_id?: string;
  approval?: { status: "allow" | "deny"; reason?: string | null };
}

/** One item of GET /sessions/{id}/events. */
export interface EventItem {
  turn_id: string;
  event: WireEvent;
}

export interface PendingCall {
  threadId: string;
  toolCallId: string;
  sourceEventId: string | null;
}

export interface ResolvedGate {
  toolCallId: string;
  threadId: string;
  sourceEventId: string | null;
  /** Turn that holds the gated call. */
  turnId: string | null;
  /** MCP server name, or null if it can't be told from the call. */
  mcpServer: string | null;
  /** MCP tool name (for `call_tool`, the inner `tool_name`). */
  tool: string;
  /** The model-visible function (`call_tool` or the direct tool name). */
  functionName: string;
  /** MCP tool input as plain JS (display only). */
  input: unknown;
  argsSha256: string;
  /** Raw `function.arguments` string. */
  rawArguments: string;
}

/** Text of a model.message `content` (string, or an array of text parts). */
export function contentText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && "text" in p ? String(p.text) : ""))
      .filter((s) => s !== "");
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

function isObject(v: unknown): v is Record<string, JsonValue> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Find the tool call behind a pending approval and pull out MCP server, tool and input. */
export function resolveGate(events: EventItem[], pending: PendingCall): ResolvedGate {
  let holder: EventItem | undefined;
  if (pending.sourceEventId) {
    holder = events.find((e) => e.event.id === pending.sourceEventId && e.event.type === "model.message");
  }
  if (!holder || !holder.event.tool_calls?.some((c) => c.id === pending.toolCallId)) {
    holder = [...events]
      .reverse()
      .find((e) => e.event.type === "model.message" && e.event.tool_calls?.some((c) => c.id === pending.toolCallId));
  }
  const call = holder?.event.tool_calls?.find((c) => c.id === pending.toolCallId);
  if (!holder || !call) throw new Error(`tool call ${pending.toolCallId} not found in session events`);

  const functionName = call.function?.name ?? call.tool_info?.name ?? "";
  const rawArguments = call.function?.arguments ?? "{}";
  let args: JsonValue;
  try {
    args = rawArguments.trim() === "" ? {} : parseJsonLossless(rawArguments);
  } catch (e) {
    throw new Error(`tool call ${pending.toolCallId}: arguments are not JSON (${(e as Error).message})`);
  }

  let mcpServer: string | null;
  let tool: string;
  let input: JsonValue;
  if (functionName === "call_tool" && isObject(args)) {
    mcpServer = typeof args.mcp_server === "string" ? args.mcp_server : null;
    tool = typeof args.tool_name === "string" ? args.tool_name : "call_tool";
    input = args.input === undefined ? {} : args.input;
  } else {
    // A direct MCP function: its whole argument object is the MCP input.
    mcpServer = call.tool_info?.type === "mcp" ? (call.tool_info.server_name ?? null) : null;
    tool = call.tool_info?.type === "mcp" && call.tool_info.name ? call.tool_info.name : functionName;
    input = args;
  }
  return {
    toolCallId: pending.toolCallId,
    threadId: pending.threadId,
    sourceEventId: holder.event.id ?? pending.sourceEventId,
    turnId: holder.turn_id ?? null,
    mcpServer,
    tool,
    functionName,
    input: toPlain(input),
    argsSha256: argsSha256(input),
    rawArguments,
  };
}

/** The latest non-empty model.message text at or before the gated call (the evidence card, if the agent posted one). */
export function evidenceBefore(events: EventItem[], sourceEventId: string | null): string | null {
  let end = events.length - 1;
  if (sourceEventId) {
    const idx = events.findIndex((e) => e.event.id === sourceEventId);
    if (idx >= 0) end = idx;
  }
  for (let k = end; k >= 0; k--) {
    const ev = events[k]?.event;
    if (ev?.type !== "model.message") continue;
    const text = contentText(ev.content);
    if (text && text.trim() !== "") return text;
  }
  return null;
}

/** A turn and its input, from either a `turn.created` event or the turns API. */
export interface TurnInputRecord {
  turnId: string;
  previousTurnId: string | null;
  createdAt: string | null;
  input: WireInputItem[];
}

export function turnsFromEvents(events: EventItem[]): TurnInputRecord[] {
  return events
    .filter((e) => e.event.type === "turn.created")
    .map((e) => ({
      turnId: e.turn_id,
      previousTurnId: (e.event.previous_turn_id as string | null | undefined) ?? null,
      createdAt: e.event.created_at ?? null,
      input: Array.isArray(e.event.input) ? e.event.input : [],
    }));
}

export interface FoundDecision {
  turnId: string;
  createdAt: string | null;
  decision: "allow" | "deny";
  reason: string | null;
}

/** A human's answer to `toolCallId`, given in any turn other than the gated one (e.g. in the TrueForge UI). */
export function findApprovalDecision(
  turns: TurnInputRecord[],
  toolCallId: string,
  gatedTurnId: string | null,
): FoundDecision | null {
  for (const t of turns) {
    if (t.turnId === gatedTurnId) continue;
    for (const item of t.input) {
      if (item.type !== "user.tool_approval" || item.tool_call_id !== toolCallId || !item.approval) continue;
      const status = item.approval.status === "allow" ? "allow" : "deny";
      return { turnId: t.turnId, createdAt: t.createdAt, decision: status, reason: item.approval.reason ?? null };
    }
  }
  return null;
}

/** Content of the last model.message in `turnId` (or in the whole session if turnId is null). */
export function lastModelMessage(events: EventItem[], turnId: string | null): string | null {
  for (let k = events.length - 1; k >= 0; k--) {
    const e = events[k];
    if (!e || e.event.type !== "model.message") continue;
    if (turnId !== null && e.turn_id !== turnId) continue;
    return contentText(e.event.content);
  }
  return null;
}

/** Pending approvals from a turn's `required_actions` (any other action type is returned separately). */
export function pendingFromRequiredActions(actions: unknown[]): { pending: PendingCall[]; other: string[] } {
  const pending: PendingCall[] = [];
  const other: string[] = [];
  for (const a of actions) {
    const act = a as {
      type?: string;
      thread_id?: string;
      threadId?: string;
      tool_calls?: { id: string; source_event_id?: string; sourceEventId?: string }[];
      toolCalls?: { id: string; source_event_id?: string; sourceEventId?: string }[];
    };
    if (act.type !== "tool.approval_required") {
      other.push(String(act.type));
      continue;
    }
    const threadId = act.thread_id ?? act.threadId ?? "main";
    for (const c of act.tool_calls ?? act.toolCalls ?? []) {
      pending.push({ threadId, toolCallId: c.id, sourceEventId: c.source_event_id ?? c.sourceEventId ?? null });
    }
  }
  return { pending, other };
}
