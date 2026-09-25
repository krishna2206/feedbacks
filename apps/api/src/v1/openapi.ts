/**
 * OpenAPI 3.1 document of the REST API v1, generated from the route registry (Zod 4 → JSON Schema 2020-12),
 * served at GET /api/v1/openapi.json, and a lightweight HTML reference at GET /api/v1/reference.
 */
import { z } from "zod";
import { env } from "../env";
import { type AnyRoute, openApiPath, routes } from "./registry";

const schemaOf = (s: z.ZodType, io: "input" | "output") => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { io, unrepresentable: "any" }) as Record<string, unknown>;
  return rest;
};

const errorSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string", description: "Stable machine-readable code (unauthorized, forbidden, not_found, already_linked…)" },
        message: { type: "string" },
        details: {},
      },
      required: ["code", "message"],
    },
  },
  required: ["error"],
};

function parameters(route: AnyRoute) {
  const out: unknown[] = [];
  for (const [where, schema] of [
    ["path", route.params],
    ["query", route.query],
  ] as const) {
    if (!schema) continue;
    const json = schemaOf(schema, "input") as { properties?: Record<string, { description?: string }>; required?: string[] };
    for (const [name, prop] of Object.entries(json.properties ?? {})) {
      out.push({
        name,
        in: where,
        required: where === "path" || (json.required ?? []).includes(name),
        description: prop.description,
        schema: prop,
      });
    }
  }
  if (route.method !== "get")
    out.push({
      name: "Idempotency-Key",
      in: "header",
      required: false,
      description: "Retries with the same key and body replay the first response for 24 h (no duplicates)",
      schema: { type: "string", maxLength: 200 },
    });
  return out;
}

let cached: unknown;

export function openApiDocument() {
  if (cached) return cached;
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const p = openApiPath(r.path);
    paths[p] ??= {};
    (paths[p] as Record<string, unknown>)[r.method] = {
      operationId: r.operationId,
      tags: [r.tag],
      summary: r.summary,
      description: r.description,
      parameters: parameters(r),
      ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: schemaOf(r.body, "input") } } } } : {}),
      responses: {
        [String(r.status ?? 200)]: { description: "OK", content: { "application/json": { schema: schemaOf(r.response, "output") } } },
        default: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
      ...(r.method !== "get" ? { "x-scope": "read-write" } : {}),
    };
  }
  cached = {
    openapi: "3.1.0",
    info: {
      title: "Feedbacks API",
      version: "1",
      description:
        "REST API of Feedbacks for agents, scripts, the CLI and the MCP server. Authenticate with a personal access token " +
        "(`Authorization: Bearer fbk_…`, Settings › API tokens). Every request runs with exactly the permissions of the token's owner.",
      license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
    },
    servers: [{ url: `${env.appUrl}/api/v1` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "fbk_…" } },
      schemas: { Error: errorSchema },
    },
    paths,
  };
  return cached;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

/** Dependency-free HTML reference (grouped by tag, schemas in collapsible blocks) */
export function referencePage() {
  const byTag = new Map<string, AnyRoute[]>();
  for (const r of routes) byTag.set(r.tag, [...(byTag.get(r.tag) ?? []), r]);
  const block = (title: string, schema: z.ZodType | undefined, io: "input" | "output") =>
    schema ? `<details><summary>${title}</summary><pre>${esc(JSON.stringify(schemaOf(schema, io), null, 2))}</pre></details>` : "";
  const sections = [...byTag]
    .map(
      ([tag, list]) =>
        `<h2>${esc(tag)}</h2>${list
          .map(
            (r) => `<section id="${r.operationId}">
  <h3><span class="m m-${r.method}">${r.method.toUpperCase()}</span> <code>/api/v1${esc(openApiPath(r.path))}</code></h3>
  <p>${esc(r.summary)}</p>${r.description ? `<p class="d">${esc(r.description)}</p>` : ""}
  ${block("Path parameters", r.params, "input")}${block("Query parameters", r.query, "input")}${block("Request body", r.body, "input")}${block(`Response ${r.status ?? 200}`, r.response, "output")}
</section>`,
          )
          .join("")}`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feedbacks API v1</title><style>
:root{color-scheme:light dark;font:14px/1.5 system-ui,-apple-system,sans-serif}body{max-width:920px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:24px}h2{margin-top:40px;font-size:18px;border-bottom:1px solid #8884;padding-bottom:6px}h3{font-size:14px;font-weight:600;margin:0}
section{padding:12px 0;border-bottom:1px solid #8882}code,pre{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}pre{overflow:auto;padding:10px;border-radius:8px;background:#8881}
.m{display:inline-block;min-width:52px;text-align:center;border-radius:6px;padding:1px 6px;font-size:11px;color:#fff}.m-get{background:#2f7d4f}.m-post{background:#3b6fd4}.m-patch{background:#b8641c}.m-delete{background:#c0392b}
summary{cursor:pointer;color:#888;font-size:12px;margin-top:4px}.d{color:#888}
</style></head><body><h1>Feedbacks API v1</h1>
<p>Base URL <code>${esc(env.appUrl)}/api/v1</code> · Auth <code>Authorization: Bearer fbk_…</code> (Settings › API tokens) ·
Machine-readable spec: <a href="openapi.json">openapi.json</a> · Errors: <code>{"error":{"code","message","details"}}</code></p>
${sections}</body></html>`;
}
