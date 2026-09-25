import assert from "node:assert/strict";
import { test } from "node:test";
import { extractHandoff, parsePrefix } from "../src/protocol.ts";

test("prefix: allow is APPROVE regardless of reason", () => {
  assert.equal(parsePrefix("allow", null), "APPROVE");
  assert.equal(parsePrefix("allow", "REVISE: x"), "APPROVE");
});

test("prefix: REVISE / EDIT / STOP, case-sensitive, leading whitespace ignored", () => {
  assert.equal(parsePrefix("deny", "REVISE: start the PR title with 'fix(ordinal):'"), "REVISE");
  assert.equal(parsePrefix("deny", "  \nREVISE: x"), "REVISE");
  assert.equal(parsePrefix("deny", "EDIT: exact reply text"), "EDIT");
  assert.equal(parsePrefix("deny", "\tEDIT:multi\nline"), "EDIT");
  assert.equal(parsePrefix("deny", "STOP"), "STOP");
  assert.equal(parsePrefix("deny", "STOP: not today"), "STOP");
  assert.equal(parsePrefix("deny", " STOP"), "STOP");
});

test("prefix: anything else is NONE; empty deny reason is STOP (SPEC §4.5)", () => {
  assert.equal(parsePrefix("deny", "revise: lowercase"), "NONE");
  assert.equal(parsePrefix("deny", "Edit: capitalised"), "NONE");
  assert.equal(parsePrefix("deny", "stop"), "NONE");
  assert.equal(parsePrefix("deny", "STOPPED"), "NONE");
  assert.equal(parsePrefix("deny", "REVISE without colon"), "NONE");
  assert.equal(parsePrefix("deny", "setup smoke test: gate verified, not needed"), "NONE");
  assert.equal(parsePrefix("deny", ""), "STOP");
  assert.equal(parsePrefix("deny", "   "), "STOP");
  assert.equal(parsePrefix("deny", null), "STOP");
});

const GOOD = '{"stage": "resolve", "status": "ok", "outcome": "fixed", "reason": "done"}';

test("handoff: none", () => {
  assert.deepEqual(extractHandoff(null), { ok: false, error: "no final message", raw: null });
  const r = extractHandoff("All done, no block here.");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /no ```json block/);
  // a non-json fence does not count
  assert.equal(extractHandoff("```text\n{}\n```").ok, false);
});

test("handoff: one block", () => {
  const r = extractHandoff(`Summary line.\n\n\`\`\`json\n${GOOD}\n\`\`\`\n`);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.handoff.outcome, "fixed");
});

test("handoff: a one-line fence is accepted; ```jsonc is not a json fence", () => {
  const r = extractHandoff('Denied.\n```json {"stage": "smoke", "status": "aborted", "outcome": "stopped"}```');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.handoff.outcome, "stopped");
  assert.equal(extractHandoff(`\`\`\`jsonc\n${GOOD}\n\`\`\``).ok, false);
});

test("handoff: several blocks -> the last one wins", () => {
  const text = [
    "Evidence:",
    "```json",
    '{"stage": "resolve", "status": "failed", "outcome": "could_not_fix"}',
    "```",
    "Then later:",
    "```json",
    GOOD,
    "```",
  ].join("\n");
  const r = extractHandoff(text);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.handoff.status, "ok");
});

test("handoff: last block invalid even if an earlier one is valid", () => {
  const text = `\`\`\`json\n${GOOD}\n\`\`\`\n\n\`\`\`json\n{"stage": "resolve", "status": \n\`\`\``;
  const r = extractHandoff(text);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /not valid JSON/);
});

test("handoff: must be an object with stage, status, outcome", () => {
  assert.equal(extractHandoff("```json\n[1,2]\n```").ok, false);
  const r = extractHandoff('```json\n{"stage": "resolve", "status": "ok"}\n```');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /missing outcome/);
});
