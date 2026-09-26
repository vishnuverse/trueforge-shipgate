import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, loadConfig } from "../src/config.ts";
import { RenderError, exampleMask, renderDeep, renderText, templateValues } from "../src/render.ts";

const SKILL = readFileSync(join(ROOT, "skills", "ticket-resolver", "SKILL.md"), "utf8");
const AGENT = JSON.parse(readFileSync(join(ROOT, "agents", "ticket-resolver.json"), "utf8")) as unknown;
const FIX = join(ROOT, "tests", "fixtures", "skill");
const humanize = templateValues(loadConfig(join(ROOT, "shipgate.yaml")));
const acme = templateValues(loadConfig(join(FIX, "acme.yaml")));

function outsideExamples(text: string): string {
  const lines = text.split("\n");
  const mask = exampleMask(lines);
  return lines.filter((_, i) => !mask[i]).join("\n");
}

test("renderText fills values and inserts them literally", () => {
  assert.equal(renderText("a {{repo}} b {{ name }}", { repo: "x/$&y", name: "n" }), "a x/$&y b n");
});

test("renderText refuses a missing value or a leftover '{{'", () => {
  assert.throws(() => renderText("{{nope}}", {}), RenderError);
  assert.throws(() => renderText("{{repo}} {{", { repo: "r" }), RenderError);
});

test("renderDeep walks JSON", () => {
  assert.deepEqual(renderDeep({ a: ["{{x}}", 1, { b: "{{x}}!" }] }, { x: "q" }), { a: ["q", 1, { b: "q!" }] });
});

test("the templates are templates", () => {
  assert.ok(SKILL.includes("{{repo}}") && SKILL.includes("{{tests_dir}}") && SKILL.includes("{{default_branch}}"));
  assert.ok(JSON.stringify(AGENT).includes("{{model}}"));
});

test("humanize config renders the golden skill and agent", () => {
  assert.equal(renderText(SKILL, humanize, "SKILL.md"), readFileSync(join(FIX, "ticket-resolver.humanize.md"), "utf8"));
  assert.deepEqual(
    renderDeep(AGENT, humanize, "agent"),
    JSON.parse(readFileSync(join(FIX, "ticket-resolver.humanize.json"), "utf8")),
  );
});

test("another repo leaves no demo names outside the labelled examples", () => {
  const skill = outsideExamples(renderText(SKILL, acme, "SKILL.md"));
  for (const bad of ["vishnuverse", "drax0945", "src/humanize", "python-humanize", "benchmark-disable"]) {
    assert.ok(!skill.includes(bad), bad);
  }
  for (const bad of ["humanize", "naturaltime", "freezegun", "ordinal", "django"]) {
    assert.ok(!skill.toLowerCase().includes(bad), `demo-repo fact '${bad}' stated outside a labelled example`);
  }
  assert.ok(!/\bmain\b/.test(skill), "default branch 'main' left in the skill");
  assert.ok(skill.includes("acme/widgets") && skill.includes("widgets/<file>") && skill.includes("test/test_issue_<n>.py"));
  assert.ok(skill.includes("fix/issue-<n> → trunk"));
  assert.ok(!/(^|[\s`"'(])src\//m.test(skill), "bare src/ left in the skill");
  const agent = JSON.stringify(renderDeep(AGENT, acme, "agent"));
  assert.ok(!agent.includes("vishnuverse") && !agent.includes("drax0945") && agent.includes("openrouter/glm-5-3-flash"));
});

test("exampleMask covers fenced and unfenced examples", () => {
  const lines = ["x", "Example (a):", "~~~", "in", "~~~", "y", "Example (b):", "text", "</reply>", "z"];
  assert.deepEqual(exampleMask(lines), [false, true, true, true, true, false, true, true, false, false]);
});
