// The Jira skill is the GitHub skill adapted: same sections, rule numbers and step numbers, so a fix to one is easy to
// carry to the other and the handoff/scorer contract stays the same.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "../src/config.ts";

const GITHUB = readFileSync(join(ROOT, "skills", "ticket-resolver", "SKILL.md"), "utf8");
const JIRA = readFileSync(join(ROOT, "skills", "ticket-resolver-jira", "SKILL.md"), "utf8");

/** Section tags that stand on their own line, in order: <role>, </role>, <hard_rules>, ... */
function tags(text: string): string[] {
  return text.split("\n").filter((l) => /^<\/?[a-z_]+>$/.test(l));
}

function section(text: string, tag: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(`<${tag}>`);
  const end = lines.indexOf(`</${tag}>`);
  assert.ok(start >= 0 && end > start, `<${tag}> section`);
  return lines.slice(start + 1, end);
}

/** List markers with their indent: "1.", "6b.", "   0.", "   a.", "   1)". */
function markers(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = /^( *)(\d+b?\.|[a-d]\.|\d\))\s/.exec(line);
    if (m) out.push(`${m[1]}${m[2]}`);
  }
  return out;
}

/** First cells of a section's markdown table rows (header and separator rows excluded). */
function tableKeys(lines: string[], column: "first" | "last"): string[] {
  return lines
    .filter((l) => l.startsWith("| ") && !l.startsWith("| ---"))
    .map((l) => {
      const cells = l.split(" | ");
      return (column === "first" ? cells[0] : cells.at(-1))?.replace(/^\| |\s*\|$/g, "").trim() ?? "";
    });
}

test("same XML sections in the same order", () => {
  const want = tags(GITHUB);
  assert.ok(want.length >= 20, `found ${want.length} section tags`);
  assert.deepEqual(tags(JIRA), want);
});

test("same hard-rule numbers, 1 to 12", () => {
  const numbers = (text: string) => markers(section(text, "hard_rules")).filter((m) => !m.startsWith(" "));
  assert.deepEqual(numbers(GITHUB), Array.from({ length: 12 }, (_, i) => `${i + 1}.`));
  assert.deepEqual(numbers(JIRA), numbers(GITHUB));
});

test("same procedure step numbers, including 3.0 SUMMARY, 3a-d, 6b and the five evidence checks", () => {
  const steps = markers(section(GITHUB, "procedure"));
  for (const want of ["1.", "3.", "   0.", "   a.", "   d.", "6b.", "   1)", "   5)", "12."]) assert.ok(steps.includes(want), want);
  assert.deepEqual(markers(section(JIRA, "procedure")), steps);
  const summary = (text: string) => section(text, "procedure").find((l) => l.startsWith("   0. "));
  assert.match(summary(JIRA) ?? "", /^ {3}0\. SUMMARY = /);
});

test("same shell rules, approval protocol rows, push-back outcomes and approver rules", () => {
  assert.deepEqual(markers(section(JIRA, "shell_rules")), markers(section(GITHUB, "shell_rules")));
  assert.deepEqual(tableKeys(section(JIRA, "approval_protocol"), "first"), tableKeys(section(GITHUB, "approval_protocol"), "first"));
  const outcomes = (text: string) => tableKeys(section(text, "pushback"), "last");
  assert.deepEqual(outcomes(JIRA), outcomes(GITHUB));
  assert.ok(outcomes(GITHUB).includes("security_redirect") && outcomes(GITHUB).includes("T1"));
});

test("same frontmatter keys; the Jira skill names itself", () => {
  const front = (text: string) => (/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "").split("\n").map((l) => l.split(":")[0]);
  assert.deepEqual(front(JIRA), front(GITHUB));
  assert.ok(JIRA.startsWith("---\nname: ticket-resolver-jira\n"));
});
