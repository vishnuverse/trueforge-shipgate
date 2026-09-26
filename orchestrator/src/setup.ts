// Register what Ticket Resolver needs in TrueForge 0.2.1, and check it (spec any-repo §4 steps 4 and 6).
// REST bodies are snake_case; PUT on settings/* creates or replaces one entry by name. Keys are sent only to a
// loopback TrueForge (unless allowRemote), only when an entry is missing or rotateKeys is set, and never logged.
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export class SetupError extends Error {}
export interface Secrets {
  openrouterKey?: string;
  openaiKey?: string;
  githubPat?: string;
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
// OpenAI is a well-known TrueForge provider type: its manifest has no name (the provider is named "openai") and
// base_url defaults to api.openai.com. Facts: docs/reference/gpt-6-luna-prompting-and-caching.md §1.
export const OPENAI_MODELS = [
  {
    name: "gpt-6-luna",
    model_id: "gpt-6-luna",
    properties: { context_length: 1050000, max_output_tokens: 128000, reasoning_efforts: ["none", "low", "medium", "high", "xhigh"] },
  },
];
export const DEFAULT_MODEL = "openrouter/deepseek-v4-flash";
export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";
export const TRIAGE_MCP_URL = "http://127.0.0.1:8803/mcp";
const GATES = ["add_issue_comment", "create_pull_request"];

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
  return String(row.name ?? m.name ?? m.type ?? "");
};

interface ProviderPlan {
  name: string;
  keyName: string;
  key: string | undefined;
  manifest: (key: string) => Json;
}

/** The TrueForge model provider behind shipgate.yaml's trueforge.model ("<provider>/<model>"). */
function providerFor(model: string, secrets: Secrets): ProviderPlan {
  const prefix = model.split("/")[0];
  if (prefix === "openrouter") {
    return {
      name: "openrouter",
      keyName: "OPENROUTER_API_KEY",
      key: secrets.openrouterKey,
      manifest: (key) => ({ type: "custom", name: "openrouter", base_url: OPENROUTER_BASE_URL, models: OPENROUTER_MODELS, auth: { api_key: key } }),
    };
  }
  if (prefix === "openai") {
    return {
      name: "openai",
      keyName: "OPENAI_API_KEY",
      key: secrets.openaiKey,
      manifest: (key) => ({ type: "openai", models: OPENAI_MODELS, auth: { api_key: key } }),
    };
  }
  throw new SetupError(`unsupported model provider "${prefix}" in trueforge.model (use openrouter/... or openai/...)`);
}

export async function registerAll(
  base: string,
  secrets: Secrets,
  opts: SetupOptions,
  fetchFn: FetchLike = fetch,
  log: (s: string) => void = console.log,
  model: string = DEFAULT_MODEL,
): Promise<Step[]> {
  const plan = providerFor(model, secrets);
  if (!isLoopback(base) && !opts.allowRemote) {
    throw new SetupError(`refusing to send keys to ${new URL(base).host}: TrueForge is not local (--allow-remote overrides)`);
  }
  const api = new Api(base.replace(/\/+$/, ""), fetchFn);
  const steps: Step[] = [];

  const provider = (await api.list("/settings/model-providers")).find((p) => nameOf(p) === plan.name);
  if (provider === undefined || opts.rotateKeys) {
    if (!plan.key) throw new SetupError(`${plan.keyName} is not set in .env`);
    const existing = provider && isObj(provider.manifest) ? provider.manifest : undefined;
    const manifest = existing ? { ...existing, auth: { api_key: plan.key } } : plan.manifest(plan.key);
    await api.call("PUT", "/settings/model-providers", { manifest });
    steps.push({ item: `model provider ${plan.name}`, action: provider ? "rotated" : "created" });
  } else {
    steps.push({ item: `model provider ${plan.name}`, action: "kept" });
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
  for (const s of steps) log(`✓ ${s.item}: ${s.action}`);
  return steps;
}

export async function doctor(base: string, fetchFn: FetchLike = fetch, model: string = DEFAULT_MODEL): Promise<Check[]> {
  const providerName = providerFor(model, {}).name;
  const api = new Api(base.replace(/\/+$/, ""), fetchFn);
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const providers = await api.list("/settings/model-providers");
  add(`provider ${providerName}`, providers.some((p) => nameOf(p) === providerName), `model provider for ${model} registered`);
  const servers = await api.list("/settings/mcp-servers");
  for (const want of ["github", "triage"]) {
    const row = servers.find((s) => nameOf(s) === want);
    const status = row && isObj(row.auth_status) ? String(row.auth_status.status) : "missing";
    add(`connector ${want}`, status === "authenticated" || status === "not_required", `auth ${status}`);
  }
  const agents = await api.list("/agents?agent_name=ticket-resolver&limit=100");
  const id = agents.find((a) => a.name === "ticket-resolver")?.id;
  const agent = typeof id === "string" ? (await api.call("GET", `/agents/${encodeURIComponent(id)}`)).data : undefined;
  const manifest = isObj(agent) && isObj(agent.manifest) ? agent.manifest : {};
  const mcp = Array.isArray(manifest.mcp_servers) ? manifest.mcp_servers.filter(isObj) : [];
  const gates = mcp.find((s) => s.name === "github")?.require_approval_for_tools;
  const sorted = Array.isArray(gates) ? gates.map(String).sort() : [];
  add("agent gates", JSON.stringify(sorted) === JSON.stringify(GATES), `github gates [${sorted.join(", ")}]`);
  add("agent triage", mcp.some((s) => s.name === "triage"), "triage server enabled");
  const config = isObj(manifest.config) ? manifest.config : {};
  const web = isObj(config.web_search) ? config.web_search.enabled : undefined;
  add("agent web_search", web === false, `web_search.enabled = ${String(web)}`);
  return checks;
}
