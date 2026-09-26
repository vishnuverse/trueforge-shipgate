import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { loadConfig, type JiraConfig } from "../src/config.ts";
import { GitHubLabels, JiraStatus, labelForOutcome, targetRepo, type FetchLike } from "../src/labels.ts";

test("outcome -> label mapping (SPEC T15)", () => {
  assert.equal(labelForOutcome("fixed"), "fix-proposed");
  assert.equal(labelForOutcome("duplicate"), "fix-proposed");
  assert.equal(labelForOutcome("cannot_reproduce"), "cannot-reproduce");
  assert.equal(labelForOutcome("stopped"), "triaged");
  for (const o of ["intermittent", "out_of_scope", "needs_info", "security_redirect", "could_not_fix", "policy_blocked", "weird"]) {
    assert.equal(labelForOutcome(o), "needs-human", o);
  }
  assert.equal(labelForOutcome(null), "needs-human");
  assert.equal(labelForOutcome(undefined), "needs-human");
});

interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | undefined;
}

/** In-memory GitHub issue labels. */
function fakeGitHub(initial: string[]) {
  const labels = new Set(initial);
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const u = new URL(url);
    const headers = init.headers as Record<string, string>;
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method: init.method ?? "GET", path: u.pathname, body, auth: headers.Authorization });
    const m = /^\/repos\/vishnuverse\/humanize\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(u.pathname);
    if (!m) return new Response("not found", { status: 404 });
    const json = () => new Response(JSON.stringify([...labels].map((name) => ({ name }))), { status: 200 });
    if (init.method === "GET") return json();
    if (init.method === "POST") {
      for (const l of (body as { labels: string[] }).labels) labels.add(l);
      return json();
    }
    if (init.method === "DELETE") {
      const name = decodeURIComponent(m[2] ?? "");
      if (!labels.has(name)) return new Response('{"message":"Label does not exist"}', { status: 404 });
      labels.delete(name);
      return json();
    }
    return new Response("bad", { status: 400 });
  };
  return { labels, calls, fetchFn };
}

test("start: add triaged, remove bug", async () => {
  const gh = fakeGitHub(["bug", "good first issue"]);
  const l = new GitHubLabels("vishnuverse/humanize", "tkn", gh.fetchFn);
  assert.deepEqual(await l.onStart(1), ["+triaged", "-bug"]);
  assert.deepEqual([...gh.labels].sort(), ["good first issue", "triaged"]);
  assert.ok(gh.calls.every((c) => c.auth === "Bearer tkn"));
  assert.ok(gh.calls.every((c) => c.path.startsWith("/repos/vishnuverse/humanize/issues/1/labels")));
});

test("start is idempotent (no bug, already triaged)", async () => {
  const gh = fakeGitHub(["triaged"]);
  const l = new GitHubLabels("vishnuverse/humanize", "tkn", gh.fetchFn);
  assert.deepEqual(await l.onStart(3), []);
  assert.deepEqual(
    gh.calls.map((c) => c.method),
    ["GET"],
  );
});

test("end: fixed -> fix-proposed replaces triaged; other labels untouched", async () => {
  const gh = fakeGitHub(["triaged", "good first issue"]);
  const l = new GitHubLabels("vishnuverse/humanize", "tkn", gh.fetchFn);
  assert.deepEqual(await l.onEnd(1, "fixed"), ["+fix-proposed", "-triaged"]);
  assert.deepEqual([...gh.labels].sort(), ["fix-proposed", "good first issue"]);
});

test("end: stopped keeps triaged; missing handoff -> needs-human", async () => {
  const gh = fakeGitHub(["triaged"]);
  const l = new GitHubLabels("vishnuverse/humanize", "tkn", gh.fetchFn);
  assert.deepEqual(await l.onEnd(1, "stopped"), []);
  assert.deepEqual([...gh.labels], ["triaged"]);
  assert.deepEqual(await l.onEnd(1, null), ["+needs-human", "-triaged"]);
  assert.deepEqual([...gh.labels], ["needs-human"]);
  assert.deepEqual(await l.onEnd(1, "cannot_reproduce"), ["+cannot-reproduce", "-needs-human"]);
});

