// `pnpm test:e2e-sync`: boots an isolated stack (temporary data dir, dedicated ports,
// no web server), runs apps/api/test/e2e-sync.ts against it, then tears everything down.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root } from "./lib/env.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "feedbacks-e2e-"));
const env = {
  ...process.env,
  DATA_DIR: dataDir,
  PG_PORT: "5459",
  API_PORT: "5322",
  ZERO_PORT: "4878",
  WEB_PORT: "5321",
  APP_URL: "http://localhost:5322",
  DEV_SKIP_WEB: "1",
};
delete env.DATABASE_URL;

const stack = spawn("node", ["scripts/dev.mjs"], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
stack.stdout.on("data", (d) => (log += d));
stack.stderr.on("data", (d) => (log += d));

async function waitFor(url, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
}

let status = 1;
try {
  await waitFor(`http://localhost:${env.API_PORT}/api/health`);
  await waitFor(`http://localhost:${env.ZERO_PORT}/keepalive`);
  const testEnv = { ...env, DATABASE_URL: `postgres://feedbacks:feedbacks@localhost:${env.PG_PORT}/feedbacks` };
  const r = spawnSync("pnpm", ["--filter", "@feedbacks/api", "--silent", "exec", "tsx", "test/e2e-sync.ts"], {
    cwd: root,
    env: testEnv,
    stdio: "inherit",
  });
  status = r.status ?? 1;
} catch (e) {
  console.error(e);
  console.error(log.slice(-4000));
} finally {
  process.kill(-stack.pid, "SIGINT");
  await new Promise((r) => stack.once("exit", r));
  rmSync(dataDir, { recursive: true, force: true });
}
// Strip ANSI colors (ESC [ … m) from the captured log
const ESC = String.fromCharCode(27);
if (status !== 0) console.error(`\n--- stack log (tail) ---\n${log.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "").slice(-3000)}`);
process.exit(status);
