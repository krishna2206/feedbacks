// Loads `.env` (if present) and fills development defaults. No dependency on dotenv.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const root = resolve(import.meta.dirname, "../..");

export function loadEnv() {
  const file = resolve(root, ".env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const d = (k, v) => {
    if (!process.env[k]) process.env[k] = String(v);
  };
  d("WEB_PORT", 5301);
  d("API_PORT", 5302);
  d("ZERO_PORT", 4848);
  d("PG_PORT", 5439);
  d("APP_URL", `http://localhost:${process.env.WEB_PORT}`);
  d("DATA_DIR", resolve(root, ".data"));
  mkdirSync(process.env.DATA_DIR, { recursive: true });
  if (!process.env.BETTER_AUTH_SECRET) {
    // Random dev secret, persisted so sessions survive restarts
    const f = resolve(process.env.DATA_DIR, "auth-secret");
    if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString("base64url"));
    process.env.BETTER_AUTH_SECRET = readFileSync(f, "utf8").trim();
  }
  d("ZERO_ADMIN_PASSWORD", "dev");
  process.env.EMBEDDED_PG = process.env.DATABASE_URL ? "0" : "1";
  d("DATABASE_URL", `postgres://feedbacks:feedbacks@localhost:${process.env.PG_PORT}/feedbacks`);
  d("ZERO_UPSTREAM_DB", process.env.DATABASE_URL);
  d("ZERO_CVR_DB", process.env.DATABASE_URL);
  d("ZERO_CHANGE_DB", process.env.DATABASE_URL);
  d("ZERO_REPLICA_FILE", resolve(process.env.DATA_DIR, "zero/replica.db"));
  d("ZERO_APP_PUBLICATIONS", "zero_data");
  d("ZERO_QUERY_URL", `http://localhost:${process.env.API_PORT}/api/zero/query`);
  d("ZERO_MUTATE_URL", `http://localhost:${process.env.API_PORT}/api/zero/mutate`);
  d("ZERO_QUERY_FORWARD_COOKIES", "true");
  d("ZERO_MUTATE_FORWARD_COOKIES", "true");
  d("ZERO_ENABLE_CRUD_MUTATIONS", "false");
  return process.env;
}
