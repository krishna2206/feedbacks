import { serve } from "@hono/node-server";
import { app } from "./app";
import { pool } from "./db";
import { env } from "./env";
import { startUploadSweeper } from "./uploads-sweeper";

const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
// Deletes expired pending uploads and retries failed file deletions (startup + interval)
startUploadSweeper();

const shutdown = () => {
  server.close();
  void pool.end().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
