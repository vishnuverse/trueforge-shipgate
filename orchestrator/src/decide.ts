// Where approval decisions come from: a human at the terminal, a human in the TrueForge UI, or a scenario script.
// The orchestrator relays the answer; it never makes one up (script mode replays a human-written list).
import { createInterface, type Interface } from "node:readline";
import { findApprovalDecision, type ResolvedGate, type TurnInputRecord } from "./events.ts";
import { ScriptCursor } from "./scenario.ts";
import { sleep } from "./trueforge.ts";

export type Mode = "ui" | "terminal" | "script";

export interface GateContext {
  sessionId: string;
  /** The turn that ended with tool.approval_required. */
  gatedTurnId: string;
  gate: ResolvedGate;
  /** Latest agent message before the gate (the evidence card, if posted). */
  evidence: string | null;
  /** 1-based count of gates in this run. */
  gateNumber: number;
  uiUrl: string;
}

export interface Decision {
  decision: "allow" | "deny";
  reason: string | null;
  unexpected: boolean;
  /** Script mode: the tool the script expected when it did not match. */
  expectedTool?: string | null;
  /** UI mode: the turn the UI created with this answer (the runner follows it instead of creating one). */
  submittedTurnId?: string;
  submittedAt?: string | null;
}

export interface Decider {
  readonly mode: Mode;
  decide(ctx: GateContext, signal: AbortSignal): Promise<Decision>;
  close(): void;
}

export interface Printer {
  print(text: string): void;
}

// ---------- display ----------

/** Drop terminal control sequences and zero-width characters from untrusted text (keeps \n and \t). */
export function sanitize(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g, "");
}

function shorten(v: unknown, max: number): unknown {
  if (typeof v === "string") return v.length > max ? `${v.slice(0, max)}… (+${v.length - max} chars, [v] shows all)` : v;
  if (Array.isArray(v)) return v.map((x) => shorten(x, max));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x, max)]));
  }
  return v;
}

export function toolLabel(gate: ResolvedGate): string {
  return gate.mcpServer ? `${gate.mcpServer}/${gate.tool}` : gate.tool;
}

export function renderGate(ctx: GateContext, maxString = 600): string {
  const g = ctx.gate;
  const bar = "=".repeat(72);
  const lines = [
    "",
    bar,
    `GATE ${ctx.gateNumber} · ${toolLabel(g)} · ${g.toolCallId} · args sha256 ${g.argsSha256.slice(0, 12)}`,
    bar,
    "--- agent's latest message before the gate ---",
    ctx.evidence ? sanitize(ctx.evidence) : "(none)",
    `--- ${toolLabel(g)} input ---`,
    sanitize(JSON.stringify(shorten(g.input, maxString), null, 2)),
    bar,
  ];
  return lines.join("\n");
}

// ---------- script ----------

export class ScriptDecider implements Decider {
  readonly mode = "script" as const;
  private readonly cursor: ScriptCursor;

  constructor(
    approvals: ConstructorParameters<typeof ScriptCursor>[0],
    private readonly out: Printer,
  ) {
    this.cursor = new ScriptCursor(approvals);
  }

  get remaining(): number {
    return this.cursor.remaining;
  }

  close(): void {}

  async decide(ctx: GateContext): Promise<Decision> {
    const a = this.cursor.answer(ctx.gate.tool);
    const what = a.decision === "allow" ? "allow" : `deny "${a.reason}"`;
    if (a.unexpected) {
      this.out.print(
        `gate ${ctx.gateNumber} ${toolLabel(ctx.gate)}: UNEXPECTED (script expected ${a.expectedTool ?? "no more gates"}) -> deny "STOP"`,
      );
    } else {
      this.out.print(`gate ${ctx.gateNumber} ${toolLabel(ctx.gate)}: script -> ${what}`);
    }
    return { decision: a.decision, reason: a.reason, unexpected: a.unexpected, expectedTool: a.expectedTool };
  }
}

// ---------- terminal ----------

export interface LineReader extends Printer {
  /** One line from the operator, or null on end of input. */
  readLine(prompt: string, signal: AbortSignal): Promise<string | null>;
  close?(): void;
}

const MENU = "[a]pprove  [r]evise  [e]dit  [s]top  [v]iew full input > ";

export class TerminalDecider implements Decider {
  readonly mode = "terminal" as const;

  constructor(private readonly io: LineReader) {}

  close(): void {
    this.io.close?.();
  }

