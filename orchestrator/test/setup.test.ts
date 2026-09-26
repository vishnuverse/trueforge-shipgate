import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type JiraConfig, ROOT, loadConfig } from "../src/config.ts";
import { renderDeep, templateValues } from "../src/render.ts";
import { JIRA_MCP_URL, OPENAI_MODELS, OPENROUTER_MODELS, SetupError, doctor, isLoopback, registerAll, type FetchLike } from "../src/setup.ts";

const KEY = "sk-or-test-not-real";
const PAT = "github_pat_test_not_real";
const JIRA_EMAIL = "someone@example.com";
const JIRA_TOKEN = "atlassian-token-test-not-real";
const JIRA: JiraConfig = {
  site: "example.atlassian.net",
  cloudId: "00000000-0000-4000-8000-000000000000",
  project: "KAN",
  statusStart: "In Progress",
  statusReview: "In Review",
  statusOpen: "To Do",
};
type Row = { name: string; manifest: Record<string, unknown>; auth_status?: { status: string } };
const DEEPSEEK = [{ name: "deepseek-v4-flash" }]; // the default model's entry, enough for "the provider serves it"

function fakeTrueForge(
  providers: Row[] = [],
  servers: Row[] = [],
  agent: Record<string, unknown> | null = null,
  jiraAgent: Record<string, unknown> | null = null,
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path: u.pathname + u.search, body });
    const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (u.pathname === "/api/v1/settings/model-providers") {
      if (init.method === "PUT") {
        const m = body.manifest;
        const name = m.name ?? m.type; // well-known provider types (openai) are named by their type
        providers = [...providers.filter((p) => p.name !== name), { name, manifest: m }];
        return json({ name, manifest: m });
      }
      return json(providers);
    }
    if (u.pathname === "/api/v1/settings/mcp-servers") {
      if (init.method === "PUT") {
        const m = body.manifest;
        servers = [...servers.filter((s) => s.name !== m.name), { name: m.name, manifest: m, auth_status: { status: m.auth ? "authenticated" : "not_required" } }];
        return json({ name: m.name, manifest: m });
      }
      return json(servers);
    }
    // Like a prefix filter: both agents come back for agent_name=ticket-resolver; doctor must match names exactly.
    if (u.pathname === "/api/v1/agents") {
      return json([
        ...(agent ? [{ id: "a1", name: "ticket-resolver" }] : []),
        ...(jiraAgent ? [{ id: "a2", name: "ticket-resolver-jira" }] : []),
      ]);
    }
    if (u.pathname === "/api/v1/agents/a1") return json(agent);
    if (u.pathname === "/api/v1/agents/a2") return json(jiraAgent);
    return new Response("{}", { status: 404 });
  };
  return { fetchFn, calls, state: () => ({ providers, servers }) };
}

const logs: string[] = [];
const log = (s: string) => logs.push(s);
const opts = { rotateKeys: false, allowRemote: false };

test("creates the provider and both connectors on an empty TrueForge", async () => {
  const tf = fakeTrueForge();
  const steps = await registerAll("http://localhost:8790", { openrouterKey: KEY, githubPat: PAT }, opts, tf.fetchFn, log);
  assert.deepEqual(steps.map((s) => s.action), ["created", "created", "created"]);
  const [provider] = tf.state().providers;
  assert.equal(provider?.manifest.base_url, "https://openrouter.ai/api/v1");
  assert.deepEqual(provider?.manifest.models, OPENROUTER_MODELS);
  const gh = tf.state().servers.find((s) => s.name === "github");
  assert.deepEqual((gh?.manifest.auth as Record<string, unknown>).headers, { Authorization: `Bearer ${PAT}` });
  const triage = tf.state().servers.find((s) => s.name === "triage");
  assert.equal(triage?.manifest.url, "http://127.0.0.1:8803/mcp");
  assert.equal(triage?.manifest.auth, undefined);
});

test("keeps what exists and sends no secret", async () => {
  const tf = fakeTrueForge(
    [{ name: "openrouter", manifest: { name: "openrouter", models: DEEPSEEK } }],
    [{ name: "github", manifest: {} }, { name: "triage", manifest: {} }],
  );
  const steps = await registerAll("http://localhost:8790", {}, opts, tf.fetchFn, log);
  assert.deepEqual(steps.map((s) => s.action), ["kept", "kept", "kept"]);
  assert.equal(tf.calls.filter((c) => c.method === "PUT").length, 0);
});

