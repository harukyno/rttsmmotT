import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SeedData } from "@rtts/shared";

export function loadSeedData(): SeedData {
  const generated = resolve("data/generated/rtts-nmo.seed.json");
  const fallback = resolve("data/seed.json");
  const path = existsSync(generated) ? generated : fallback;
  return JSON.parse(readFileSync(path, "utf8")) as SeedData;
}
