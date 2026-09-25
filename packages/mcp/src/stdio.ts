/**
 * `feedbacks-mcp`: MCP server over stdio.
 *
 *   claude mcp add feedbacks --env FEEDBACKS_URL=https://… --env FEEDBACKS_TOKEN=fbk_… -- npx -y @feedbacks/mcp
 *
 * Credentials: FEEDBACKS_URL / FEEDBACKS_TOKEN, or the CLI's saved login (~/.config/feedbacks/config.json).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "@feedbacks/client";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFeedbacksMcpServer } from "./server";

function saved(): { url?: string; token?: string } {
  try {
    return JSON.parse(readFileSync(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "feedbacks", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

const cfg = saved();
const url = process.env.FEEDBACKS_URL || cfg.url;
const token = process.env.FEEDBACKS_TOKEN || cfg.token;
if (!url || !token) {
  process.stderr.write(
    "feedbacks-mcp: set FEEDBACKS_URL and FEEDBACKS_TOKEN (a personal access token from Settings › API tokens), or run `feedbacks login`.\n",
  );
  process.exit(1);
}

let server: ReturnType<typeof createFeedbacksMcpServer>;
const api = createClient({
  url,
  token,
  via: "mcp",
  // "via <client>" label: the MCP client's name once connected (e.g. claude-code)
  client: () => process.env.FEEDBACKS_CLIENT || server?.server.getClientVersion()?.name || "MCP",
});
server = createFeedbacksMcpServer(api);
await server.connect(new StdioServerTransport());