test("remove tolerates a 404 (label already gone)", async () => {
  const gh = fakeGitHub([]);
  const l = new GitHubLabels("vishnuverse/humanize", "tkn", gh.fetchFn);
  await l.remove(1, "bug");
  assert.equal(gh.calls[0]?.method, "DELETE");
});

test("refuses other repos, unmanaged labels, a missing token and bad issue numbers", async () => {
  const gh = fakeGitHub([]);
  assert.throws(() => new GitHubLabels("python-humanize/humanize", "tkn", gh.fetchFn), /refusing/);
  assert.throws(() => new GitHubLabels("vishnuverse/humanize", "", gh.fetchFn), /GITHUB_PAT/);
  const l = new GitHubLabels("vishnuverse/humanize", "tkn", gh.fetchFn);
  await assert.rejects(l.add(1, "wontfix"), /refusing to touch label/);
  await assert.rejects(l.remove(1, "enhancement"), /refusing to touch label/);
  await assert.rejects(l.add(0, "triaged"), /bad issue number/);
  assert.equal(gh.calls.length, 0);
});

test("API errors surface with status", async () => {
  const l = new GitHubLabels("vishnuverse/humanize", "tkn", async () => new Response("nope", { status: 403 }));
  await assert.rejects(l.onStart(1), /403/);
});

test("labels are pinned to the configured repo", () => {
  assert.equal(targetRepo(), "vishnuverse/humanize");
  const before = process.env.SHIPGATE_CONFIG;
  process.env.SHIPGATE_CONFIG = fileURLToPath(new URL("../../tests/fixtures/config/valid-dotted-repo.yaml", import.meta.url));
  try {
    assert.equal(targetRepo(), "acme/my.pkg_x");
    assert.throws(() => new GitHubLabels("vishnuverse/humanize", "tkn"), /refusing/);
    assert.doesNotThrow(() => new GitHubLabels("acme/my.pkg_x", "tkn"));
  } finally {
    if (before === undefined) delete process.env.SHIPGATE_CONFIG;
    else process.env.SHIPGATE_CONFIG = before;
  }
});

test("GitHub labels refuse a Jira key", async () => {
  const gh = fakeGitHub([]);
  const l = new GitHubLabels("vishnuverse/humanize", "tkn", gh.fetchFn);
  await assert.rejects(l.onStart("KAN-4"), /bad issue number/);
  await assert.rejects(l.onEnd("1", "fixed"), /bad issue number/);
  assert.equal(gh.calls.length, 0);
});

// ---------- Jira ----------

const JIRA = loadConfig().jira as JiraConfig; // committed shipgate.yaml: KAN on developertunnel.atlassian.net
const EMAIL = "me@example.com";
const TOKEN = "tkn-SECRET-123";
const BASIC = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;
/** The KAN workflow's transitions (verified live): target status -> transition id. */
const KAN_TRANSITIONS: Record<string, string> = { "To Do": "11", "In Progress": "21", "In Review": "31", Done: "41" };

interface JiraCall {
  method: string;
  url: string;
  body: unknown;
  auth: string | undefined;
}

