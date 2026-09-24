// `pnpm dev`: embedded Postgres → migrations → zero-cache + API + web, with prefixed logs.
// Ctrl+C stops every process (children run in their own process group) and Postgres.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnv, root } from "./lib/env.mjs";
import { startEmbeddedPostgres } from "./lib/pg.mjs";

const env = loadEnv();
const colors = { pg: 36, zero: 35, api: 33, web: 32, dev: 90 };
const out = (tag, line) => {
  if (!line.trim()) return;
  process.stdout.write(`\x1b[${colors[tag]}m${tag.padEnd(4)}\x1b[0m │ ${line}\n`);
};

// Postgres logs are noisy: keep warnings/errors and the ready line
const pgLog = (m) => {
  for (const line of m.split("\n")) if (/ERROR|FATAL|WARNING|ready/.test(line)) out("pg", line);
};

const children = [];
let stopping = false;
let pg;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  out("dev", "stopping…");
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 1500));
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGKILL");
    } catch {}
  }
  await pg?.stop();
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

function run(tag, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: root, env: { ...env, FORCE_COLOR: "1", ...opts.env }, detached: true });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const l of lines) out(tag, l);
    });
  }
  child.on("exit", (code) => {
    if (!stopping) {
      out(tag, `exited with code ${code}`);
      stop(code ?? 1);
    }
  });
  return child;
}

if (env.EMBEDDED_PG === "1") pg = await startEmbeddedPostgres({ log: pgLog });

out("dev", "applying migrations…");
const mig = spawnSync("pnpm", ["--filter", "@feedbacks/schema", "--silent", "migrate"], { cwd: root, env, encoding: "utf8" });
if (mig.status !== 0) {
  out("dev", mig.stdout + mig.stderr);
  await stop(1);
}

mkdirSync(dirname(env.ZERO_REPLICA_FILE), { recursive: true });
run("api", "pnpm", ["--filter", "@feedbacks/api", "--silent", "dev"]);
run("zero", "pnpm", ["--filter", "@feedbacks/api", "--silent", "exec", "zero-cache"], {
  env: { ZERO_LOG_LEVEL: env.ZERO_LOG_LEVEL ?? "warn", ZERO_NUM_SYNC_WORKERS: "1" },
});
if (env.DEV_SKIP_WEB !== "1") run("web", "pnpm", ["--filter", "@feedbacks/web", "--silent", "dev"]);
out("dev", `app → ${env.APP_URL}`);
