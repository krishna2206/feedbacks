import * as schema from "@feedbacks/schema/db";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "./env";

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });
export const db = drizzle(pool, { schema });
export type DB = typeof db;