test("rotating keys keeps the user's extra models and adds the configured one", async () => {
  const extra = { name: "gpt-5-nano", model_id: "openai/gpt-5-nano", properties: { context_length: 400000, max_output_tokens: 128000 } };
  const tf = fakeTrueForge(
    [{ name: "openrouter", manifest: { type: "custom", name: "openrouter", base_url: "https://openrouter.ai/api/v1", models: [extra], auth: { api_key: "***" } } }],
    [{ name: "github", manifest: {} }, { name: "triage", manifest: {} }],
  );
  await registerAll("http://localhost:8790", { openrouterKey: KEY, githubPat: PAT }, { ...opts, rotateKeys: true }, tf.fetchFn, log);
  const provider = tf.state().providers.find((p) => p.name === "openrouter");
  assert.deepEqual(provider?.manifest.models, [extra, OPENROUTER_MODELS[0]]);
  assert.deepEqual(provider?.manifest.auth, { api_key: KEY });
  assert.equal(tf.calls.filter((c) => c.method === "PUT" && c.path.includes("mcp-servers")).length, 1); // github only
});

test("refuses to send keys to a non-local TrueForge unless allowed", async () => {
  const tf = fakeTrueForge();
  await assert.rejects(
    registerAll("https://tf.example.com", { openrouterKey: KEY, githubPat: PAT }, opts, tf.fetchFn, log),
    (e: unknown) => e instanceof SetupError && /not local/.test(e.message),
  );
  assert.equal(tf.calls.length, 0);
  await registerAll("https://tf.example.com", { openrouterKey: KEY, githubPat: PAT }, { ...opts, allowRemote: true }, tf.fetchFn, log);
  assert.ok(tf.calls.length > 0);
  assert.ok(isLoopback("http://127.0.0.1:8790") && isLoopback("http://[::1]:8790") && !isLoopback("http://10.0.0.2"));
});

test("a missing key is named, never shown", async () => {
  const tf = fakeTrueForge();
  await assert.rejects(registerAll("http://localhost:8790", { githubPat: PAT }, opts, tf.fetchFn, log), /OPENROUTER_API_KEY/);
});

test("HTTP errors never echo the response body, and logs never hold a key", async () => {
  const leaky: FetchLike = async () => new Response(`{"echo":"${KEY}"}`, { status: 500 });
  await assert.rejects(
    registerAll("http://localhost:8790", { openrouterKey: KEY, githubPat: PAT }, opts, leaky, log),
    (e: unknown) => e instanceof SetupError && !e.message.includes(KEY),
  );
  assert.ok(logs.every((l) => !l.includes(KEY) && !l.includes(PAT)));
});

test("doctor passes a good install and names each problem", async () => {
  const good = {
    name: "ticket-resolver",
    manifest: {
      mcp_servers: [
        { name: "github", require_approval_for_tools: ["create_pull_request", "add_issue_comment"] },
        { name: "triage", enable_tools: ["triage_ticket"], require_approval_for_tools: [] },
      ],
      config: { web_search: { enabled: false } },
    },
  };
  const servers: Row[] = [
    { name: "github", manifest: {}, auth_status: { status: "authenticated" } },
    { name: "triage", manifest: {}, auth_status: { status: "not_required" } },
  ];
  const ok = await doctor("http://localhost:8790", fakeTrueForge([{ name: "openrouter", manifest: { models: DEEPSEEK } }], servers, good).fetchFn);
  assert.ok(ok.every((c) => c.ok), JSON.stringify(ok));
  const bad = structuredClone(good);
  (bad.manifest.config.web_search as { enabled: boolean }).enabled = true;
  bad.manifest.mcp_servers[0]!.require_approval_for_tools = ["create_pull_request"];
  const res = await doctor("http://localhost:8790", fakeTrueForge([], servers.slice(0, 1), bad).fetchFn);
  const failed = res.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed.sort(), ["agent gates", "agent web_search", "connector triage", "provider openrouter"].sort());
});

const OKEY = "sk-openai-test-not-real";
const connectors: Row[] = [{ name: "github", manifest: {} }, { name: "triage", manifest: {} }];

