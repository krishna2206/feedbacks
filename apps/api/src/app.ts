import { Hono } from "hono";
import { logger } from "hono/logger";
import { auth } from "./auth";
import { isDev } from "./env";
import { mountDocs } from "./routes/docs";
import { mountFiles } from "./routes/files";
import { mountMcp } from "./routes/mcp";
import { mountPublic } from "./routes/public";
import { mountSearch } from "./routes/search";
import { mountTokens } from "./routes/tokens";
import { v1 } from "./v1/app";
import { openApiDocument, referencePage } from "./v1/openapi";
import { mountZero } from "./zero";

export const app = new Hono();

if (isDev) app.use("/api/*", logger());
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
mountPublic(app);
mountFiles(app);
mountSearch(app);
mountDocs(app);
mountTokens(app);
mountZero(app);
// REST API v1 (personal access tokens): agents, scripts, CLI, MCP server
app.get("/api/v1/openapi.json", (c) => c.json(openApiDocument() as object));
app.get("/api/v1/reference", (c) => c.html(referencePage()));
app.route("/api/v1", v1);
mountMcp(app);
app.notFound((c) => c.json({ error: "not_found" }, 404));
