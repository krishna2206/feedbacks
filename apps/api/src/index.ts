import { serve } from "@hono/node-server";
import { app } from "./app";
import { pool } from "./db";
import { env } from "./env";

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});

const shutdown = () => {
  server.close();
  void pool.end().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
