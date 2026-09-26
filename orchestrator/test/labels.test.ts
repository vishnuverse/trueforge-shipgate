import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubLabels, labelForOutcome, type FetchLike } from "../src/labels.ts";

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
    const m = /^\/repos\/drax0945\/humanize\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(u.pathname);
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
  const l = new GitHubLabels("drax0945/humanize", "tkn", gh.fetchFn);
  assert.deepEqual(await l.onStart(1), ["+triaged", "-bug"]);
  assert.deepEqual([...gh.labels].sort(), ["good first issue", "triaged"]);
  assert.ok(gh.calls.every((c) => c.auth === "Bearer tkn"));
  assert.ok(gh.calls.every((c) => c.path.startsWith("/repos/drax0945/humanize/issues/1/labels")));
});

test("start is idempotent (no bug, already triaged)", async () => {
  const gh = fakeGitHub(["triaged"]);
  const l = new GitHubLabels("drax0945/humanize", "tkn", gh.fetchFn);
  assert.deepEqual(await l.onStart(3), []);
  assert.deepEqual(
    gh.calls.map((c) => c.method),
    ["GET"],
  );
});

test("end: fixed -> fix-proposed replaces triaged; other labels untouched", async () => {
  const gh = fakeGitHub(["triaged", "good first issue"]);
  const l = new GitHubLabels("drax0945/humanize", "tkn", gh.fetchFn);
  assert.deepEqual(await l.onEnd(1, "fixed"), ["+fix-proposed", "-triaged"]);
  assert.deepEqual([...gh.labels].sort(), ["fix-proposed", "good first issue"]);
});

test("end: stopped keeps triaged; missing handoff -> needs-human", async () => {
  const gh = fakeGitHub(["triaged"]);
  const l = new GitHubLabels("drax0945/humanize", "tkn", gh.fetchFn);
  assert.deepEqual(await l.onEnd(1, "stopped"), []);
  assert.deepEqual([...gh.labels], ["triaged"]);
  assert.deepEqual(await l.onEnd(1, null), ["+needs-human", "-triaged"]);
  assert.deepEqual([...gh.labels], ["needs-human"]);
  assert.deepEqual(await l.onEnd(1, "cannot_reproduce"), ["+cannot-reproduce", "-needs-human"]);
});

test("remove tolerates a 404 (label already gone)", async () => {
  const gh = fakeGitHub([]);
  const l = new GitHubLabels("drax0945/humanize", "tkn", gh.fetchFn);
  await l.remove(1, "bug");
  assert.equal(gh.calls[0]?.method, "DELETE");
});

test("refuses other repos, unmanaged labels, a missing token and bad issue numbers", async () => {
  const gh = fakeGitHub([]);
  assert.throws(() => new GitHubLabels("python-humanize/humanize", "tkn", gh.fetchFn), /refusing/);
  assert.throws(() => new GitHubLabels("drax0945/humanize", "", gh.fetchFn), /GITHUB_PAT/);
  const l = new GitHubLabels("drax0945/humanize", "tkn", gh.fetchFn);
  await assert.rejects(l.add(1, "wontfix"), /refusing to touch label/);
  await assert.rejects(l.remove(1, "enhancement"), /refusing to touch label/);
  await assert.rejects(l.add(0, "triaged"), /bad issue number/);
  assert.equal(gh.calls.length, 0);
});

test("API errors surface with status", async () => {
  const l = new GitHubLabels("drax0945/humanize", "tkn", async () => new Response("nope", { status: 403 }));
  await assert.rejects(l.onStart(1), /403/);
});
