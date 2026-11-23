import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ASSISTANT_TOOLS } from "../src/agent/assistant-registry.js";
import { AGENT_TOOLS } from "../src/agent/registry.js";

// Petunjuk Mapbox dan Google tidak pernah menjadi masukan AI (ADR-0052; Product Terms Mapbox §1.5).
describe("provider hints stay away from the AI", () => {
  it("no agent or route assistant tool is about hints", () => {
    const names = [...AGENT_TOOLS, ...ASSISTANT_TOOLS].map((tool) => `${tool.name} ${tool.description}`);
    for (const text of names) expect(text).not.toMatch(/hint|petunjuk|wheelchair_accessible|accessibilityOptions|google/i);
  });

  it("no agent module, agent route, or walking-route module imports the hints module", async () => {
    const agentFiles = (await readdir(new URL("../src/agent/", import.meta.url))).map((file) => `src/agent/${file}`);
    const files = [...agentFiles, "src/routes/agent.ts", "src/routes/assistant.ts", "src/map/walking-route.ts", "src/knowledge/search.ts"];
    for (const file of files) {
      const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/from "\.\.?\/(\.\.\/)?hints\//);
      expect(source, file).not.toMatch(/routes\/hints/);
    }
  });

  it("no agent module or OSM query the assistant uses reads the stored Google Maps or OSM copies", async () => {
    const agentFiles = (await readdir(new URL("../src/agent/", import.meta.url))).map((file) => `src/agent/${file}`);
    for (const file of [...agentFiles, "src/contribute/facilities.ts", "src/knowledge/search.ts"]) {
      const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/aksesbogor:(google_maps|osm_aksesibilitas)/);
    }
  });
});
