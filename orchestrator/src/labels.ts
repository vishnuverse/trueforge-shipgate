// Issue labels (SPEC T1/T15, contracts §7) via GitHub REST. Only drax0945/humanize, only five labels.

export const TARGET_REPO = "drax0945/humanize";
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

export interface LabelOps {
  onStart(issue: number): Promise<string[]>;
  onEnd(issue: number, outcome: string | null | undefined): Promise<string[]>;
}

function assertManaged(name: string): asserts name is ManagedLabel {
  if (!(MANAGED_LABELS as readonly string[]).includes(name)) throw new Error(`refusing to touch label '${name}'`);
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
    if (repo !== TARGET_REPO) throw new Error(`refusing to change labels on ${repo}; only ${TARGET_REPO}`);
    if (!token) throw new Error("GITHUB_PAT is not set (use --no-labels to skip label changes)");
    [this.owner, this.repo] = repo.split("/") as [string, string];
  }

  private issueUrl(issue: number, suffix: string): string {
    if (!Number.isInteger(issue) || issue <= 0) throw new Error(`bad issue number ${issue}`);
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
  async onStart(issue: number): Promise<string[]> {
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
  async onEnd(issue: number, outcome: string | null | undefined): Promise<string[]> {
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
