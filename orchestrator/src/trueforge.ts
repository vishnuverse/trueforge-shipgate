// TrueForge access. SDK (@truefoundry/trueforge-sdk 0.2.0) for sessions, turns, subscribe, turn list and cancel;
// plain fetch only for GET /sessions/{id}/events, because the SDK re-keys events to camelCase and events.json must
// hold them exactly as the API returns them (contracts §3).
import {
  TrueForge,
  isEventDelta,
  mergeEventDelta,
  serialization,
  type TrueForgeApi as Api,
} from "@truefoundry/trueforge-sdk";
import type { EventItem, TurnInputRecord, WireInputItem } from "./events.ts";
import { contentText } from "./events.ts";

export type TurnInput =
  | { type: "user.message"; content: string }
  | {
      type: "user.tool_approval";
      thread_id: string;
      tool_call_id: string;
      approval: { status: "allow" } | { status: "deny"; reason: string };
    };

export interface TurnInfo {
  id: string;
  status: string;
  /** Raw required actions (camelCase from the SDK; events.ts accepts both spellings). */
  requiredActions: unknown[];
  outputText: string | null;
  errorMessage: string | null;
}

export type AgentRef = { name: string } | { spec: unknown };

/** What the runner needs from TrueForge (a fake implements this in tests). */
export interface TrueForgeApi {
  createSession(agent: AgentRef, metadata: Record<string, string>): Promise<string>;
  createTurn(sessionId: string, input: TurnInput[]): Promise<string>;
  /** Resolves when the turn is no longer running. */
  waitForTurn(
    sessionId: string,
    turnId: string,
    signal: AbortSignal,
    onEvent?: (ev: Record<string, unknown>) => void,
  ): Promise<TurnInfo>;
  getTurn(sessionId: string, turnId: string): Promise<TurnInfo>;
  /** All session events, oldest first, wire format. */
  listEvents(sessionId: string): Promise<EventItem[]>;
  /** Recent turns with their input (newest first). */
  listTurns(sessionId: string): Promise<TurnInputRecord[]>;
  cancel(sessionId: string): Promise<void>;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type SdkTurn = Awaited<ReturnType<TrueForge["sessions"]["getTurn"]>>["data"];

function toTurnInfo(t: SdkTurn): TurnInfo {
  const st = t.state as unknown as Record<string, unknown>;
  const output = st.output as { content?: unknown } | null | undefined;
  return {
    id: t.id,
    status: String(st.status),
    requiredActions: Array.isArray(st.requiredActions) ? st.requiredActions : [],
    outputText: output ? contentText(output.content) : null,
    errorMessage: typeof st.message === "string" ? st.message : null,
  };
}

function toSdkInput(item: TurnInput): Api.TurnInputItem {
  if (item.type === "user.message") return { type: "user.message", content: item.content };
  return {
    type: "user.tool_approval",
    threadId: item.thread_id,
    toolCallId: item.tool_call_id,
    approval: item.approval.status === "allow" ? { status: "allow" } : { status: "deny", reason: item.approval.reason },
  };
}

function fromSdkInput(item: unknown): WireInputItem {
  const i = item as Record<string, unknown>;
  const approval = i.approval as { status: "allow" | "deny"; reason?: string } | undefined;
  return {
    type: String(i.type),
    ...(i.content !== undefined ? { content: i.content } : {}),
    ...(typeof i.threadId === "string" ? { thread_id: i.threadId } : {}),
    ...(typeof i.toolCallId === "string" ? { tool_call_id: i.toolCallId } : {}),
    ...(approval ? { approval } : {}),
  };
}

export class TrueForgeClient implements TrueForgeApi {
  private readonly sdk: TrueForge;

  constructor(
    readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.sdk = new TrueForge({ baseUrl, auth: false, fetch: fetchFn });
  }

