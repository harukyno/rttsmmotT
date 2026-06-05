import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { SeedData } from "@rtts/shared";

describe("importer contract", () => {
  it("keeps the local workbook path configurable", () => {
    expect(process.env.RTTS_NMO_XLSX ?? "C:\\Users\\haruk\\Downloads\\RTTS NMO.xlsx").toContain("RTTS NMO.xlsx");
  });

  it("keeps a generated v0 seed available for Render builds", () => {
    const seed = JSON.parse(readFileSync("data/generated/rtts-nmo.seed.json", "utf8")) as SeedData;

    expect(seed.skills.length).toBeGreaterThanOrEqual(3);
    expect(seed.items.length).toBeGreaterThanOrEqual(4);
    expect(seed.materials.length).toBeGreaterThanOrEqual(6);
    expect(seed.magic.length).toBeGreaterThanOrEqual(6);
    expect(seed.skills.every((skill) => skill.source?.note?.includes("documentId=1mwi_0FxkAvcMfN1PxU-Hz6NzMsJb0ugFfaftnJSup68"))).toBe(true);
  });
});
