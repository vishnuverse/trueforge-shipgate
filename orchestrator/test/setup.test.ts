import assert from "node:assert/strict";
import { test } from "node:test";
import { OPENAI_MODELS, OPENROUTER_MODELS, SetupError, doctor, isLoopback, registerAll, type FetchLike } from "../src/setup.ts";

const KEY = "sk-or-test-not-real";
const PAT = "github_pat_test_not_real";
type Row = { name: string; manifest: Record<string, unknown>; auth_status?: { status: string } };

function fakeTrueForge(providers: Row[] = [], servers: Row[] = [], agent: Record<string, unknown> | null = null) {
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
    if (u.pathname === "/api/v1/agents") return json(agent ? [{ id: "a1", name: "ticket-resolver" }] : []);
    if (u.pathname === "/api/v1/agents/a1") return json(agent);
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
    [{ name: "openrouter", manifest: { name: "openrouter", models: [] } }],
    [{ name: "github", manifest: {} }, { name: "triage", manifest: {} }],
  );
  const steps = await registerAll("http://localhost:8790", {}, opts, tf.fetchFn, log);
  assert.deepEqual(steps.map((s) => s.action), ["kept", "kept", "kept"]);
  assert.equal(tf.calls.filter((c) => c.method === "PUT").length, 0);
});

test("rotating keys keeps the user's extra models", async () => {
  const extra = { name: "gpt-5-nano", model_id: "openai/gpt-5-nano", properties: { context_length: 400000, max_output_tokens: 128000 } };
  const tf = fakeTrueForge(
    [{ name: "openrouter", manifest: { type: "custom", name: "openrouter", base_url: "https://openrouter.ai/api/v1", models: [extra], auth: { api_key: "***" } } }],
    [{ name: "github", manifest: {} }, { name: "triage", manifest: {} }],
  );
  await registerAll("http://localhost:8790", { openrouterKey: KEY, githubPat: PAT }, { ...opts, rotateKeys: true }, tf.fetchFn, log);
  const provider = tf.state().providers.find((p) => p.name === "openrouter");
  assert.deepEqual(provider?.manifest.models, [extra]);
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
  const ok = await doctor("http://localhost:8790", fakeTrueForge([{ name: "openrouter", manifest: {} }], servers, good).fetchFn);
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
    fakeTrueForge([{ name: "openai", manifest: { type: "openai" } }], servers, agent).fetchFn,
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

