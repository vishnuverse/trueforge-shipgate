// Fill {{placeholders}} in the skill and agent spec from shipgate.yaml (spec any-repo §3).
import type { Config } from "./config.ts";

export class RenderError extends Error {}

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

export function templateValues(c: Config): Record<string, string> {
  return {
    repo: c.repo,
    owner: c.owner,
    name: c.name,
    default_branch: c.defaultBranch,
    install: c.install,
    test: c.test,
    source_dir: c.sourceDir,
    tests_dir: c.testsDir,
    model: c.model,
  };
}

export function renderText(text: string, values: Record<string, string>, where = "template"): string {
  const out = text.replace(PLACEHOLDER, (_m, key: string) => {
    const v = values[key];
    if (v === undefined) throw new RenderError(`${where}: no value for {{${key}}}`);
    return v;
  });
  if (out.includes("{{")) throw new RenderError(`${where}: '{{' left after rendering`);
  return out;
}

export function renderDeep<T>(value: T, values: Record<string, string>, where = "template"): T {
  if (typeof value === "string") return renderText(value, values, where) as T;
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, values, where)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, values, where)])) as T;
  }
  return value;
}

/** Lines of worked examples from the demo repo, which stay literal: an `Example (` line through the end of the next
 *  ~~~ fenced block, or up to a closing `</tag>` line when no fence comes first. */
export function exampleMask(lines: string[]): boolean[] {
  const mask = lines.map(() => false);
  let i = 0;
  while (i < lines.length) {
    if (!(lines[i] ?? "").startsWith("Example (")) {
      i++;
      continue;
    }
    let j = i;
    let fenceOpen = false;
    for (; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (line.startsWith("~~~")) {
        mask[j] = true;
        if (fenceOpen) break;
        fenceOpen = true;
        continue;
      }
      if (line.startsWith("</") && !fenceOpen) {
        j--;
        break;
      }
      mask[j] = true;
    }
    i = j + 1;
  }
  return mask;
}
