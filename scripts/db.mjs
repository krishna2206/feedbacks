// `pnpm db:migrate` / `pnpm db:seed`: runs against DATABASE_URL, starting the
// embedded dev Postgres first when no external database is configured.
import { spawnSync } from "node:child_process";
import { loadEnv } from "./lib/env.mjs";
import { startEmbeddedPostgres } from "./lib/pg.mjs";

const cmd = process.argv[2];
if (!["migrate", "seed"].includes(cmd)) {
  console.error("usage: node scripts/db.mjs migrate|seed");
  process.exit(1);
}
loadEnv();
const pg = process.env.EMBEDDED_PG === "1" ? await startEmbeddedPostgres({ log: (m) => console.log(`[pg] ${m}`) }) : null;
const run = (pkg, script) => spawnSync("pnpm", ["--filter", pkg, "--silent", script], { stdio: "inherit", env: process.env });
let status = run("@feedbacks/schema", "migrate").status;
if (status === 0 && cmd === "seed") status = run("@feedbacks/api", "seed").status;
await pg?.stop();
process.exit(status ?? 1);
