// What scripts/setup_agents.ts registers: agents/*.json and the skills they reference, rendered from shipgate.yaml.
// No network here; the script does the TrueForge calls. Errors are AgentSetupError (the script prints and exits 1).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderDeep, renderText } from "./render.ts";

export type SkillMode = "git" | "inline" | "none";
type Json = Record<string, unknown>;

export class AgentSetupError extends Error {}

export interface SkillRef {
  name: string;
  preload?: boolean;
}

export interface AgentFile {
  file: string;
  name: string;
  description: string;
  manifest: Json; // TrueForge gets only name, description and manifest (never "requires")
}

export interface LocalSkill {
  name: string;
  dir: string; // repo-relative, e.g. skills/ticket-resolver
  description: string;
  body: string; // SKILL.md without frontmatter
  extras: { file: string; content: string }[]; // other *.md files in the skill dir
  templated: boolean; // SKILL.md or an extra holds {{placeholders}} (filled at registration)
}

/** What shipgate.yaml provides to agent files that declare a top-level "requires". */
export interface Available {
  jira: boolean;
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/; // one directory under skills/, never a path
const REQUIREMENTS: readonly string[] = ["jira"];

function fail(message: string): never {
  throw new AgentSetupError(message);
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** agents/*.json, rendered. An agent whose "requires" is not available is logged and skipped before rendering, so
 *  neither it nor its skills are read any further. */
export function readAgents(
  root: string,
  values: Record<string, string>,
  available: Available,
  log: (s: string) => void = console.log,
): AgentFile[] {
  const dir = join(root, "agents");
  if (!existsSync(dir)) fail("agents/ directory not found");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) fail("no agents/*.json files found");
  const agents: AgentFile[] = [];
  for (const f of files) {
    const file = `agents/${f}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(root, file), "utf8"));
    } catch (err) {
      fail(`${file}: invalid JSON (${(err as Error).message})`);
    }
    if (!isObject(parsed)) fail(`${file}: expected a JSON object`);
    const { name, description, manifest, requires } = parsed;
    if (typeof name !== "string" || typeof description !== "string" || !isObject(manifest)) {
      fail(`${file}: needs string "name", string "description" and object "manifest"`);
    }
    if (requires !== undefined && !(typeof requires === "string" && REQUIREMENTS.includes(requires))) {
      fail(`${file}: "requires" must be one of ${REQUIREMENTS.join(", ")} (got ${JSON.stringify(requires)})`);
    }
    if (requires === "jira" && !available.jira) {
      log(`skip ${name} (no jira: in shipgate.yaml)`);
      continue;
    }
    try {
      agents.push(renderDeep({ file, name, description, manifest }, values, file));
    } catch (err) {
      fail((err as Error).message);
    }
  }
  return agents;
}

export function skillRefs(agent: AgentFile): SkillRef[] {
  const skills = agent.manifest.skills;
  if (skills === undefined) return [];
  if (!Array.isArray(skills)) fail(`${agent.file}: manifest.skills must be an array`);
  return skills.map((s) => {
    if (!isObject(s) || typeof s.name !== "string") fail(`${agent.file}: each skill needs a "name"`);
    if (!SKILL_NAME_RE.test(s.name)) fail(`${agent.file}: skill "${s.name}" must be one directory name under skills/`);
    return { name: s.name, preload: s.preload === true ? true : undefined };
  });
}

/** Minimal frontmatter parser: single-line `key: value` pairs between the leading `---` fences. */
export function readLocalSkill(root: string, name: string, values: Record<string, string>): LocalSkill {
  if (!SKILL_NAME_RE.test(name)) fail(`skill "${name}" must be one directory name under skills/`);
  const dir = `skills/${name}`;
  const path = join(root, dir, "SKILL.md");
  if (!existsSync(path)) fail(`${dir}/SKILL.md not found (referenced by an agent)`);
  const text = readFileSync(path, "utf8");
  let rendered: string;
  try {
    rendered = renderText(text, values, `${dir}/SKILL.md`);
  } catch (err) {
    fail((err as Error).message);
  }
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(rendered);
  if (match === null) fail(`${dir}/SKILL.md has no YAML frontmatter`);
  const meta = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv?.[1] !== undefined && kv[2] !== undefined) meta.set(kv[1], kv[2].replace(/^["']|["']$/g, "").trim());
  }
  if (meta.get("name") !== name) fail(`${dir}/SKILL.md frontmatter name must be "${name}"`);
  const description = meta.get("description");
  if (description === undefined || description === "") fail(`${dir}/SKILL.md frontmatter needs a description`);
  // Only regular files directly in this skill's own directory; they reach only agents that reference this skill.
  let templated = text.includes("{{");
  const extras = readdirSync(join(root, dir), { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md") && d.name !== "SKILL.md")
    .map((d) => d.name)
    .sort()
    .map((f) => {
      const raw = readFileSync(join(root, dir, f), "utf8").trim();
      templated ||= raw.includes("{{");
      try {
        return { file: f, content: renderText(raw, values, `${dir}/${f}`) };
      } catch (err) {
        fail((err as Error).message);
      }
    });
  return { name, dir, description, body: rendered.slice(match[0].length).trim(), extras, templated };
}

/** Git mode registers skills/<name> at a git ref and the sandbox reads that raw file, so a template would reach the
 *  agent with literal {{placeholders}}. Refuse before anything is sent to TrueForge. */
export function refuseTemplatedGitSkills(skills: Iterable<LocalSkill>): void {
  const templated = [...skills].filter((s) => s.templated).map((s) => `${s.dir}/SKILL.md`);
  if (templated.length === 0) return;
  fail(
    `git skill mode cannot register ${templated.join(", ")}: {{placeholders}} are filled from shipgate.yaml at ` +
      "registration, but the sandbox would read the raw file with a literal {{repo}}. Nothing was changed on the " +
      "server.\n  Use --inline-skill (what scripts/setup.sh does).",
  );
}

export function inlineSkillText(skill: LocalSkill): string {
  const parts = [
    `<skill name="${skill.name}" source="${skill.dir}/SKILL.md" inlined="true">`,
    "The SKILL.md content below is inlined into this prompt: do not look for it in the sandbox.",
    "",
    skill.body,
  ];
  for (const extra of skill.extras) {
    parts.push("", `<skill_file name="${extra.file}">`, extra.content, "</skill_file>");
  }
  parts.push("</skill>");
  return parts.join("\n");
}

/** The manifest sent for one agent. Inline mode appends only the skills this agent references. */
export function buildManifest(agent: AgentFile, mode: SkillMode, skills: Map<string, LocalSkill>): Json {
  const manifest: Json = structuredClone(agent.manifest);
  const refs = skillRefs(agent);
  if (mode === "git") {
    manifest.skills = refs.map((r) => {
      if (r.preload === true) {
        console.warn(`  ! ${agent.file}: skill "${r.name}" preload=true; TrueForge 0.2.1 rejects preload for git skills, sending false`);
      }
      return { name: r.name, preload: false };
    });
    return manifest;
  }
  delete manifest.skills;
  if (mode === "inline" && refs.length > 0) {
    const base = typeof manifest.instructions === "string" ? manifest.instructions : "";
    const inlined = refs.map((r) => {
      const skill = skills.get(r.name);
      if (skill === undefined) fail(`internal: skill ${r.name} not loaded`);
      return inlineSkillText(skill);
    });
    manifest.instructions = [base, ...inlined].filter((s) => s !== "").join("\n\n");
  }
  return manifest;
}
