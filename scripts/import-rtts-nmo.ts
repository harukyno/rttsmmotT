import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { unzipSync } from "fflate";
import type { ItemDefinition, MagicDefinition, MaterialDefinition, SeedData } from "@rtts/shared";

const defaultWorkbook = "C:\\Users\\haruk\\Downloads\\RTTS NMO.xlsx";
const workbookPath = process.env.RTTS_NMO_XLSX || defaultWorkbook;
const outputPath = resolve("data/generated/rtts-nmo.seed.json");
const fallbackSeedPath = resolve("data/seed.json");

type SheetRows = Record<string, string>[];

type WorkbookData = {
  path: string;
  sheets: Array<{ name: string; rows: SheetRows }>;
};

function main() {
  const seed = JSON.parse(readFileSync(fallbackSeedPath, "utf8")) as SeedData;
  if (!existsSync(workbookPath)) {
    console.warn(`RTTS NMO workbook was not found at ${workbookPath}; preserving existing generated seed when available.`);
    if (!existsSync(outputPath)) writeSeed({ ...seed, items: [], materials: [], magic: [] });
    return;
  }

  const workbook = readWorkbook(workbookPath);
  const imported: SeedData = {
    skills: seed.skills,
    items: [...importWeaponSamples(workbook), ...importFirearmAmmoSamples(workbook), ...importArmorSamples(workbook)],
    materials: importMaterialSamples(workbook),
    magic: importMagicSamples(workbook)
  };
  writeSeed(imported);
  console.log(`Imported ${imported.items.length} items, ${imported.materials.length} materials, ${imported.magic.length} magic definitions.`);
}

function readWorkbook(path: string): WorkbookData {
  const zip = unzipSync(new Uint8Array(readFileSync(path)));
  const text = (name: string) => Buffer.from(zip[name]).toString("utf8");
  const workbookXml = text("xl/workbook.xml");
  const relsXml = text("xl/_rels/workbook.xml.rels");
  const sharedStrings = zip["xl/sharedStrings.xml"] ? parseSharedStrings(text("xl/sharedStrings.xml")) : [];
  const relTargets = new Map<string, string>();
  for (const rel of relsXml.matchAll(/<Relationship\b([^>]+)>/g)) {
    const attrs = attrsOf(rel[1] ?? "");
    if (attrs.Id && attrs.Target) relTargets.set(attrs.Id, attrs.Target);
  }

  const sheets: WorkbookData["sheets"] = [];
  for (const sheet of workbookXml.matchAll(/<sheet\b([^>]+?)\/>/g)) {
    const attrs = attrsOf(sheet[1] ?? "");
    const relId = attrs["r:id"];
    if (!attrs.name || !relId) continue;
    const target = relTargets.get(relId);
    if (!target) continue;
    const file = normalizeXlPath(target);
    const bytes = zip[file];
    if (!bytes) continue;
    sheets.push({
      name: attrs.name,
      rows: parseSheet(Buffer.from(bytes).toString("utf8"), sharedStrings)
    });
  }
  return { path, sheets };
}

function parseSharedStrings(xml: string): string[] {
  const values: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const si = match[1] ?? "";
    const parts = [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1] ?? ""));
    values.push(parts.join(""));
  }
  return values;
}

function parseSheet(xml: string, sharedStrings: string[]): SheetRows {
  const rows: SheetRows = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowAttrs = attrsOf(rowMatch[1] ?? "");
    const row: Record<string, string> = {};
    const rowBody = (rowMatch[2] ?? "").replaceAll(/<c\b[^>]*\/>/g, "");
    for (const cellMatch of rowBody.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = attrsOf(cellMatch[1] ?? "");
      const ref = attrs.r;
      if (!ref) continue;
      const column = ref.replace(/\d+/g, "");
      const body = cellMatch[2] ?? "";
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
      if (!raw) continue;
      row[column] = attrs.t === "s" ? sharedStrings[Number(raw)] ?? "" : decodeXml(raw);
    }
    const rowNumber = Number(rowAttrs.r);
    if (Number.isFinite(rowNumber) && rowNumber > 0) rows[rowNumber - 1] = row;
    else rows.push(row);
  }
  return rows;
}

function importWeaponSamples(workbook: WorkbookData): ItemDefinition[] {
  const rows = workbook.sheets[0]?.rows ?? [];
  const samples = [
    { row: 7, id: "weapon_sample_1" },
    { row: 15, id: "weapon_sample_2" }
  ];
  return samples
    .map(({ row, id }) => ({
      id,
      name: valueAt(rows, row - 2, "BH") || `weapon ${id}`,
      kind: "weapon" as const,
      price: numberFrom(valueAt(rows, row - 1, "BN")),
      weightKg: numberFrom(valueAt(rows, row - 1, "BS")),
      details: valueAt(rows, row, "BH"),
      source: {
        workbook: workbook.path,
        sheet: workbook.sheets[0]?.name ?? "sheet1",
        range: `BH${row + 1}`,
        note: "Curated v0 weapon sample"
      }
    }))
    .filter((item) => item.details);
}

