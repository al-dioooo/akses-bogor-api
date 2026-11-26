import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ASSISTANT_TOOLS } from "../src/agent/assistant-registry.js";
import { AGENT_TOOLS } from "../src/agent/registry.js";

// Petunjuk Mapbox dan Google, termasuk salinan tersimpan, tidak pernah menjadi masukan AI (ADR-0052; Product Terms
// Mapbox §1.5). Hanya app.ts, routes/hints.ts, dan skrip Google Maps (ADR-0056) yang boleh memakai modul petunjuk.
const ROOT = new URL("../", import.meta.url);
const ALLOWED_IMPORTERS = new Set(["src/app.ts", "src/routes/hints.ts", "scripts/petunjuk/google-maps-ambil.ts"]);

/** Semua berkas TypeScript di bawah `dir`, sebagai path relatif dari akar repo. */
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(new URL(dir, ROOT), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(ts|mts|js|mjs)$/.test(entry.name))
    .map((entry) => relative(fileURLToPath(ROOT), join(entry.parentPath, entry.name)).split(sep).join("/"));
}

const sources = async () => {
  const files = [...(await sourceFiles("src/")), ...(await sourceFiles("scripts/"))].filter((file) => !file.startsWith("src/hints/"));
  return Promise.all(files.map(async (file) => ({ file, source: await readFile(new URL(file, ROOT), "utf8") })));
};

describe("provider hints stay away from the AI", () => {
  it("no agent or route assistant tool is about hints", () => {
    const names = [...AGENT_TOOLS, ...ASSISTANT_TOOLS].map((tool) => `${tool.name} ${tool.description}`);
    for (const text of names) expect(text).not.toMatch(/hint|petunjuk|wheelchair_accessible|accessibilityOptions|google/i);
  });

  it("only app.ts, routes/hints.ts and the Google Maps scripts import the hints module or its route, anywhere in src/ and scripts/", async () => {
    const files = await sources();
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((f) => f.file)).toContain("src/agent/assistant-tools.ts");
    for (const { file, source } of files) {
      if (ALLOWED_IMPORTERS.has(file)) continue;
      expect(source, file).not.toMatch(/(?:from|import\()\s*["'][^"']*\bhints\/[^"']*["']/);
      expect(source, file).not.toMatch(/routes\/hints/);
    }
  });

  it("no code outside the hints module reads the stored Google Maps or OSM copies", async () => {
    for (const { file, source } of await sources()) expect(source, file).not.toMatch(/aksesbogor:(google_maps|osm_aksesibilitas)/);
  });
});
