// Ticket labels (SPEC T1/T15, contracts §7): GitHub issue labels via GitHub REST, or Jira labels + status via
// Jira REST. Only the shipgate.yaml target repo / Jira project, only five labels. Mechanical: the label comes
// from the handoff outcome the agent chose.
import { jiraKeyRe, loadConfig, type JiraConfig } from "./config.ts";

/** The one repo whose labels may change: shipgate.yaml target.repo. */
export function targetRepo(): string {
  return loadConfig().repo;
}

export const MANAGED_LABELS = ["bug", "triaged", "fix-proposed", "cannot-reproduce", "needs-human"] as const;
export type ManagedLabel = (typeof MANAGED_LABELS)[number];
/** Labels that describe where a ticket is; the end state keeps exactly one of them. */
const STATUS_LABELS: ManagedLabel[] = ["triaged", "fix-proposed", "cannot-reproduce", "needs-human"];

/** outcome -> end label. `stopped` keeps `triaged`; a missing handoff or unknown outcome -> `needs-human`. */
export function labelForOutcome(outcome: string | null | undefined): ManagedLabel {
  switch (outcome) {
    case "fixed":
    case "duplicate":
      return "fix-proposed";
    case "cannot_reproduce":
      return "cannot-reproduce";
    case "stopped":
      return "triaged";
    default:
      return "needs-human";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Called with the issue number (GitHub) or the ticket key (Jira); each implementation refuses the other kind. */
export interface LabelOps {
  onStart(ticket: number | string): Promise<string[]>;
  onEnd(ticket: number | string, outcome: string | null | undefined): Promise<string[]>;
}

function assertManaged(name: string): asserts name is ManagedLabel {
  if (!(MANAGED_LABELS as readonly string[]).includes(name)) throw new Error(`refusing to touch label '${name}'`);
}

/** A GitHub issue number: a positive integer (a Jira key or a numeric string is refused). */
function checkIssue(issue: number | string): number {
  if (typeof issue !== "number" || !Number.isInteger(issue) || issue <= 0) throw new Error(`bad issue number ${issue}`);
  return issue;
}

export class GitHubLabels implements LabelOps {
  private readonly owner: string;
  private readonly repo: string;

  constructor(
    repo: string,
    private readonly token: string,
    private readonly fetchFn: FetchLike = fetch,
    private readonly apiBase = "https://api.github.com",
  ) {
    if (repo.toLowerCase() !== targetRepo().toLowerCase()) throw new Error(`refusing to change labels on ${repo}; only ${targetRepo()}`);
    if (!token) throw new Error("GITHUB_PAT is not set (use --no-labels to skip label changes)");
    [this.owner, this.repo] = repo.split("/") as [string, string];
  }

  private issueUrl(issue: number, suffix: string): string {
    checkIssue(issue);
    return `${this.apiBase}/repos/${this.owner}/${this.repo}/issues/${issue}${suffix}`;
  }

  private async call(method: string, url: string, body?: unknown, allow404 = false): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "shipgate-orchestrator",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    const res = await this.fetchFn(url, init);
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub ${method} ${url.replace(this.apiBase, "")} -> ${res.status} ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  async current(issue: number): Promise<string[]> {
    const data = (await this.call("GET", this.issueUrl(issue, "/labels?per_page=100"))) as { name: string }[] | null;
    return (data ?? []).map((l) => l.name);
  }

  async add(issue: number, name: string): Promise<void> {
    assertManaged(name);
    await this.call("POST", this.issueUrl(issue, "/labels"), { labels: [name] });
  }

  async remove(issue: number, name: string): Promise<void> {
    assertManaged(name);
    await this.call("DELETE", this.issueUrl(issue, `/labels/${encodeURIComponent(name)}`), undefined, true);
  }

  /** Start (T1): add `triaged`, remove `bug`. Returns the actions taken. */
  async onStart(ticket: number | string): Promise<string[]> {
    const issue = checkIssue(ticket);
    const have = await this.current(issue);
    const done: string[] = [];
    if (!have.includes("triaged")) {
      await this.add(issue, "triaged");
      done.push("+triaged");
    }
    if (have.includes("bug")) {
      await this.remove(issue, "bug");
      done.push("-bug");
    }
    return done;
  }

  /** End (T15): exactly one status label, chosen from the handoff outcome. Returns the actions taken. */
  async onEnd(ticket: number | string, outcome: string | null | undefined): Promise<string[]> {
    const issue = checkIssue(ticket);
    const target = labelForOutcome(outcome);
    const have = await this.current(issue);
    const done: string[] = [];
    if (!have.includes(target)) {
      await this.add(issue, target);
      done.push(`+${target}`);
    }
    for (const l of STATUS_LABELS) {
      if (l !== target && have.includes(l)) {
        await this.remove(issue, l);
        done.push(`-${l}`);
      }
    }
    return done;
  }
}

// ---------- Jira ----------

const sameStatus = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Jira ticket state via Jira REST (Basic auth, JIRA_EMAIL + JIRA_API_KEY): the same five labels as GitHub plus the
 * workflow status. Start: statusStart; end: statusReview when the end label is fix-proposed, else statusOpen
 * (names from shipgate.yaml jira.status_*). Only keys of the shipgate.yaml jira project on its site.
 */
export class JiraStatus implements LabelOps {
  readonly #auth: string; // never printed: errors carry method, path and status code only
  private readonly keyRe: RegExp;

  constructor(
    private readonly jira: JiraConfig,
    email: string,
    token: string,
    private readonly fetchFn: FetchLike = fetch,
  ) {
    const pinned = loadConfig().jira;
    if (!pinned || pinned.site !== jira.site || pinned.project !== jira.project) {
      throw new Error(
        `refusing to change tickets of ${jira.project} on ${jira.site}; only the shipgate.yaml jira project ` +
          (pinned ? `(${pinned.project} on ${pinned.site})` : "(none configured)"),
      );
    }
    if (!email || !token) {
      throw new Error("JIRA_EMAIL and JIRA_API_KEY must be set (use --no-labels to skip ticket status changes)");
    }
    this.#auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    this.keyRe = jiraKeyRe(jira.project);
  }

  private key(ticket: number | string): string {
    if (typeof ticket !== "string" || !this.keyRe.test(ticket)) {
      throw new Error(`refusing to change Jira ticket ${String(ticket)}; only ${this.jira.project}-<n> on ${this.jira.site}`);
    }
    return ticket;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchFn(`https://${this.jira.site}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: this.#auth,
        "User-Agent": "shipgate-orchestrator",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      // Status code only: a Jira error body may echo request details.
      await res.body?.cancel().catch(() => {});
      throw new Error(`Jira ${method} ${path.split("?")[0]} -> ${res.status}`);
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  /** Labels and status name of a ticket. */
  async current(ticket: string): Promise<{ labels: string[]; status: string }> {
    const key = this.key(ticket);
    const data = (await this.call("GET", `/rest/api/2/issue/${key}?fields=labels,status`)) as {
      fields?: { labels?: unknown; status?: { name?: unknown } };
    } | null;
    const raw = data?.fields?.labels;
    const labels = Array.isArray(raw) ? raw.filter((l): l is string => typeof l === "string") : [];
    const name = data?.fields?.status?.name;
    return { labels, status: typeof name === "string" ? name : "" };
  }

  private async setLabels(key: string, add: string[], remove: string[]): Promise<string[]> {
    for (const l of [...add, ...remove]) assertManaged(l);
    if (add.length + remove.length === 0) return [];
    const ops = [...add.map((l) => ({ add: l })), ...remove.map((l) => ({ remove: l }))];
    await this.call("PUT", `/rest/api/3/issue/${key}`, { update: { labels: ops } });
    return [...add.map((l) => `+${l}`), ...remove.map((l) => `-${l}`)];
  }

  /** Move the ticket to `to` unless it is there already. No transition to that status = error. */
  private async moveTo(key: string, from: string, to: string): Promise<string[]> {
    if (sameStatus(from, to)) return [];
    const path = `/rest/api/3/issue/${key}/transitions`;
    const data = (await this.call("GET", path)) as { transitions?: { id?: unknown; to?: { name?: unknown } }[] } | null;
    const hit = (data?.transitions ?? []).find((t) => typeof t.to?.name === "string" && sameStatus(t.to.name, to));
    if (!hit || (typeof hit.id !== "string" && typeof hit.id !== "number")) {
      throw new Error(`Jira ${key}: no transition from '${from}' to '${to}'`);
    }
    await this.call("POST", path, { transition: { id: String(hit.id) } });
    return [`status:${from}->${to}`];
  }

  /** Runs every step even if one fails (a label error must not also leave the status behind), then reports. */
  private async all(steps: (() => Promise<string[]>)[]): Promise<string[]> {
    const done: string[] = [];
    const errors: string[] = [];
    for (const step of steps) {
      try {
        done.push(...(await step()));
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    if (errors.length > 0) throw new Error(`${errors.join("; ")}${done.length > 0 ? ` (done: ${done.join(" ")})` : ""}`);
    return done;
  }

  /** Start (T1): add `triaged`, remove `bug`, status -> statusStart. Returns the actions taken. */
  async onStart(ticket: number | string): Promise<string[]> {
    const key = this.key(ticket);
    const now = await this.current(key);
    return this.all([
      () => this.setLabels(key, now.labels.includes("triaged") ? [] : ["triaged"], now.labels.includes("bug") ? ["bug"] : []),
      () => this.moveTo(key, now.status, this.jira.statusStart),
    ]);
  }

  /** End (T15): exactly one managed label (from the outcome); status -> statusReview for fix-proposed, else statusOpen. */
  async onEnd(ticket: number | string, outcome: string | null | undefined): Promise<string[]> {
    const key = this.key(ticket);
    const target = labelForOutcome(outcome);
    const now = await this.current(key);
    const remove = MANAGED_LABELS.filter((l) => l !== target && now.labels.includes(l));
    const status = target === "fix-proposed" ? this.jira.statusReview : this.jira.statusOpen;
    return this.all([
      () => this.setLabels(key, now.labels.includes(target) ? [] : [target], remove),
      () => this.moveTo(key, now.status, status),
    ]);
  }
}