function importArmorSamples(workbook: WorkbookData): ItemDefinition[] {
  const sheet = workbook.sheets[55] ?? workbook.sheets[51];
  const rows = sheet?.rows ?? [];
  if (!sheet) return [];
  const hp = valueAt(rows, 16, "AE");
  const def = valueAt(rows, 18, "AE");
  const weight = valueAt(rows, 19, "T");
  const materialCost = valueAt(rows, 18, "T");
  return [
    {
      id: "armor_sample_1",
      name: sheet.name,
      kind: "armor",
      price: numberFrom(materialCost),
      weightKg: numberFrom(weight),
      details: `HP:${hp || "unknown"} DEF:${def || "unknown"} weightKg:${weight || "unknown"} materialCost:${materialCost || "unknown"}`,
      source: {
        workbook: workbook.path,
        sheet: sheet.name,
        range: "AE17:AE19,T19:T20",
        note: "Curated v0 armor sample"
      }
    }
  ];
}

function importFirearmAmmoSamples(workbook: WorkbookData): ItemDefinition[] {
  const candidates = [
    { id: "ammo_sample_1", sheetIndex: 18, kind: "ammo" as const },
    { id: "firearm_sample_1", sheetIndex: 19, kind: "weapon" as const }
  ];
  return candidates.flatMap((candidate) => {
    const sheet = workbook.sheets[candidate.sheetIndex];
    if (!sheet) return [];
    const rows = sheet.rows;
    const price = numberFrom(valueAt(rows, 6, "BN") || valueAt(rows, 10, "BH"));
    const weightKg = numberFrom(valueAt(rows, 6, "BS"));
    const detail = valueAt(rows, 7, "BH");
    return [
      {
        id: candidate.id,
        name: sheet.name,
        kind: candidate.kind,
        price,
        weightKg,
        details: detail && detail !== "#N/A" ? detail : `sourceSheet:${sheet.name} price:${price ?? "unknown"} weightKg:${weightKg ?? "unknown"}`,
        source: {
          workbook: workbook.path,
          sheet: sheet.name,
          range: "BH6:BS8",
          note: candidate.kind === "ammo" ? "Curated v0 ammo sample" : "Curated v0 firearm sample"
        }
      }
    ];
  });
}

function importMaterialSamples(workbook: WorkbookData): MaterialDefinition[] {
  const sheet = workbook.sheets[73];
  const rows = sheet?.rows ?? [];
  if (!sheet) return [];
  return ["D", "E", "F", "G", "H", "I"].map((column) => ({
    id: `material_${slug(valueAt(rows, 1, column) || column)}`,
    name: valueAt(rows, 1, column) || column,
    density: numberFrom(valueAt(rows, 2, column)),
    amr: numberFrom(valueAt(rows, 3, column)),
    def: numberFrom(valueAt(rows, 4, column)),
    hp: numberFrom(valueAt(rows, 5, column)),
    tgh: numberFrom(valueAt(rows, 6, column)),
    source: {
      workbook: workbook.path,
      sheet: sheet.name,
      range: `${column}2:${column}7`,
      note: "Curated v0 material row set"
    }
  }));
}

function importMagicSamples(workbook: WorkbookData): MagicDefinition[] {
  const sheet = workbook.sheets[77];
  const rows = sheet?.rows ?? [];
  if (!sheet) return [];
  const blocks = [
    { nameCol: "D", noteCol: "E", label: "six-color" },
    { nameCol: "V", noteCol: "W", label: "chant" },
    { nameCol: "AN", noteCol: "AO", label: "faith" }
  ];
  const starts = [4, 12, 20, 28, 36, 44];
  const magic: MagicDefinition[] = [];
  for (const block of blocks) {
    for (const start of starts) {
      const name = valueAt(rows, start, block.nameCol);
      if (!name) continue;
      magic.push({
        id: `magic_${slug(name)}`,
        name,
        description: valueAt(rows, start + 1, block.nameCol),
        intCost: numberFrom(valueAt(rows, start + 4, block.nameCol)),
        mpCost: parseCost(valueAt(rows, start + 5, block.nameCol)),
        apCost: numberFrom(valueAt(rows, start + 6, block.nameCol)) ?? 1,
        source: {
          workbook: workbook.path,
          sheet: sheet.name,
          range: `${block.nameCol}${start + 1}:${block.nameCol}${start + 7}`,
          note: block.label
        }
      });
      if (magic.length >= 6) return magic;
    }
  }
  return magic;
}

function attrsOf(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of raw.matchAll(/([\w:]+)="([^"]*)"/g)) attrs[attr[1]!] = decodeXml(attr[2] ?? "");
  return attrs;
}

function normalizeXlPath(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  return `xl/${target}`.replace("xl/xl/", "xl/");
}

function valueAt(rows: SheetRows, index: number, column: string): string {
  return String(rows[index]?.[column] ?? "").trim();
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function numberFrom(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function parseCost(value: unknown): number | "X" {
  if (String(value).trim().toUpperCase() === "X") return "X";
  return numberFrom(value) ?? 0;
}

function slug(value: string): string {
  return value
    .normalize("NFKC")
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, "_")
    .replaceAll(/^_+|_+$/g, "")
    .toLowerCase();
}

function writeSeed(seed: SeedData) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
}

main();