/** In-memory Jira ticket KAN-4 (labels + status) behind the four REST calls JiraStatus makes. */
function fakeJira(labels: string[], status: string, transitions: Record<string, string> = KAN_TRANSITIONS) {
  const state = { labels: [...labels], status };
  const calls: JiraCall[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const u = new URL(url);
    const headers = init.headers as Record<string, string>;
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    const method = init.method ?? "GET";
    calls.push({ method, url, body, auth: headers.Authorization });
    if (u.host !== "developertunnel.atlassian.net") return new Response("wrong host", { status: 404 });
    if (method === "GET" && u.pathname === "/rest/api/2/issue/KAN-4" && u.search === "?fields=labels,status") {
      return Response.json({ key: "KAN-4", fields: { labels: state.labels, status: { name: state.status } } });
    }
    if (method === "PUT" && u.pathname === "/rest/api/3/issue/KAN-4") {
      for (const op of (body as { update: { labels: Record<string, string>[] } }).update.labels) {
        if (op.add !== undefined && !state.labels.includes(op.add)) state.labels.push(op.add);
        if (op.remove !== undefined) state.labels = state.labels.filter((l) => l !== op.remove);
      }
      return new Response(null, { status: 204 });
    }
    if (u.pathname === "/rest/api/3/issue/KAN-4/transitions") {
      if (method === "GET") {
        const list = Object.entries(transitions)
          .filter(([to]) => to !== state.status)
          .map(([to, id]) => ({ id, name: to, to: { name: to } }));
        return Response.json({ transitions: list });
      }
      const id = (body as { transition: { id: string } }).transition.id;
      const to = Object.entries(transitions).find(([, tid]) => tid === id)?.[0];
      if (!to) return new Response('{"errorMessages":["bad transition"]}', { status: 400 });
      state.status = to;
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  };
  return { state, calls, fetchFn };
}

const pathsOf = (calls: JiraCall[]) => calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`);

test("jira start: triaged in, bug out, To Do -> In Progress (Basic auth, the configured site only)", async () => {
  const jira = fakeJira(["bug", "customer"], "To Do");
  const s = new JiraStatus(JIRA, EMAIL, TOKEN, jira.fetchFn);
  assert.deepEqual(await s.onStart("KAN-4"), ["+triaged", "-bug", "status:To Do->In Progress"]);
  assert.deepEqual(jira.state, { labels: ["customer", "triaged"], status: "In Progress" });
  assert.deepEqual(pathsOf(jira.calls), [
    "GET /rest/api/2/issue/KAN-4?fields=labels,status",
    "PUT /rest/api/3/issue/KAN-4",
    "GET /rest/api/3/issue/KAN-4/transitions",
    "POST /rest/api/3/issue/KAN-4/transitions",
  ]);
  assert.deepEqual(jira.calls[1]?.body, { update: { labels: [{ add: "triaged" }, { remove: "bug" }] } });
  assert.deepEqual(jira.calls[3]?.body, { transition: { id: "21" } });
  assert.ok(jira.calls.every((c) => c.auth === BASIC));
});

test("jira start is idempotent: already triaged and In Progress -> one read, no writes", async () => {
  const jira = fakeJira(["triaged"], "In Progress");
  const s = new JiraStatus(JIRA, EMAIL, TOKEN, jira.fetchFn);
  assert.deepEqual(await s.onStart("KAN-4"), []);
  assert.deepEqual(pathsOf(jira.calls), ["GET /rest/api/2/issue/KAN-4?fields=labels,status"]);
});

test("jira end: fixed -> fix-proposed + In Review", async () => {
  const jira = fakeJira(["triaged", "customer"], "In Progress");
  const s = new JiraStatus(JIRA, EMAIL, TOKEN, jira.fetchFn);
  assert.deepEqual(await s.onEnd("KAN-4", "fixed"), ["+fix-proposed", "-triaged", "status:In Progress->In Review"]);
  assert.deepEqual(jira.state, { labels: ["customer", "fix-proposed"], status: "In Review" });
  assert.deepEqual(jira.calls.at(-1)?.body, { transition: { id: "31" } });
});

test("jira end: cannot_reproduce -> cannot-reproduce + To Do; other outcomes -> To Do", async () => {
  const jira = fakeJira(["triaged"], "In Progress");
  const s = new JiraStatus(JIRA, EMAIL, TOKEN, jira.fetchFn);
  assert.deepEqual(await s.onEnd("KAN-4", "cannot_reproduce"), ["+cannot-reproduce", "-triaged", "status:In Progress->To Do"]);
  assert.deepEqual(jira.state, { labels: ["cannot-reproduce"], status: "To Do" });
  assert.deepEqual(jira.calls.at(-1)?.body, { transition: { id: "11" } });

  // exactly one managed label stays (bug included); already in To Do -> no transition
  const again = fakeJira(["bug", "triaged", "needs-human", "customer"], "To Do");
  const s2 = new JiraStatus(JIRA, EMAIL, TOKEN, again.fetchFn);
  assert.deepEqual(await s2.onEnd("KAN-4", "stopped"), ["-bug", "-needs-human"]);
  assert.deepEqual(again.state, { labels: ["triaged", "customer"], status: "To Do" });
  assert.ok(!pathsOf(again.calls).some((p) => p.includes("/transitions")));
  assert.deepEqual(await s2.onEnd("KAN-4", null), ["+needs-human", "-triaged"]);
});

test("jira end: a missing transition is an error, but the labels are still set", async () => {
  const jira = fakeJira(["triaged"], "In Progress", { "To Do": "11", "In Progress": "21" });
  const s = new JiraStatus(JIRA, EMAIL, TOKEN, jira.fetchFn);
  await assert.rejects(
    s.onEnd("KAN-4", "fixed"),
    /no transition from 'In Progress' to 'In Review' \(done: \+fix-proposed -triaged\)/,
  );
  assert.deepEqual(jira.state, { labels: ["fix-proposed"], status: "In Progress" });
  assert.ok(!jira.calls.some((c) => c.method === "POST"));
});

test("jira: other projects, lower-case keys and issue numbers are refused before any call", async () => {
  const jira = fakeJira([], "To Do");
  const s = new JiraStatus(JIRA, EMAIL, TOKEN, jira.fetchFn);
  for (const bad of ["SAM-4", "kan-4", "KAN-0", 4]) {
    await assert.rejects(s.onStart(bad), /refusing to change Jira ticket/, String(bad));
    await assert.rejects(s.onEnd(bad, "fixed"), /refusing to change Jira ticket/, String(bad));
  }
  assert.equal(jira.calls.length, 0);
});

test("jira: only the shipgate.yaml jira project and site; credentials required", () => {
  const f = fakeJira([], "To Do").fetchFn;
  assert.throws(() => new JiraStatus({ ...JIRA, project: "SAM" }, EMAIL, TOKEN, f), /refusing to change tickets of SAM/);
  assert.throws(() => new JiraStatus({ ...JIRA, site: "evil.atlassian.net" }, EMAIL, TOKEN, f), /refusing/);
  assert.throws(() => new JiraStatus(JIRA, "", TOKEN, f), /JIRA_EMAIL and JIRA_API_KEY/);
  assert.throws(() => new JiraStatus(JIRA, EMAIL, "", f), /JIRA_EMAIL and JIRA_API_KEY/);
});

test("jira: errors carry the status code only (no token, no response body)", async () => {
  const echo: FetchLike = async (_url, init) =>
    new Response(`{"errorMessages":["bad auth ${String((init.headers as Record<string, string>).Authorization)}"]}`, {
      status: 401,
    });
  const s = new JiraStatus(JIRA, EMAIL, TOKEN, echo);
  const err = await s.onStart("KAN-4").then(
    () => assert.fail("expected an error"),
    (e: unknown) => e as Error,
  );
  assert.equal(err.message, "Jira GET /rest/api/2/issue/KAN-4 -> 401");
  // nothing secret reachable from the object either (the auth header lives in a private field)
  for (const text of [err.message, String(err.stack), inspect(s, { depth: 5, showHidden: true }), JSON.stringify(s)]) {
    assert.ok(!text.includes(TOKEN) && !text.includes(BASIC.slice(6)) && !text.includes("errorMessages"), text);
  }
});
