# @feedbacks/mcp

[MCP](https://modelcontextprotocol.io) server of [Feedbacks](https://github.com/krishna2206/feedbacks):
lets AI agents read your channels, triage unprocessed feedback into tickets, answer in threads and use the
knowledge base — with exactly the permissions of the personal access token's owner.

```bash
claude mcp add feedbacks --env FEEDBACKS_URL=https://feedbacks.example.com \
  --env FEEDBACKS_TOKEN=fbk_… -- npx -y @feedbacks/mcp
```

Every Feedbacks instance also serves the same tools over Streamable HTTP at `/api/mcp`:

```bash
claude mcp add --transport http feedbacks https://feedbacks.example.com/api/mcp \
  --header "Authorization: Bearer fbk_…"
```

Tools and security model: [docs/AGENTS.md](https://github.com/krishna2206/feedbacks/blob/main/docs/AGENTS.md).

License: AGPL-3.0-only.