  async createSession(agent: AgentRef, metadata: Record<string, string>): Promise<string> {
    const sdkAgent: Api.CreateSessionAgent =
      "name" in agent
        ? { name: agent.name }
        : {
            // The spec file is wire format (snake_case); the SDK wants its camelCase model and maps it back.
            spec: serialization.AgentSpec.parseOrThrow(agent.spec, {
              unrecognizedObjectKeys: "passthrough",
              allowUnrecognizedUnionMembers: true,
              allowUnrecognizedEnumValues: true,
            }),
          };
    const res = await this.sdk.sessions.create({ agent: sdkAgent, metadata }, { maxRetries: 0 });
    return res.data.id;
  }

  async createTurn(sessionId: string, input: TurnInput[]): Promise<string> {
    // No retries: a retried POST could answer a gate twice.
    const res = await this.sdk.sessions.createTurn(sessionId, { input: input.map(toSdkInput) }, { maxRetries: 0 });
    return res.data.id;
  }

  async getTurn(sessionId: string, turnId: string): Promise<TurnInfo> {
    const res = await this.sdk.sessions.getTurn(sessionId, turnId);
    return toTurnInfo(res.data);
  }

  async waitForTurn(
    sessionId: string,
    turnId: string,
    signal: AbortSignal,
    onEvent?: (ev: Record<string, unknown>) => void,
  ): Promise<TurnInfo> {
    for (;;) {
      signal.throwIfAborted();
      try {
        const stream = await this.sdk.sessions.subscribeToTurn(
          sessionId,
          turnId,
          {},
          { abortSignal: signal, timeoutInSeconds: 6 * 3600, maxRetries: 0 },
        );
        // model.message arrives as an empty base plus deltas; hand out the merged message once it finishes.
        const bases = new Map<string, Api.TurnStreamingEvent>();
        for await (const ev of stream) {
          if (isEventDelta(ev)) {
            const base = bases.get(ev.id);
            if (!base) continue;
            mergeEventDelta(base, ev);
            if (ev.finishReason !== undefined) {
              bases.delete(ev.id);
              onEvent?.(base as unknown as Record<string, unknown>);
            }
            continue;
          }
          if (ev.type === "model.message" && ev.finishReason == null) {
            bases.set(ev.id, ev);
            continue;
          }
          onEvent?.(ev as unknown as Record<string, unknown>);
        }
        for (const base of bases.values()) onEvent?.(base as unknown as Record<string, unknown>);
      } catch (e) {
        if (signal.aborted) throw signal.reason ?? e;
        // Stream dropped or refused: fall back to reading the turn.
      }
      const info = await this.getTurn(sessionId, turnId);
      if (info.status !== "running") return info;
      await sleep(1000, signal);
    }
  }

  async listEvents(sessionId: string): Promise<EventItem[]> {
    const newestFirst: EventItem[] = [];
    let token: string | undefined;
    for (let page = 0; page < 10_000; page++) {
      const url = new URL(`api/v1/sessions/${encodeURIComponent(sessionId)}/events`, this.baseUrl.replace(/\/?$/, "/"));
      url.searchParams.set("limit", "100");
      if (token) url.searchParams.set("page_token", token);
      const res = await this.fetchFn(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`GET events -> ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { data?: EventItem[]; pagination?: { next_page_token?: string | null } };
      newestFirst.push(...(body.data ?? []));
      token = body.pagination?.next_page_token ?? undefined;
      if (!token) break;
    }
    return newestFirst.reverse();
  }

  async listTurns(sessionId: string): Promise<TurnInputRecord[]> {
    const page = await this.sdk.sessions.listTurns(sessionId, { limit: 25 });
    return page.data.map((t) => ({
      turnId: t.id,
      previousTurnId: t.previousTurnId ?? null,
      createdAt: t.createdAt ?? null,
      input: (t.input ?? []).map(fromSdkInput),
    }));
  }

  async cancel(sessionId: string): Promise<void> {
    await this.sdk.sessions.cancel(sessionId, {}, { maxRetries: 0 });
  }
}
