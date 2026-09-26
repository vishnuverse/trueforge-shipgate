// Register what Ticket Resolver needs in TrueForge 0.2.1, and check it (spec any-repo §4 steps 4 and 6).
// REST bodies are snake_case; PUT on settings/* creates or replaces one entry by name. Keys are sent only to a
// loopback TrueForge (unless allowRemote), only when an entry is missing or rotateKeys is set, and never logged.
// With a jira: section in shipgate.yaml, the same holds for the `jira` connector and the ticket-resolver-jira agent.
import type { JiraConfig } from "./config.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export class SetupError extends Error {}
export interface Secrets {
  openrouterKey?: string;
  githubPat?: string;
  jiraEmail?: string; // JIRA_EMAIL: Atlassian account email
  jiraToken?: string; // JIRA_API_KEY: API token of that account
}
export interface SetupOptions {
  rotateKeys: boolean;
  allowRemote: boolean;
}
export interface Step {
  item: string;
  action: "created" | "kept" | "rotated";
}
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODELS = [
  {
    name: "deepseek-v4-flash",
    model_id: "deepseek/deepseek-v4-flash",
    properties: { context_length: 1048576, max_output_tokens: 384000, reasoning_efforts: ["high", "xhigh"] },
  },
  {
    name: "glm-5-3-flash",
    model_id: "z-ai/glm-5.3-flash",
    properties: { context_length: 1310720, max_output_tokens: 128000, reasoning_efforts: ["low", "high", "max"] },
  },
];
export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
export const TRIAGE_MCP_URL = "http://127.0.0.1:8803/mcp";
// Atlassian remote MCP; /v1 exposes no Jira tools with API-token auth, /v2 does (verified live).
export const JIRA_MCP_URL = "https://mcp.atlassian.com/v2/mcp";
export const JIRA_AGENT = "ticket-resolver-jira";
const GATES = ["add_issue_comment", "create_pull_request"];
// ticket-resolver-jira: every write is gated by name (addOrEditJiraIssueComment carries no destructive hint).
const JIRA_AGENT_GITHUB_GATES = ["create_pull_request"];
const JIRA_AGENT_JIRA_GATES = ["addOrEditJiraIssueComment"];
const JIRA_AGENT_JIRA_TOOLS = new Set(["getJiraIssue", "addOrEditJiraIssueComment"]);
const JIRA_AGENT_NO_GITHUB_TOOLS = ["issue_read", "list_issues", "add_issue_comment"];
const JIRA_AGENT_TRIAGE_TOOLS = ["triage_jira_ticket"];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

class Api {
  constructor(
    private readonly base: string,
    private readonly fetchFn: FetchLike,
  ) {}

  async call(method: "GET" | "PUT", path: string, body?: unknown): Promise<Json> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/api/v1${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new SetupError(`cannot reach TrueForge at ${this.base} (${(err as Error).message})`);
    }
    const text = await res.text();
    if (!res.ok) throw new SetupError(`${method} ${path}: HTTP ${res.status}`); // never echo the body
    try {
      return text ? (JSON.parse(text) as Json) : {};
    } catch {
      throw new SetupError(`${method} ${path}: reply is not JSON`);
    }
  }

  async list(path: string): Promise<Json[]> {
    const res = await this.call("GET", path);
    return Array.isArray(res.data) ? res.data.filter(isObj) : [];
  }
}

const nameOf = (row: Json): string => {
  const m = isObj(row.manifest) ? row.manifest : {};
  return String(row.name ?? m.name ?? "");
};