test("an openai/ model registers the openai provider with that model and OPENAI_API_KEY", async () => {
  const tf = fakeTrueForge([], structuredClone(connectors));
  const steps = await registerAll("http://localhost:8790", { openaiKey: OKEY }, opts, tf.fetchFn, log, "openai/gpt-6-luna");
  assert.deepEqual(
    steps.map((s) => [s.item, s.action]),
    [["model provider openai", "created"], ["connector github", "kept"], ["connector triage", "kept"]],
  );
  const p = tf.state().providers.find((x) => x.name === "openai");
  assert.equal(p?.manifest.type, "openai");
  assert.deepEqual(p?.manifest.models, OPENAI_MODELS);
  assert.ok(OPENAI_MODELS.some((m) => m.name === "gpt-6-luna"));
  assert.deepEqual(p?.manifest.auth, { api_key: OKEY });
  assert.ok(!tf.state().providers.some((x) => x.name === "openrouter"), "no OpenRouter provider or key needed");
  assert.ok(logs.every((l) => !l.includes(OKEY)));
});

test("an openai/ model without OPENAI_API_KEY names the key and sends nothing", async () => {
  const tf = fakeTrueForge([], structuredClone(connectors));
  await assert.rejects(
    registerAll("http://localhost:8790", { openrouterKey: KEY }, opts, tf.fetchFn, log, "openai/gpt-6-luna"),
    (e: unknown) => e instanceof SetupError && /OPENAI_API_KEY/.test(e.message),
  );
  assert.equal(tf.calls.filter((c) => c.method === "PUT").length, 0);
});

test("an unsupported provider prefix is refused before any request", async () => {
  const tf = fakeTrueForge();
  await assert.rejects(
    registerAll("http://localhost:8790", { openaiKey: OKEY }, opts, tf.fetchFn, log, "mistral/large"),
    (e: unknown) => e instanceof SetupError && /unsupported/.test(e.message),
  );
  assert.equal(tf.calls.length, 0);
});

test("doctor checks the provider of the configured model", async () => {
  const agent = {
    name: "ticket-resolver",
    manifest: {
      mcp_servers: [
        { name: "github", require_approval_for_tools: ["create_pull_request", "add_issue_comment"] },
        { name: "triage", enable_tools: ["triage_ticket"], require_approval_for_tools: [] },
      ],
      config: { web_search: { enabled: false } },
    },
  };
  const servers: Row[] = [
    { name: "github", manifest: {}, auth_status: { status: "authenticated" } },
    { name: "triage", manifest: {}, auth_status: { status: "not_required" } },
  ];
  const withOpenai = await doctor(
    "http://localhost:8790",
    fakeTrueForge([{ name: "openai", manifest: { type: "openai", models: [{ name: "gpt-6-luna" }] } }], servers, agent).fetchFn,
    "openai/gpt-6-luna",
  );
  assert.ok(withOpenai.every((c) => c.ok), JSON.stringify(withOpenai));
  const onlyOpenrouter = await doctor(
    "http://localhost:8790",
    fakeTrueForge([{ name: "openrouter", manifest: {} }], servers, agent).fetchFn,
    "openai/gpt-6-luna",
  );
  assert.deepEqual(onlyOpenrouter.filter((c) => !c.ok).map((c) => c.name), ["provider openai"]);
});

test("an existing provider without the configured model gets it added, keeping its models and stored key", async () => {
  const other = { name: "gpt-5-5", model_id: "gpt-5.5", properties: {} };
  const masked = { api_key: "sk--***REDACTED" }; // GET masks the key; PUT with the mask keeps the stored one
  const tf = fakeTrueForge(
    [{ name: "openai", manifest: { type: "openai", base_url: "https://api.openai.com/v1", models: [other], auth: masked } }],
    structuredClone(connectors),
  );
  const steps = await registerAll("http://localhost:8790", {}, opts, tf.fetchFn, log, "openai/gpt-6-luna");
  assert.deepEqual(steps[0], { item: "model provider openai", action: "updated" });
  const p = tf.state().providers.find((x) => x.name === "openai");
  assert.deepEqual(p?.manifest.models, [other, OPENAI_MODELS[0]]);
  assert.deepEqual(p?.manifest.auth, masked);
});

