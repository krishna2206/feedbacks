/** Context passed to every query and mutator. Built server-side from the Better Auth session. */
export type ZeroContext = {
  userID: string;
  /** How the mutation reached the server: the web app (default), the REST API (CLI, scripts) or the MCP server */
  via?: "app" | "api" | "mcp";
  /** Label of the agent/client for API and MCP writes (e.g. "Claude Code", "feedbacks-cli"), shown as "via …" */
  client?: string;
};

/** "via …" label stored on messages and comments written by an agent (null for the web app) */
export function viaLabel(ctx: ZeroContext, location: "client" | "server"): string | null {
  if (location !== "server" || !ctx.via || ctx.via === "app") return null;
  return (ctx.client?.trim() || (ctx.via === "mcp" ? "MCP" : "API")).slice(0, 60);
}

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    context: ZeroContext;
  }
}
