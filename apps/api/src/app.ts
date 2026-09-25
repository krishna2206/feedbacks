import { Hono } from "hono";
import { logger } from "hono/logger";
import { auth } from "./auth";
import { isDev } from "./env";
import { mountFiles } from "./routes/files";
import { mountPublic } from "./routes/public";
import { mountSearch } from "./routes/search";
import { mountZero } from "./zero";

export const app = new Hono();

if (isDev) app.use("/api/*", logger());
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
mountPublic(app);
mountFiles(app);
mountSearch(app);
mountZero(app);
app.notFound((c) => c.json({ error: "not_found" }, 404));
