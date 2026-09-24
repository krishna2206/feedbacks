// Runs a command with the project environment (and the embedded dev Postgres if needed):
//   node scripts/with-env.mjs <cmd> [...args]
import { spawnSync } from "node:child_process";
import { loadEnv, root } from "./lib/env.mjs";
import { startEmbeddedPostgres } from "./lib/pg.mjs";

const env = loadEnv();
const pg = env.EMBEDDED_PG === "1" ? await startEmbeddedPostgres() : null;
const [cmd, ...args] = process.argv.slice(2);
const r = spawnSync(cmd, args, { cwd: root, env, stdio: "inherit" });
await pg?.stop();
process.exit(r.status ?? 1);