export async function registerAll(
  base: string,
  secrets: Secrets,
  opts: SetupOptions,
  fetchFn: FetchLike = fetch,
  log: (s: string) => void = console.log,
  jira: JiraConfig | null = null,
): Promise<Step[]> {
  if (!isLoopback(base) && !opts.allowRemote) {
    throw new SetupError(`refusing to send keys to ${new URL(base).host}: TrueForge is not local (--allow-remote overrides)`);
  }
  const api = new Api(base.replace(/\/+$/, ""), fetchFn);
  const steps: Step[] = [];

  const provider = (await api.list("/settings/model-providers")).find((p) => nameOf(p) === "openrouter");
  if (provider === undefined || opts.rotateKeys) {
    if (!secrets.openrouterKey) throw new SetupError("OPENROUTER_API_KEY is not set in .env");
    const existing = provider && isObj(provider.manifest) ? provider.manifest : undefined;
    const manifest = existing
      ? { ...existing, auth: { api_key: secrets.openrouterKey } }
      : { type: "custom", name: "openrouter", base_url: OPENROUTER_BASE_URL, models: OPENROUTER_MODELS, auth: { api_key: secrets.openrouterKey } };
    await api.call("PUT", "/settings/model-providers", { manifest });
    steps.push({ item: "model provider openrouter", action: provider ? "rotated" : "created" });
  } else {
    steps.push({ item: "model provider openrouter", action: "kept" });
  }

  const servers = await api.list("/settings/mcp-servers");
  const github = servers.find((s) => nameOf(s) === "github");
  if (github === undefined || opts.rotateKeys) {
    if (!secrets.githubPat) throw new SetupError("GITHUB_PAT is not set in .env");
    await api.call("PUT", "/settings/mcp-servers", {
      manifest: {
        type: "remote",
        name: "github",
        url: GITHUB_MCP_URL,
        description: "GitHub remote MCP (issues, branches, pull requests)",
        auth: { type: "header", headers: { Authorization: `Bearer ${secrets.githubPat}` } },
      },
    });
    steps.push({ item: "connector github", action: github ? "rotated" : "created" });
  } else {
    steps.push({ item: "connector github", action: "kept" });
  }
  if (servers.some((s) => nameOf(s) === "triage")) {
    steps.push({ item: "connector triage", action: "kept" });
  } else {
    await api.call("PUT", "/settings/mcp-servers", {
      manifest: { type: "remote", name: "triage", url: TRIAGE_MCP_URL, description: "Jev triage pre-check (triage-v1), read-only" },
    });
    steps.push({ item: "connector triage", action: "created" });
  }
  if (jira !== null) {
    // Written only when missing or on rotateKeys, so a connector someone connected another way is kept.
    const existing = servers.find((s) => nameOf(s) === "jira");
    if (existing === undefined || opts.rotateKeys) {
      if (!secrets.jiraEmail || !secrets.jiraToken) {
        throw new SetupError("JIRA_EMAIL and JIRA_API_KEY must both be set in .env (shipgate.yaml has a jira: section)");
      }
      const basic = Buffer.from(`${secrets.jiraEmail}:${secrets.jiraToken}`, "utf8").toString("base64");
      await api.call("PUT", "/settings/mcp-servers", {
        manifest: {
          type: "remote",
          name: "jira",
          url: JIRA_MCP_URL,
          description: "Atlassian remote MCP (Jira tickets: read, comment)",
          auth: { type: "header", headers: { Authorization: `Basic ${basic}` } },
        },
      });
      steps.push({ item: "connector jira", action: existing ? "rotated" : "created" });
    } else {
      steps.push({ item: "connector jira", action: "kept" });
    }
  }
  for (const s of steps) log(`✓ ${s.item}: ${s.action}`);
  return steps;
}

/** The saved manifest of the agent with exactly this name, or {} when it is not registered. */
async function savedManifest(api: Api, name: string): Promise<Json> {
  const agents = await api.list(`/agents?agent_name=${encodeURIComponent(name)}&limit=100`);
  const id = agents.find((a) => a.name === name)?.id;
  const agent = typeof id === "string" ? (await api.call("GET", `/agents/${encodeURIComponent(id)}`)).data : undefined;
  return isObj(agent) && isObj(agent.manifest) ? agent.manifest : {};
}

/** A tool list from a saved manifest; null when absent (TrueForge then enables every tool of the server). */
const toolList = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String).sort() : null);
const sameSet = (a: string[] | null, want: string[]): boolean =>
  a !== null && JSON.stringify(a) === JSON.stringify([...want].sort());
