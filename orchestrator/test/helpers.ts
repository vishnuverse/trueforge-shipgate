import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EventItem } from "../src/events.ts";

export const FIXTURE_PATH = fileURLToPath(
  new URL("../../tests/fixtures/trueforge/sample_session_events.json", import.meta.url),
);

/** The real capture (oldest first): gate on github/get_me (call_233096), denied in a later turn. */
export function loadFixture(): EventItem[] {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as EventItem[];
}

export const GATED_TURN = "01m3d0gh10f0se1kcdjbg1czq8";
export const DECISION_TURN = "01m3d0hmta8jwpr3vwnxm39p90";
