/** Production migration entry: applies Drizzle migrations from MIGRATIONS_DIR (default ./migrations). */
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const pool = new pg.Pool({ connectionString: url });
try {
  await migrate(drizzle(pool), { migrationsFolder: resolve(process.env.MIGRATIONS_DIR ?? "migrations") });
  console.log("migrations applied");
} finally {
  await pool.end();
}
