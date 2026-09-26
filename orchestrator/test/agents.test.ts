// What scripts/setup_agents.ts registers (src/agents.ts), without a server: which agents, which skills each carries,
// and when git mode refuses.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AgentSetupError,
  type LocalSkill,
  buildManifest,
  readAgents,
  readLocalSkill,
  refuseTemplatedGitSkills,
  skillRefs,
} from "../src/agents.ts";
import { ROOT, loadConfig } from "../src/config.ts";
import { templateValues } from "../src/render.ts";

const values = templateValues(loadConfig(join(ROOT, "shipgate.yaml")));

function inlineManifests(available: { jira: boolean }): Map<string, Record<string, unknown>> {
  const agents = readAgents(ROOT, values, available, () => {});
  const skills = new Map<string, LocalSkill>();
  for (const name of new Set(agents.flatMap((a) => skillRefs(a).map((r) => r.name)))) {
    skills.set(name, readLocalSkill(ROOT, name, values));
  }
  return new Map(agents.map((a) => [a.name, buildManifest(a, "inline", skills)]));
}

test("the Jira agent is skipped, with one log line, when shipgate.yaml has no jira: section", () => {
  const logs: string[] = [];
  const without = readAgents(ROOT, values, { jira: false }, (s) => logs.push(s));
  assert.deepEqual(without.map((a) => a.name), ["ticket-resolver"]);
  assert.deepEqual(logs, ["skip ticket-resolver-jira (no jira: in shipgate.yaml)"]);
  assert.deepEqual(without.flatMap((a) => skillRefs(a).map((r) => r.name)), ["ticket-resolver"]); // Jira skill never read
  const withJira = readAgents(ROOT, values, { jira: true }, (s) => logs.push(s));
  assert.deepEqual(withJira.map((a) => a.name).sort(), ["ticket-resolver", "ticket-resolver-jira"]);
  assert.equal(logs.length, 1);
});

test('"requires" is never part of what is sent to TrueForge', () => {
  for (const agent of readAgents(ROOT, values, { jira: true }, () => {})) {
    assert.deepEqual(Object.keys(agent).sort(), ["description", "file", "manifest", "name"]);
    assert.ok(!JSON.stringify(agent.manifest).includes("requires"));
  }
});

test('an unknown "requires" is refused', () => {
  const root = mkdtempSync(join(tmpdir(), "agents-"));
  mkdirSync(join(root, "agents"));
  writeFileSync(join(root, "agents", "x.json"), JSON.stringify({ name: "x", description: "d", manifest: {}, requires: "k8s" }));
  assert.throws(() => readAgents(root, values, { jira: true }, () => {}), AgentSetupError);
});

test("inline mode: each agent carries only its own skill", () => {
  const manifests = inlineManifests({ jira: true });
  const github = String(manifests.get("ticket-resolver")?.instructions);
  const jira = String(manifests.get("ticket-resolver-jira")?.instructions);
  assert.ok(github.includes('<skill name="ticket-resolver" source="skills/ticket-resolver/SKILL.md"'));
  assert.ok(jira.includes('<skill name="ticket-resolver-jira" source="skills/ticket-resolver-jira/SKILL.md"'));
  for (const bad of ["ticket-resolver-jira", "getJiraIssue", "addOrEditJiraIssueComment", "triage_jira_ticket"]) {
    assert.ok(!github.includes(bad), `${bad} leaked into ticket-resolver`);
  }
  for (const bad of ['<skill name="ticket-resolver" ', "issue_read", "add_issue_comment", "gh#", "fix/issue-"]) {
    assert.ok(!jira.includes(bad), `${bad} leaked into ticket-resolver-jira`);
  }
  assert.ok(!jira.includes("{{") && !github.includes("{{"));
  for (const m of manifests.values()) assert.equal(m.skills, undefined);
  // Without jira: the GitHub agent's manifest is byte-identical to the one built with jira.
  assert.deepEqual(inlineManifests({ jira: false }).get("ticket-resolver"), manifests.get("ticket-resolver"));
});

test("skill directories hold only SKILL.md, so no extra file is inlined into any agent", () => {
  for (const name of ["ticket-resolver", "ticket-resolver-jira"]) {
    assert.deepEqual(readdirSync(join(ROOT, "skills", name)).filter((f) => f.endsWith(".md")), ["SKILL.md"], name);
    assert.deepEqual(readLocalSkill(ROOT, name, values).extras, [], name);
  }
});

test("an extra .md reaches only the agents that reference its skill directory", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  for (const name of ["a", "b"]) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: skill ${name}\n---\nbody ${name}\n`);
  }
  writeFileSync(join(root, "skills", "a", "NOTES.md"), "only for a");
  mkdirSync(join(root, "skills", "a", "sub.md")); // a directory named like a file is not read
  const skills = new Map([
    ["a", readLocalSkill(root, "a", values)],
    ["b", readLocalSkill(root, "b", values)],
  ]);
  const agent = (name: string, skill: string) => ({ file: `agents/${name}.json`, name, description: "d", manifest: { skills: [{ name: skill }] } });
  assert.ok(String(buildManifest(agent("A", "a"), "inline", skills).instructions).includes("only for a"));
  assert.ok(!String(buildManifest(agent("B", "b"), "inline", skills).instructions).includes("only for a"));
  assert.throws(() => skillRefs(agent("C", "../a")), AgentSetupError);
  assert.throws(() => readLocalSkill(root, "a/../b", values), AgentSetupError);
});

test("git mode refuses templated skills and points at --inline-skill", () => {
  const real = [readLocalSkill(ROOT, "ticket-resolver", values), readLocalSkill(ROOT, "ticket-resolver-jira", values)];
  assert.ok(real.every((s) => s.templated));
  assert.throws(
    () => refuseTemplatedGitSkills(real),
    (e: unknown) =>
      e instanceof AgentSetupError &&
      e.message.includes("--inline-skill") &&
      e.message.includes("skills/ticket-resolver/SKILL.md") &&
      e.message.includes("skills/ticket-resolver-jira/SKILL.md"),
  );
  const root = mkdtempSync(join(tmpdir(), "plain-"));
  mkdirSync(join(root, "skills", "plain"), { recursive: true });
  writeFileSync(join(root, "skills", "plain", "SKILL.md"), "---\nname: plain\ndescription: no placeholders\n---\nbody\n");
  const plain = readLocalSkill(root, "plain", values);
  assert.equal(plain.templated, false);
  refuseTemplatedGitSkills([plain]); // does not throw
  writeFileSync(join(root, "skills", "plain", "EXTRA.md"), "see {{repo}}");
  assert.equal(readLocalSkill(root, "plain", values).templated, true); // a templated extra counts too
});