const show = (a: string[] | null): string => (a === null ? "absent" : `[${a.join(", ")}]`);

export async function doctor(base: string, fetchFn: FetchLike = fetch, jira: JiraConfig | null = null): Promise<Check[]> {
  const api = new Api(base.replace(/\/+$/, ""), fetchFn);
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const providers = await api.list("/settings/model-providers");
  add("provider openrouter", providers.some((p) => nameOf(p) === "openrouter"), "model provider registered");
  const servers = await api.list("/settings/mcp-servers");
  for (const want of jira === null ? ["github", "triage"] : ["github", "triage", "jira"]) {
    const row = servers.find((s) => nameOf(s) === want);
    const status = row && isObj(row.auth_status) ? String(row.auth_status.status) : "missing";
    add(`connector ${want}`, status === "authenticated" || status === "not_required", `auth ${status}`);
  }
  const manifest = await savedManifest(api, "ticket-resolver");
  const mcp = Array.isArray(manifest.mcp_servers) ? manifest.mcp_servers.filter(isObj) : [];
  const gates = mcp.find((s) => s.name === "github")?.require_approval_for_tools;
  const sorted = Array.isArray(gates) ? gates.map(String).sort() : [];
  add("agent gates", JSON.stringify(sorted) === JSON.stringify(GATES), `github gates [${sorted.join(", ")}]`);
  add("agent triage", mcp.some((s) => s.name === "triage"), "triage server enabled");
  const config = isObj(manifest.config) ? manifest.config : {};
  const web = isObj(config.web_search) ? config.web_search.enabled : undefined;
  add("agent web_search", web === false, `web_search.enabled = ${String(web)}`);
  if (jira !== null) checks.push(...(await doctorJiraAgent(api)));
  return checks;
}

/** ticket-resolver-jira: writes gated by name, only the two Jira tools, no GitHub issue tools, Jira triage only. */
async function doctorJiraAgent(api: Api): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const manifest = await savedManifest(api, JIRA_AGENT);
  const mcp = Array.isArray(manifest.mcp_servers) ? manifest.mcp_servers.filter(isObj) : [];
  const server = (name: string) => mcp.find((s) => s.name === name);
  const ghGates = toolList(server("github")?.require_approval_for_tools);
  const jiraGates = toolList(server("jira")?.require_approval_for_tools);
  add(
    "jira agent gates",
    sameSet(ghGates, JIRA_AGENT_GITHUB_GATES) && sameSet(jiraGates, JIRA_AGENT_JIRA_GATES),
    `github gates ${show(ghGates)} · jira gates ${show(jiraGates)}`,
  );
  const jiraTools = toolList(server("jira")?.enable_tools);
  const ghTools = toolList(server("github")?.enable_tools);
  const jiraOk = jiraTools !== null && jiraTools.length > 0 && jiraTools.every((t) => JIRA_AGENT_JIRA_TOOLS.has(t));
  const ghIssueTools = ghTools === null ? null : ghTools.filter((t) => JIRA_AGENT_NO_GITHUB_TOOLS.includes(t));
  const ghOk = ghTools !== null && ghTools.length > 0 && ghIssueTools !== null && ghIssueTools.length === 0;
  add(
    "jira agent tools",
    jiraOk && ghOk,
    `jira tools ${show(jiraTools)} · github issue tools ${ghTools === null ? "all (enable_tools absent)" : show(ghIssueTools)}`,
  );
  const triageTools = toolList(server("triage")?.enable_tools);
  add("jira agent triage", sameSet(triageTools, JIRA_AGENT_TRIAGE_TOOLS), `triage tools ${show(triageTools)}`);
  const config = isObj(manifest.config) ? manifest.config : {};
  const web = isObj(config.web_search) ? config.web_search.enabled : undefined;
  add("jira agent web_search", web === false, `web_search.enabled = ${String(web)}`);
  return checks;
}
