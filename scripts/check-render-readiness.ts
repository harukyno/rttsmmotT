import { readFileSync } from "node:fs";
import type { SeedData } from "@rtts/shared";

const renderYaml = readFileSync("render.yaml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { engines?: Record<string, string>; scripts: Record<string, string> };
const generatedSeed = JSON.parse(readFileSync("data/generated/rtts-nmo.seed.json", "utf8")) as SeedData;

const checks = [
  ["Render web service exists", /type:\s*web/.test(renderYaml)],
  ["Render uses Node runtime", /runtime:\s*node/.test(renderYaml)],
  ["Render pins Node version", /key:\s*NODE_VERSION\s*\n\s*value:\s*22\.12\.0/.test(renderYaml)],
  ["package constrains Node to 22.x", packageJson.engines?.node === ">=22.12.0 <23"],
  ["Render build imports data before build", /buildCommand:\s*npm ci && npm run import:data && npm run build/.test(renderYaml)],
  ["Render starts production server", /startCommand:\s*npm start/.test(renderYaml)],
  ["Render health check points at API", /healthCheckPath:\s*\/api\/health/.test(renderYaml)],
  ["Render provisions Postgres", /databases:\s*[\s\S]*name:\s*rtts-mmo-demo-db/.test(renderYaml)],
  ["Render wires DATABASE_URL from Postgres", /key:\s*DATABASE_URL[\s\S]*fromDatabase:/.test(renderYaml)],
  ["Render requires APP_ORIGIN", /key:\s*APP_ORIGIN/.test(renderYaml)],
  ["Render requires Google OAuth client id", /key:\s*GOOGLE_CLIENT_ID/.test(renderYaml)],
  ["Render requires Google OAuth client secret", /key:\s*GOOGLE_CLIENT_SECRET/.test(renderYaml)],
  ["npm start runs built server", packageJson.scripts.start === "node packages/server/dist/index.js"],
  ["npm build builds shared, client, and server", packageJson.scripts.build.includes("@rtts/shared") && packageJson.scripts.build.includes("@rtts/client") && packageJson.scripts.build.includes("@rtts/server")],
  ["generated seed has skills", generatedSeed.skills.length >= 3],
  ["generated seed has local workbook items", generatedSeed.items.length >= 4],
  ["generated seed has local workbook materials", generatedSeed.materials.length >= 6],
  ["generated seed has local workbook magic", generatedSeed.magic.length >= 6],
  [
    "v0 skills retain Google Doc source",
    generatedSeed.skills.every((skill) => skill.source?.note?.includes("documentId=1mwi_0FxkAvcMfN1PxU-Hz6NzMsJb0ugFfaftnJSup68"))
  ]
] as const;

const failed = checks.filter(([, ok]) => !ok);
for (const [label, ok] of checks) {
  console.log(`${ok ? "ok" : "fail"} - ${label}`);
}

if (failed.length) {
  throw new Error(`Render readiness failed: ${failed.map(([label]) => label).join(", ")}`);
}
