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
 *   --skip-skill-check  register a git skill even if raw.githubusercontent.com cannot serve its SKILL.md.
 *
 * An agent file with a top-level "requires": "jira" is registered only when shipgate.yaml has a jira: section;
 * otherwise it is skipped before its skills are read. "requires" is never sent to TrueForge.
 * Git mode refuses a skill whose SKILL.md is a template ({{...}} filled from shipgate.yaml): the sandbox would read
 * the raw file with literal placeholders. Use --inline-skill (what scripts/setup.sh does).
 * A skill directory's extra *.md files go only to the agents that reference that skill.
 *
 * TRUEFORGE_URL (env or .env) defaults to http://localhost:8790. Uses orchestrator/src/config.ts, render.ts and
 * agents.ts (reading and building agents; unit-tested there) (run `npm --prefix orchestrator ci` first).
 * Notes (TrueForge 0.2.1, verified): git skills cannot be preloaded (the server answers 422). The server stores a git
 * skill without checking it; the sandbox downloads it at its first exec, and if the repo is private, the ref is not
 * pushed or the path is missing, the downloader exits 1 and sandbox init fails, so every exec in that session fails.
 * That is why git mode refuses an unreachable skill unless --skip-skill-check is given.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../orchestrator/src/config.ts";
import {
  type Available,
  type LocalSkill,
  type SkillMode,
  buildManifest,
  readAgents,
  readLocalSkill,
  refuseTemplatedGitSkills,
  skillRefs,
} from "../orchestrator/src/agents.ts";
import { RenderError, templateValues } from "../orchestrator/src/render.ts";

const SKILL_REPO_URL = "https://github.com/vishnuverse/trueforge-shipgate";
const RAW_BASE = "https://raw.githubusercontent.com/vishnuverse/trueforge-shipgate";
const GIT_REF_RE = /^[A-Za-z0-9._\-/]+$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

type Json = Record<string, unknown>;

interface Options {
  mode: SkillMode;
  skillRef: string | undefined;
  skipSkillCheck: boolean;
}

const USAGE =
  "usage: npx --yes tsx scripts/setup_agents.ts [--skill-ref <sha|branch>] [--no-skill] [--inline-skill] [--skip-skill-check]";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Options {
  let skillRef: string | undefined;
  let inline = false;
  let none = false;
  let skipSkillCheck = false;
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
    } else if (arg === "--skip-skill-check") {
      skipSkillCheck = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  if (inline && none) fail("--inline-skill and --no-skill are mutually exclusive");
  if ((skillRef !== undefined || skipSkillCheck) && (inline || none)) {
    fail("--skill-ref and --skip-skill-check only apply to git mode");
  }
  return { mode: inline ? "inline" : none ? "none" : "git", skillRef, skipSkillCheck };
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

/**
 * Checks that the sandbox will be able to download the git skill (it fetches anonymously from GitHub).
 * Returns true = SKILL.md is public at that ref, false = definitely not (HTTP 404 etc.), undefined = could not check.
 */
async function checkSkillReachable(root: string, skill: LocalSkill, ref: string): Promise<boolean | undefined> {
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
      return true;
    }
    console.warn(
      `  ! ${url} → HTTP ${res.status}: the sandbox cannot download this skill ` +
        "(repo private, ref not pushed, or path missing on that ref); sandbox init would fail in every session.",
    );
    return false;
  } catch (err) {
    console.warn(`  ! could not check ${url}: ${(err as Error).message}`);
    return undefined;
  }
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
  let values: Record<string, string>;
  let configUrl: string;
  let available: Available;
  try {
    const cfg = loadConfig();
    values = templateValues(cfg);
    configUrl = cfg.trueforgeUrl;
    available = { jira: cfg.jira !== null };
  } catch (err) {
    if (err instanceof ConfigError || err instanceof RenderError) fail(err.message);
    throw err;
  }
  const base = (process.env.TRUEFORGE_URL ?? configUrl).replace(/\/+$/, "");
  const tf = new TrueForge(base);

  console.log(`TrueForge ${base} · skill mode: ${opts.mode}`);
  // Agents whose "requires" is missing are skipped here, before skill names are collected: their skills are never read.
  const agents = readAgents(root, values, available);

  const skillNames = [...new Set(agents.flatMap((a) => skillRefs(a).map((r) => r.name)))];
  const skills = new Map<string, LocalSkill>();
  if (opts.mode !== "none") {
    for (const name of skillNames) skills.set(name, readLocalSkill(root, name, values));
  }

  if (opts.mode === "git") {
    refuseTemplatedGitSkills(skills.values()); // before any skill check or server call
    const ref = opts.skillRef ?? git(["rev-parse", "HEAD"], root);
    if (!GIT_REF_RE.test(ref)) fail(`invalid git ref: ${ref}`);
    for (const skill of skills.values()) {
      console.log(`skill ${skill.name}: git ${SKILL_REPO_URL} path ${skill.dir} ref ${ref}`);
      const reachable = await checkSkillReachable(root, skill, ref);
      if (reachable === false && !opts.skipSkillCheck) {
        fail(
          `refusing to register skill ${skill.name} @ ${ref}: nothing was changed on the server.\n` +
            "  Push the ref (repo must be public), or use --inline-skill; --skip-skill-check overrides this check.",
        );
      }
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
      // The body carries only name, description and manifest: never "requires" or the file path.
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
