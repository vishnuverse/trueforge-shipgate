/**
 * Upsert shipgate's skills and agents into a TrueForge server (0.2.1 API).
 *
 *   npx --yes tsx scripts/setup_agents.ts [--skill-ref <sha|branch>] [--no-skill] [--inline-skill]
 *
 * Default (git mode): registers every skill that an agent in agents/*.json references as a git skill
 * (PUT /api/v1/settings/skills, url = this repo, path = skills/<name>, ref = --skill-ref or `git rev-parse HEAD`),
 * then creates or updates each agent (POST /api/v1/agents or PUT /api/v1/agents/{id}).
 *   --inline-skill  dev mode, before the skill is pushed: append SKILL.md (and any other *.md in the skill dir) to
 *                   manifest.instructions and drop manifest.skills; no skill is registered.
 *   --no-skill      register the agents without skills; no skill is registered.
 *
 * TRUEFORGE_URL (env or .env) defaults to http://localhost:8790. No npm dependencies (Node >= 22 fetch).
 * Notes (TrueForge 0.2.1): git skills cannot be preloaded (the server answers 422), and the sandbox downloads a git
 * skill from GitHub at session start, so the repo must be public and the ref pushed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKILL_REPO_URL = "https://github.com/vishnuverse/trueforge-shipgate";
const RAW_BASE = "https://raw.githubusercontent.com/vishnuverse/trueforge-shipgate";
const GIT_REF_RE = /^[A-Za-z0-9._\-/]+$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

type SkillMode = "git" | "inline" | "none";
type Json = Record<string, unknown>;

interface Options {
  mode: SkillMode;
  skillRef: string | undefined;
}

interface SkillRef {
  name: string;
  preload?: boolean;
}

interface AgentFile {
  file: string;
  name: string;
  description: string;
  manifest: Json;
}

interface LocalSkill {
  name: string;
  dir: string; // repo-relative, e.g. skills/ticket-resolver
  description: string;
  body: string; // SKILL.md without frontmatter
  extras: { file: string; content: string }[]; // other *.md files in the skill dir
}

const USAGE = "usage: npx --yes tsx scripts/setup_agents.ts [--skill-ref <sha|branch>] [--no-skill] [--inline-skill]";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  let skillRef: string | undefined;
  let inline = false;
  let none = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--skill-ref") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) fail(`--skill-ref needs a value\n${USAGE}`);
      skillRef = value;
    } else if (arg.startsWith("--skill-ref=")) {
      skillRef = arg.slice("--skill-ref=".length);
    } else if (arg === "--inline-skill") {
      inline = true;
    } else if (arg === "--no-skill") {
      none = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  if (inline && none) fail("--inline-skill and --no-skill are mutually exclusive");
  if (skillRef !== undefined && (inline || none)) fail("--skill-ref only applies to git mode");
  return { mode: inline ? "inline" : none ? "none" : "git", skillRef };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repoRoot(): string {
  try {
    return git(["rev-parse", "--show-toplevel"], process.cwd());
  } catch {
    fail("run this from inside the trueforge-shipgate git checkout");
  }
}

function loadDotEnv(root: string): void {
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch (err) {
    console.warn(`! could not read .env: ${(err as Error).message}`);
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAgents(root: string): AgentFile[] {
  const dir = join(root, "agents");
  if (!existsSync(dir)) fail("agents/ directory not found");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) fail("no agents/*.json files found");
  return files.map((f) => {
    const file = `agents/${f}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(root, file), "utf8"));
    } catch (err) {
      fail(`${file}: invalid JSON (${(err as Error).message})`);
    }
    if (!isObject(parsed)) fail(`${file}: expected a JSON object`);
    const { name, description, manifest } = parsed;
    if (typeof name !== "string" || typeof description !== "string" || !isObject(manifest)) {
      fail(`${file}: needs string "name", string "description" and object "manifest"`);
    }
    return { file, name, description, manifest };
  });
}

function skillRefs(agent: AgentFile): SkillRef[] {
  const skills = agent.manifest.skills;
  if (skills === undefined) return [];
  if (!Array.isArray(skills)) fail(`${agent.file}: manifest.skills must be an array`);
  return skills.map((s) => {
    if (!isObject(s) || typeof s.name !== "string") fail(`${agent.file}: each skill needs a "name"`);
    return { name: s.name, preload: s.preload === true ? true : undefined };
  });
}

/** Minimal frontmatter parser: single-line `key: value` pairs between the leading `---` fences. */
function readLocalSkill(root: string, name: string): LocalSkill {
  const dir = `skills/${name}`;
  const path = join(root, dir, "SKILL.md");
  if (!existsSync(path)) fail(`${dir}/SKILL.md not found (referenced by an agent)`);
  const text = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (match === null) fail(`${dir}/SKILL.md has no YAML frontmatter`);
  const meta = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv?.[1] !== undefined && kv[2] !== undefined) meta.set(kv[1], kv[2].replace(/^["']|["']$/g, "").trim());
  }
  if (meta.get("name") !== name) fail(`${dir}/SKILL.md frontmatter name must be "${name}"`);
  const description = meta.get("description");
  if (description === undefined || description === "") fail(`${dir}/SKILL.md frontmatter needs a description`);
  const extras = readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".md") && f !== "SKILL.md")
    .sort()
    .map((f) => ({ file: f, content: readFileSync(join(root, dir, f), "utf8").trim() }));
  return { name, dir, description, body: text.slice(match[0].length).trim(), extras };
}

