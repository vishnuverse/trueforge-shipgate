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

// ---------- ticket-resolver-jira ----------

const JIRA_SKILL = readFileSync(join(ROOT, "skills", "ticket-resolver-jira", "SKILL.md"), "utf8");
const JIRA_AGENT = JSON.parse(readFileSync(join(ROOT, "agents", "ticket-resolver-jira.json"), "utf8")) as unknown;
const GITHUB_ISSUE_ONLY = ["issue_read", "add_issue_comment", "list_issues", "gh#", "fix/issue-", "test_issue_"];

test("the Jira templates are templates", () => {
  assert.ok(JIRA_SKILL.includes("{{repo}}") && JIRA_SKILL.includes("{{tests_dir}}") && JIRA_SKILL.includes("{{default_branch}}"));
  assert.ok(JSON.stringify(JIRA_AGENT).includes("{{model}}"));
});

for (const [label, values] of [
  ["humanize", humanize],
  ["acme", acme],
] as const) {
  test(`${label} config renders the Jira skill and agent with Jira tools only`, () => {
    const skill = renderText(JIRA_SKILL, values, "ticket-resolver-jira/SKILL.md");
    const agent = JSON.stringify(renderDeep(JIRA_AGENT, values, "agent"));
    for (const text of [skill, agent]) {
      for (const want of ["getJiraIssue", "addOrEditJiraIssueComment", "triage_jira_ticket"]) assert.ok(text.includes(want), want);
      for (const bad of GITHUB_ISSUE_ONLY) assert.ok(!text.includes(bad), `GitHub-issue term '${bad}' in the Jira agent`);
    }
    assert.ok(skill.includes('contentFormat: "markdown"} with the <reply>'), "Gate 2 posts markdown");
    const commentIdLines = skill.split("\n").filter((l) => l.includes("commentId"));
    assert.ok(commentIdLines.length > 0);
    for (const line of commentIdLines) assert.match(line, /\bnever\b/i, `commentId outside a "never" rule: ${line}`);
    assert.ok(skill.includes(`EVIDENCE · KEY · ${values.repo} @ <sha7>`));
    assert.ok(skill.includes("Fixes KEY (TICKET_URL)") && skill.includes("Title `fix: <what now works> (KEY)`"));
    assert.ok(skill.includes(`head: "${values.owner}:BRANCH"`));
    assert.ok(skill.includes(`create_pull_request BRANCH → ${values.default_branch}`));
  });
}

test("another repo leaves no demo or Jira-site names in the Jira skill outside the labelled examples", () => {
  const skill = outsideExamples(renderText(JIRA_SKILL, acme, "SKILL.md"));
  for (const bad of ["vishnuverse", "drax0945", "src/humanize", "python-humanize", "benchmark-disable"]) {
    assert.ok(!skill.includes(bad), bad);
  }
  for (const bad of ["humanize", "naturaltime", "freezegun", "ordinal", "django"]) {
    assert.ok(!skill.toLowerCase().includes(bad), `demo-repo fact '${bad}' stated outside a labelled example`);
  }
  for (const bad of ["KAN-", "kan-4", "kan_4", "developertunnel", "ce61dd8b"]) {
    assert.ok(!skill.includes(bad), `demo Jira value '${bad}' outside a labelled example`);
  }
  assert.ok(!/\bmain\b/.test(skill), "default branch 'main' left in the skill");
  assert.ok(skill.includes("acme/widgets") && skill.includes("widgets/<file>") && skill.includes("test/test_<module>.py"));
  assert.ok(skill.includes("BRANCH → trunk") && skill.includes("TEST_FILE (new, +c)"));
  assert.ok(!/(^|[\s`"'(])src\//m.test(skill), "bare src/ left in the skill");
  const agent = JSON.stringify(renderDeep(JIRA_AGENT, acme, "agent"));
  assert.ok(!agent.includes("vishnuverse") && !agent.includes("drax0945") && agent.includes("openrouter/glm-5-3-flash"));
  assert.ok(agent.includes("acme/widgets") && agent.includes('owner \\"acme\\" and repo \\"widgets\\"'));
});

test("the Jira skill's worked examples use the demo ticket's names", () => {
  const skill = renderText(JIRA_SKILL, humanize, "SKILL.md");
  const lines = skill.split("\n");
  const mask = exampleMask(lines);
  const examples = lines.filter((_, i) => mask[i]).join("\n");
  for (const want of [
    "EVIDENCE · KAN-4 · vishnuverse/humanize @ 9f3e2a1",
    "Fixes KAN-4 (https://developertunnel.atlassian.net/browse/KAN-4)",
    "fix/kan-4",
    "tests/test_kan_4.py",
    '"ticket": "KAN-4"',
    '{"tool": "addOrEditJiraIssueComment", "decision": "allow", "mode": "script"}',
  ]) {
    assert.ok(examples.includes(want), want);
  }
});

test("exampleMask covers fenced and unfenced examples", () => {
  const lines = ["x", "Example (a):", "~~~", "in", "~~~", "y", "Example (b):", "text", "</reply>", "z"];
  assert.deepEqual(exampleMask(lines), [false, true, true, true, true, false, true, true, false, false]);
});