test("a model setup does not know and the provider lacks is named before anything is written", async () => {
  const tf = fakeTrueForge([{ name: "openai", manifest: { type: "openai", models: [] } }], structuredClone(connectors));
  await assert.rejects(
    registerAll("http://localhost:8790", { openaiKey: OKEY }, opts, tf.fetchFn, log, "openai/gpt-9"),
    (e: unknown) => e instanceof SetupError && e.message.includes("openai/gpt-9") && e.message.includes("Settings"),
  );
  assert.equal(tf.calls.filter((c) => c.method === "PUT").length, 0);
});

test("doctor fails the provider check when the provider lacks the configured model", async () => {
  const checks = await doctor(
    "http://localhost:8790",
    fakeTrueForge([{ name: "openai", manifest: { type: "openai", models: [{ name: "gpt-5-5" }] } }]).fetchFn,
    "openai/gpt-6-luna",
  );
  const provider = checks.find((c) => c.name === "provider openai");
  assert.equal(provider?.ok, false);
  assert.match(provider?.detail ?? "", /gpt-6-luna/);
});

// ---------- Jira (shipgate.yaml jira: section) ----------

const both = { openrouterKey: KEY, githubPat: PAT, jiraEmail: JIRA_EMAIL, jiraToken: JIRA_TOKEN };
const basic = (email: string, token: string) => `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

test("with jira configured, registers the jira connector (Atlassian /v2 MCP, Basic auth header)", async () => {
  const tf = fakeTrueForge();
  const steps = await registerAll("http://localhost:8790", both, opts, tf.fetchFn, log, undefined, JIRA);
  assert.deepEqual(steps.map((s) => `${s.item}: ${s.action}`).at(-1), "connector jira: created");
  const jira = tf.state().servers.find((s) => s.name === "jira");
  assert.deepEqual(jira?.manifest, {
    type: "remote",
    name: "jira",
    url: JIRA_MCP_URL,
    description: "Atlassian remote MCP (Jira tickets: read, comment)",
    auth: { type: "header", headers: { Authorization: basic(JIRA_EMAIL, JIRA_TOKEN) } },
  });
  assert.equal(JIRA_MCP_URL, "https://mcp.atlassian.com/v2/mcp");
});

test("without jira configured, no jira connector and no Jira key needed", async () => {
  const tf = fakeTrueForge();
  const steps = await registerAll("http://localhost:8790", { openrouterKey: KEY, githubPat: PAT }, opts, tf.fetchFn, log);
  assert.ok(steps.every((s) => s.item !== "connector jira"));
  assert.ok(tf.state().servers.every((s) => s.name !== "jira"));
});

test("an existing jira connector (e.g. connected by OAuth) is kept and needs no Jira key", async () => {
  const oauth: Row = { name: "jira", manifest: { name: "jira", url: JIRA_MCP_URL, auth: { type: "oauth" } } };
  const tf = fakeTrueForge(
    [{ name: "openrouter", manifest: { name: "openrouter", models: DEEPSEEK } }],
    [{ name: "github", manifest: {} }, { name: "triage", manifest: {} }, oauth],
  );
  const steps = await registerAll("http://localhost:8790", {}, opts, tf.fetchFn, log, undefined, JIRA);
  assert.deepEqual(steps.map((s) => s.action), ["kept", "kept", "kept", "kept"]);
  assert.equal(tf.calls.filter((c) => c.method === "PUT").length, 0);
});

test("rotating keys rewrites the jira connector with the new token", async () => {
  const old: Row = { name: "jira", manifest: { name: "jira", auth: { type: "header", headers: { Authorization: "Basic old" } } } };
  const tf = fakeTrueForge(
    [{ name: "openrouter", manifest: { name: "openrouter", models: DEEPSEEK } }],
    [{ name: "github", manifest: {} }, { name: "triage", manifest: {} }, old],
  );
  const steps = await registerAll("http://localhost:8790", both, { ...opts, rotateKeys: true }, tf.fetchFn, log, undefined, JIRA);
  assert.equal(steps.find((s) => s.item === "connector jira")?.action, "rotated");
  const jira = tf.state().servers.find((s) => s.name === "jira");
  assert.deepEqual((jira?.manifest.auth as Record<string, unknown>).headers, { Authorization: basic(JIRA_EMAIL, JIRA_TOKEN) });
});

test("missing Jira keys are named (both), never shown, and no jira connector is written", async () => {
  for (const partial of [{ jiraEmail: JIRA_EMAIL }, { jiraToken: JIRA_TOKEN }, {}]) {
    const tf = fakeTrueForge();
    await assert.rejects(
      registerAll("http://localhost:8790", { openrouterKey: KEY, githubPat: PAT, ...partial }, opts, tf.fetchFn, log, undefined, JIRA),
      (e: unknown) =>
        e instanceof SetupError &&
        /JIRA_EMAIL/.test(e.message) &&
        /JIRA_API_KEY/.test(e.message) &&
        !e.message.includes(JIRA_EMAIL) &&
        !e.message.includes(JIRA_TOKEN),
    );
    assert.ok(tf.state().servers.every((s) => s.name !== "jira"));
  }
  assert.ok(logs.every((l) => !l.includes(JIRA_TOKEN) && !l.includes(basic(JIRA_EMAIL, JIRA_TOKEN))));
});

function committedAgent(file: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(ROOT, "agents", file), "utf8")) as { name: string; manifest: unknown };
  return { name: raw.name, manifest: renderDeep(raw.manifest, templateValues(loadConfig(join(ROOT, "shipgate.yaml")))) };
}

const jiraServers: Row[] = [
  { name: "github", manifest: {}, auth_status: { status: "authenticated" } },
  { name: "triage", manifest: {}, auth_status: { status: "not_required" } },
  { name: "jira", manifest: {}, auth_status: { status: "authenticated" } },
];
const providers: Row[] = [{ name: "openrouter", manifest: { models: DEEPSEEK } }];
const JIRA_CHECKS = ["connector jira", "jira agent gates", "jira agent tools", "jira agent triage", "jira agent web_search"];

test("doctor with jira passes the committed agent files", async () => {
  const tf = fakeTrueForge(providers, jiraServers, committedAgent("ticket-resolver.json"), committedAgent("ticket-resolver-jira.json"));
  const res = await doctor("http://localhost:8790", tf.fetchFn, undefined, JIRA);
  assert.ok(res.every((c) => c.ok), JSON.stringify(res));
  for (const name of JIRA_CHECKS) assert.ok(res.some((c) => c.name === name), name);
});

test("doctor without jira does not look at the Jira connector or agent", async () => {
  const tf = fakeTrueForge(providers, jiraServers.slice(0, 2), committedAgent("ticket-resolver.json"));
  const res = await doctor("http://localhost:8790", tf.fetchFn);
  assert.ok(res.every((c) => c.ok && !c.name.includes("jira")), JSON.stringify(res));
  assert.ok(tf.calls.every((c) => !c.path.includes("jira")));
});

test("doctor with jira names each Jira problem", async () => {
  const gh = committedAgent("ticket-resolver.json");
  const bad = committedAgent("ticket-resolver-jira.json") as { manifest: { mcp_servers: Record<string, unknown>[]; config: Record<string, unknown> } };
  const [github, jira, triage] = bad.manifest.mcp_servers;
  (github!.enable_tools as string[]).push("add_issue_comment");
  jira!.enable_tools = ["getJiraIssue", "addOrEditJiraIssueComment", "executeWrite"];
  jira!.require_approval_for_tools = [];
  triage!.enable_tools = ["triage_ticket"];
  bad.manifest.config.web_search = { enabled: true };
  const res = await doctor("http://localhost:8790", fakeTrueForge(providers, jiraServers.slice(0, 2), gh, bad).fetchFn, undefined, JIRA);
  assert.deepEqual(res.filter((c) => !c.ok).map((c) => c.name).sort(), [...JIRA_CHECKS].sort());
  assert.match(res.find((c) => c.name === "jira agent gates")?.detail ?? "", /jira gates \[\]/);

  // enable_tools absent means every tool of that server: a failure, and the missing agent fails every agent check.
  const open = committedAgent("ticket-resolver-jira.json") as { manifest: { mcp_servers: Record<string, unknown>[] } };
  delete open.manifest.mcp_servers[1]!.enable_tools;
  const res2 = await doctor("http://localhost:8790", fakeTrueForge(providers, jiraServers, gh, open).fetchFn, undefined, JIRA);
  assert.deepEqual(res2.filter((c) => !c.ok).map((c) => c.name), ["jira agent tools"]);
  const res3 = await doctor("http://localhost:8790", fakeTrueForge(providers, jiraServers, gh, null).fetchFn, undefined, JIRA);
  assert.deepEqual(res3.filter((c) => !c.ok).map((c) => c.name).sort(), JIRA_CHECKS.slice(1).sort());
});
