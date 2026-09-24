// Embedded Postgres for local development: real Postgres binaries from node_modules,
// data in .data/postgres, logical replication enabled for Zero. No global install.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { root } from "./env.mjs";

const portOpen = (port) =>
  new Promise((ok) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), ok(true)));
    s.once("error", () => ok(false));
  });

/** Starts the embedded cluster (or reuses one already running). Returns a stop() function. */
export async function startEmbeddedPostgres({ log = () => {} } = {}) {
  const port = Number(process.env.PG_PORT);
  if (await portOpen(port)) {
    log(`reusing Postgres already listening on :${port}`);
    return { stop: async () => {}, reused: true };
  }
  const databaseDir = resolve(process.env.DATA_DIR ?? resolve(root, ".data"), "postgres");
  const fresh = !existsSync(resolve(databaseDir, "PG_VERSION")) && (!existsSync(databaseDir) || readdirSync(databaseDir).length === 0);
  mkdirSync(databaseDir, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: "feedbacks",
    password: "feedbacks",
    port,
    persistent: true,
    postgresFlags: ["-c", "wal_level=logical", "-c", "max_replication_slots=10", "-c", "max_wal_senders=10"],
    onLog: (m) => log(String(m).trim()),
    onError: (e) => log(String(e).trim()),
  });
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase("feedbacks");
  log(`Postgres ready on :${port}${fresh ? " (new cluster)" : ""}`);
  return { stop: () => pg.stop(), reused: false };
}
