// Menulis docs/openapi.json dari skema Zod setiap route. CI gagal bila berkas ini tidak diperbarui.
import { mkdir, writeFile } from "node:fs/promises";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";

const app = await buildApp(loadEnv({ NODE_ENV: "test", DATABASE_URL: "postgresql://openapi@localhost:5432/openapi" }));
await app.ready();
await mkdir("docs", { recursive: true });
await writeFile("docs/openapi.json", `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
console.log("docs/openapi.json diperbarui");
