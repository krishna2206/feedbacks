/**
 * MCP over Streamable HTTP: POST/GET/DELETE /api/mcp with `Authorization: Bearer fbk_…`.
 *
 * Stateless: each request gets its own MCP server whose tools call the REST API v1 in-process
 * (`app.request`, no network hop) with the caller's token, so the same authentication, scopes,
 * rate limits, idempotency and permission checks apply as for the CLI and the stdio server.
 */
import { createClient } from "@feedbacks/client";
import { createFeedbacksMcpServer } from "@feedbacks/mcp";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { env } from "../env";
import { authenticateToken, bearerToken } from "../tokens";

const GENERIC_AGENTS = new Set(["node", "undici", "mozilla", "curl", "python-requests", "axios", "node-fetch"]);

export function mountMcp(app: Hono) {
  app.all("/api/mcp", async (c) => {
    const token = bearerToken(c.req.raw.headers);
    if (!token || !(await authenticateToken(token))) {
      c.header("WWW-Authenticate", 'Bearer realm="feedbacks"');
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Missing, invalid, expired or revoked access token (Authorization: Bearer fbk_…)" },
          id: null,
        },
        401,
      );
    }
    // Stateless: the server of a tool call never saw the client's `initialize`, so the "via …" label comes
    // from X-Feedbacks-Client, else the User-Agent's product (e.g. "claude-code/1.0" → "claude-code")
    const ua = /^([A-Za-z][\w.-]{1,40})\//.exec(c.req.header("user-agent") ?? "")?.[1];
    const label = c.req.header("x-feedbacks-client") || (ua && !GENERIC_AGENTS.has(ua.toLowerCase()) ? ua : "MCP");
    const api = createClient({
      url: env.appUrl,
      token,
      via: "mcp",
      client: label,
      retries: 0,
      // In-process call of the REST API (same app): path relative to the instance
      fetch: async (input, init) => app.request(new URL(input).pathname + new URL(input).search, init),
    });
    const server = createFeedbacksMcpServer(api);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void transport.close();
      void server.close();
    }
  });
}
