// Scenario files (contracts §4). The orchestrator reads only id, issue, timeout_min and approvals.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface ScriptedApproval {
  tool: string;
  decision: "allow" | "deny";
  reason?: string;
}

export interface Scenario {
  id: string;
  issue: number | null;
  timeoutMin: number | null;
  approvals: ScriptedApproval[];
  path: string;
}

export function scenarioPath(scenariosDir: string, id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`bad scenario id '${id}'`);
  return join(scenariosDir, `${id}.yaml`);
}

export function parseScenario(text: string, path: string, expectedId?: string): Scenario {
  const doc = parseYaml(text) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") throw new Error(`${path}: not a YAML mapping`);
  const id = String(doc.id ?? expectedId ?? "");
  if (expectedId && doc.id !== undefined && id !== expectedId) {
    throw new Error(`${path}: id '${id}' does not match '${expectedId}'`);
  }
  const rawApprovals = doc.approvals ?? [];
  if (!Array.isArray(rawApprovals)) throw new Error(`${path}: approvals must be a list`);
  const approvals = rawApprovals.map((a, k): ScriptedApproval => {
    const e = a as Record<string, unknown>;
    if (!e || typeof e.tool !== "string" || (e.decision !== "allow" && e.decision !== "deny")) {
      throw new Error(`${path}: approvals[${k}] needs tool and decision allow|deny`);
    }
    const out: ScriptedApproval = { tool: e.tool, decision: e.decision };
    if (e.reason !== undefined && e.reason !== null) out.reason = String(e.reason);
    return out;
  });
  const issue = doc.issue === undefined || doc.issue === null ? null : Number(doc.issue);
  const timeoutMin = doc.timeout_min === undefined || doc.timeout_min === null ? null : Number(doc.timeout_min);
  return { id, issue, timeoutMin, approvals, path };
}

export function loadScenario(scenariosDir: string, id: string): Scenario {
  const path = scenarioPath(scenariosDir, id);
  return parseScenario(readFileSync(path, "utf8"), path, id);
}

export interface ScriptAnswer {
  decision: "allow" | "deny";
  reason: string | null;
  unexpected: boolean;
  /** What the script expected at this point (null when the list is used up). */
  expectedTool: string | null;
}

/**
 * Consumes scripted approvals in order. The next entry must name the pending tool; otherwise (or when the list is
 * used up) the answer is deny + STOP, marked unexpected, and the script stops matching (every later gate is STOP).
 */
export class ScriptCursor {
  private next = 0;
  private broken = false;

  constructor(private readonly approvals: ScriptedApproval[]) {}

  answer(tool: string): ScriptAnswer {
    const entry = this.broken ? undefined : this.approvals[this.next];
    if (!entry || entry.tool !== tool) {
      this.broken = true;
      return { decision: "deny", reason: "STOP", unexpected: true, expectedTool: entry?.tool ?? null };
    }
    this.next++;
    if (entry.decision === "allow") return { decision: "allow", reason: null, unexpected: false, expectedTool: tool };
    const reason = entry.reason === undefined || entry.reason.trim() === "" ? "STOP" : entry.reason;
    return { decision: "deny", reason, unexpected: false, expectedTool: tool };
  }

  get remaining(): number {
    return this.approvals.length - this.next;
  }
}