class TrueForge {
  constructor(private readonly base: string) {}

  async call(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<Json> {
    const url = `${this.base}/api/v1${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      fail(
        `cannot reach TrueForge at ${this.base} (${(err as Error).message}).\n` +
          "  Start it with: npx --yes @truefoundry/trueforge@0.2.1   (or set TRUEFORGE_URL)",
      );
    }
    const text = await res.text();
    let parsed: unknown = {};
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    if (!res.ok) {
      // TrueForge errors look like {"error": {"message": "..."}}.
      const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : {};
      const detail = typeof error.message === "string" ? error.message : text.slice(0, 500);
      throw new Error(`${method} ${path} → HTTP ${res.status}: ${detail}`);
    }
    return isObject(parsed) ? parsed : { data: parsed };
  }

  async findAgentId(name: string): Promise<string | undefined> {
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ agent_name: name, limit: "100" });
      if (pageToken !== undefined) qs.set("page_token", pageToken);
      const res = await this.call("GET", `/agents?${qs.toString()}`);
      const data = Array.isArray(res.data) ? res.data : [];
      for (const a of data) {
        if (isObject(a) && a.name === name && typeof a.id === "string") return a.id;
      }
      const pagination = isObject(res.pagination) ? res.pagination : {};
      pageToken = typeof pagination.next_page_token === "string" ? pagination.next_page_token : undefined;
    } while (pageToken !== undefined);
    return undefined;
  }
}

/** Best-effort checks that the sandbox will be able to download the git skill; warnings only. */
async function checkSkillReachable(root: string, skill: LocalSkill, ref: string): Promise<void> {
  try {
    const dirty = git(["status", "--porcelain", "--", skill.dir], root);
    if (dirty !== "") console.warn(`  ! ${skill.dir} has uncommitted changes; ref ${ref} does not contain them`);
  } catch {
    /* not fatal */
  }
  if (FULL_SHA_RE.test(ref)) {
    try {
      if (git(["branch", "-r", "--contains", ref], root) === "") {
        console.warn(`  ! commit ${ref.slice(0, 7)} is not on any remote-tracking branch (not pushed?)`);
      }
    } catch {
      console.warn(`  ! commit ${ref.slice(0, 7)} is unknown to this checkout`);
    }
  }
  const url = `${RAW_BASE}/${ref}/${skill.dir}/SKILL.md`;
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      console.log(`  ✓ public on GitHub: ${skill.dir}/SKILL.md @ ${ref}`);
    } else {
      console.warn(
        `  ! ${url} → HTTP ${res.status}: the sandbox cannot download this skill yet ` +
          "(ref not pushed, path missing on that ref, or repo private). Sessions will run without it; " +
          "use --inline-skill until it is pushed.",
      );
    }
  } catch (err) {
    console.warn(`  ! could not check ${url}: ${(err as Error).message}`);
  }
}

function inlineSkillText(skill: LocalSkill): string {
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

function buildManifest(agent: AgentFile, mode: SkillMode, skills: Map<string, LocalSkill>): Json {
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

function describeAgent(saved: Json): string {
  const manifest = isObject(saved.manifest) ? saved.manifest : {};
  const model = isObject(manifest.model) ? String(manifest.model.name) : "?";
  const servers = Array.isArray(manifest.mcp_servers) ? manifest.mcp_servers.filter(isObject) : [];
  const gated = servers.flatMap((s) =>
    Array.isArray(s.require_approval_for_tools) ? s.require_approval_for_tools.map((t) => `${String(s.name)}:${String(t)}`) : [],
  );
  const skills = Array.isArray(manifest.skills)
    ? manifest.skills.filter(isObject).map((s) => String(s.name))
    : [];
  const config = isObject(manifest.config) ? manifest.config : {};
  const sandbox = isObject(config.sandbox) && config.sandbox.enabled === true ? "on" : "off";
  const instructions = typeof manifest.instructions === "string" ? manifest.instructions.length : 0;
  return (
    `model ${model} · sandbox ${sandbox} · skills [${skills.join(", ") || "none"}] · ` +
    `gated [${gated.join(", ") || "none"}] · instructions ${instructions} chars`
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  loadDotEnv(root);
  const base = (process.env.TRUEFORGE_URL ?? "http://localhost:8790").replace(/\/+$/, "");
  const tf = new TrueForge(base);
  const agents = readAgents(root);

  console.log(`TrueForge ${base} · skill mode: ${opts.mode}`);

  const skillNames = [...new Set(agents.flatMap((a) => skillRefs(a).map((r) => r.name)))];
  const skills = new Map<string, LocalSkill>();
  if (opts.mode !== "none") {
    for (const name of skillNames) skills.set(name, readLocalSkill(root, name));
  }

  if (opts.mode === "git") {
    const ref = opts.skillRef ?? git(["rev-parse", "HEAD"], root);
    if (!GIT_REF_RE.test(ref)) fail(`invalid git ref: ${ref}`);
    for (const skill of skills.values()) {
      console.log(`skill ${skill.name}: git ${SKILL_REPO_URL} path ${skill.dir} ref ${ref}`);
      await checkSkillReachable(root, skill, ref);
      try {
        await tf.call("PUT", "/settings/skills", {
          manifest: {
            type: "git",
            name: skill.name,
            url: SKILL_REPO_URL,
            path: skill.dir,
            ref,
            description: skill.description,
          },
        });
      } catch (err) {
        fail(`skill ${skill.name}: ${(err as Error).message}`);
      }
      console.log(`  ✓ upserted (PUT /settings/skills)`);
    }
  } else if (skillNames.length > 0) {
    console.log(
      opts.mode === "inline"
        ? `skills [${skillNames.join(", ")}]: inlined into instructions, not registered`
        : `skills [${skillNames.join(", ")}]: skipped (--no-skill); agents run without their procedure`,
    );
  }

  let failures = 0;
  for (const agent of agents) {
    const manifest = buildManifest(agent, opts.mode, skills);
    try {
      const id = await tf.findAgentId(agent.name);
      const res =
        id === undefined
          ? await tf.call("POST", "/agents", { name: agent.name, description: agent.description, manifest })
          : await tf.call("PUT", `/agents/${encodeURIComponent(id)}`, { description: agent.description, manifest });
      const saved = isObject(res.data) ? res.data : {};
      const savedId = typeof saved.id === "string" ? saved.id : (id ?? "?");
      console.log(`agent ${agent.name}: ${id === undefined ? "created" : "updated"} (id ${savedId}) from ${agent.file}`);
      console.log(`  ${describeAgent(saved)}`);
    } catch (err) {
      failures++;
      console.error(`✗ agent ${agent.name} (${agent.file}): ${(err as Error).message}`);
    }
  }
  if (failures > 0) process.exit(1);
  console.log("done");
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
