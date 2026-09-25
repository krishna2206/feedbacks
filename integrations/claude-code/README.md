# Claude Code integration

## Skill: `feedbacks-triage`

Synthesizes the unprocessed feedback of a channel, proposes a ticket plan (grouping texts and their
screenshots, detecting duplicates), **waits for your approval**, creates the tickets and answers the
reporters in their threads.

### Install

1. Create a personal access token in Feedbacks: **Settings › API tokens** (scope *Read & write*).
2. Install and log in the CLI (the skill uses it; the MCP server works as a fallback):

   ```bash
   npm install -g @feedbacks/cli        # or: node packages/cli/dist/feedbacks.js from this repo
   feedbacks login --url https://feedbacks.example.com --token fbk_…
   ```

3. Copy the skill into your personal or project skills:

   ```bash
   # personal (every project)
   mkdir -p ~/.claude/skills && cp -r integrations/claude-code/skills/feedbacks-triage ~/.claude/skills/
   # or project-only
   mkdir -p .claude/skills && cp -r integrations/claude-code/skills/feedbacks-triage .claude/skills/
   ```

4. In Claude Code: *"Triage #feedback since yesterday"*, or `/feedbacks-triage`.

## MCP server (optional)

```bash
# Remote (Streamable HTTP), nothing to install
claude mcp add --transport http feedbacks https://feedbacks.example.com/api/mcp \
  --header "Authorization: Bearer fbk_…"

# Local (stdio)
claude mcp add feedbacks --env FEEDBACKS_URL=https://feedbacks.example.com \
  --env FEEDBACKS_TOKEN=fbk_… -- npx -y @feedbacks/mcp
```

See [docs/AGENTS.md](../../docs/AGENTS.md) for the full reference.
