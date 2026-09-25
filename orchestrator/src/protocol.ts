// HITL protocol parsing (SPEC §4.5) and the final handoff block (SPEC §7, contracts §7).
// Pure functions: the orchestrator only reads these, it never decides anything from them.

export type Prefix = "APPROVE" | "REVISE" | "EDIT" | "STOP" | "NONE";
export type DecisionKind = "allow" | "deny";

/**
 * allow -> APPROVE. deny -> REVISE / EDIT / STOP by case-sensitive prefix after leading whitespace, else NONE.
 * An empty or missing deny reason counts as STOP (SPEC §4.5: "STOP (or an empty reason via the API)").
 */
export function parsePrefix(decision: DecisionKind, reason: string | null | undefined): Prefix {
  if (decision === "allow") return "APPROVE";
  const r = (reason ?? "").trimStart();
  if (r === "") return "STOP";
  if (r.startsWith("REVISE:")) return "REVISE";
  if (r.startsWith("EDIT:")) return "EDIT";
  if (/^STOP(?![A-Za-z0-9_])/.test(r)) return "STOP";
  return "NONE";
}

export type HandoffResult =
  | { ok: true; handoff: Record<string, unknown>; raw: string }
  | { ok: false; error: string; raw: string | null };

// ```json on its own line is the contract; a one-line "```json {...}```" (seen from Gemini) is accepted too.
const FENCE = /```json(?![A-Za-z0-9_])[ \t]*\r?\n?([\s\S]*?)```/gi;

/** The last fenced ```json block of the final message; must be an object with stage, status, outcome. */
export function extractHandoff(content: string | null | undefined): HandoffResult {
  if (!content) return { ok: false, error: "no final message", raw: null };
  const blocks = [...content.matchAll(FENCE)].map((m) => m[1] ?? "");
  if (blocks.length === 0) return { ok: false, error: "no ```json block in the final message", raw: null };
  const raw = blocks[blocks.length - 1] as string;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `last json block is not valid JSON: ${(e as Error).message}`, raw };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "last json block is not an object", raw };
  }
  const obj = parsed as Record<string, unknown>;
  const missing = ["stage", "status", "outcome"].filter((k) => typeof obj[k] !== "string" || obj[k] === "");
  if (missing.length > 0) return { ok: false, error: `handoff missing ${missing.join(", ")}`, raw };
  return { ok: true, handoff: obj, raw };
}
