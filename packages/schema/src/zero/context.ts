/** Context passed to every query and mutator. Built server-side from the Better Auth session. */
export type ZeroContext = {
  userID: string;
  /** How the mutation reached the server: the web app (default) or an agent through the MCP server (M5) */
  via?: "app" | "mcp";
};

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    context: ZeroContext;
  }
}