  async decide(ctx: GateContext, signal: AbortSignal): Promise<Decision> {
    const io = this.io;
    const stop = (why: string): Decision => {
      io.print(`${why}: answering STOP`);
      return { decision: "deny", reason: "STOP", unexpected: false };
    };
    io.print(renderGate(ctx));
    for (;;) {
      const ans = await io.readLine(MENU, signal);
      if (ans === null) return stop("end of input");
      const c = ans.trim().toLowerCase();
      if (c === "a" || c === "approve") return { decision: "allow", reason: null, unexpected: false };
      if (c === "s" || c === "stop") return { decision: "deny", reason: "STOP", unexpected: false };
      if (c === "v" || c === "view") {
        io.print(sanitize(JSON.stringify(ctx.gate.input, null, 2)));
        continue;
      }
      if (c === "r" || c === "revise") {
        const note = await io.readLine("Revision note (empty line = back to menu): ", signal);
        if (note === null) return stop("end of input");
        if (note.trim() === "") continue;
        return { decision: "deny", reason: `REVISE: ${note.trim()}`, unexpected: false };
      }
      if (c === "e" || c === "edit") {
        io.print("Type the exact text. End with a line containing only '.' (just '.' = back to menu).");
        const lines: string[] = [];
        for (;;) {
          const l = await io.readLine("", signal);
          if (l === null) return stop("end of input");
          if (l === ".") break;
          lines.push(l);
        }
        if (lines.length === 0) continue;
        return { decision: "deny", reason: `EDIT: ${lines.join("\n")}`, unexpected: false };
      }
      io.print("Answer a, r, e, s or v.");
    }
  }
}

/** Line reader over stdin/stdout. Created lazily so non-terminal modes never hold stdin open. */
export class StdioLineReader implements LineReader {
  private rl: Interface | null = null;
  private buffered: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private ended = false;

  private ensure(): void {
    if (this.rl) return;
    this.rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    this.rl.on("line", (line) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = null;
        w(line);
      } else this.buffered.push(line);
    });
    this.rl.on("close", () => {
      this.ended = true;
      const w = this.waiting;
      this.waiting = null;
      w?.(null);
    });
    // Ctrl-C at a prompt: forward to the process handler (cancels the run cleanly).
    this.rl.on("SIGINT", () => process.emit("SIGINT"));
  }

  print(text: string): void {
    process.stdout.write(`${text}\n`);
  }

  readLine(prompt: string, signal: AbortSignal): Promise<string | null> {
    this.ensure();
    if (prompt) process.stdout.write(prompt);
    const next = this.buffered.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = () => {
        this.waiting = null;
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiting = (line) => {
        signal.removeEventListener("abort", onAbort);
        resolve(line);
      };
    });
  }

  close(): void {
    this.rl?.close();
    this.rl = null;
  }
}

// ---------- ui ----------

export class UiDecider implements Decider {
  readonly mode = "ui" as const;

  constructor(
    private readonly listTurns: (sessionId: string) => Promise<TurnInputRecord[]>,
    private readonly out: Printer,
    private readonly pollMs = 1500,
  ) {}

  close(): void {}

  async decide(ctx: GateContext, signal: AbortSignal): Promise<Decision> {
    this.out.print(renderGate(ctx));
    this.out.print(`Decide in TrueForge: ${ctx.uiUrl}`);
    this.out.print(`Waiting for the approval card answer on ${ctx.gate.toolCallId} ...`);
    let warned = false;
    for (;;) {
      signal.throwIfAborted();
      try {
        const found = findApprovalDecision(await this.listTurns(ctx.sessionId), ctx.gate.toolCallId, ctx.gatedTurnId);
        if (found) {
          const what = found.decision === "allow" ? "allow" : `deny "${sanitize(found.reason ?? "")}"`;
          this.out.print(`gate ${ctx.gateNumber} ${toolLabel(ctx.gate)}: UI -> ${what} (turn ${found.turnId})`);
          return {
            decision: found.decision,
            reason: found.reason,
            unexpected: false,
            submittedTurnId: found.turnId,
            submittedAt: found.createdAt,
          };
        }
        warned = false;
      } catch (e) {
        if (signal.aborted) throw signal.reason ?? e;
        if (!warned) this.out.print(`warning: could not list turns (${(e as Error).message}); retrying`);
        warned = true;
      }
      await sleep(this.pollMs, signal);
    }
  }
}
