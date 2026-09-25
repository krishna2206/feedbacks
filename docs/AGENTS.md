# Agents: tokens, CLI, MCP, REST API

Feedbacks has no AI inside. Instead, any agent you choose (Claude Code, Cursor, a script…) can work
with your discussions, tickets and documents through four interfaces that share **one set of rules**:

| Interface | Best for | Entry point |
|---|---|---|
| **CLI** `feedbacks` | Agents with a shell (recommended), scripts, humans | `npm i -g @feedbacks/cli` |
| **MCP server** | MCP clients (Claude Code, Claude Desktop, Cursor…) | `/api/mcp` (HTTP) or `npx @feedbacks/mcp` (stdio) |
| **Claude Code skill** | The full triage loop, with your approval | [`integrations/claude-code`](../integrations/claude-code) |
| **REST API v1** | Anything else | `/api/v1` — reference at `/api/v1/reference`, spec at `/api/v1/openapi.json` |

## Security model

- **Personal access tokens** (`fbk_…`) are created in **Settings › API tokens**. A token belongs to one
  member of one organization and has a scope: **Read only** (GET) or **Read & write**. It can expire.
- **An agent is exactly you.** Every request runs as the token's owner through the same queries and
  mutators as the web app: private channels, members-only projects and restricted documents you can't
  see stay invisible; actions you can't do are refused (403/404). There is no admin backdoor.
- Everything an agent writes is **attributed to you** and marked discreetly: tickets record
  `created_via: api | mcp`, messages and comments show "via Claude Code" (the client label).
- **Revoke** a token at any time (Settings › API tokens). Owners and admins can see and revoke every
  token of the organization. A token also stops working when its owner leaves the organization.
- Only the SHA-256 of a token is stored; the secret is shown once. The CLI stores it in
  `~/.config/feedbacks/config.json` with mode 600.
- Prefer a **Read only** token for agents that only need to read, and short expirations.

## CLI

```bash
feedbacks login --url https://feedbacks.example.com --token fbk_…
feedbacks messages list feedback --unprocessed --since 24h --json
feedbacks tickets create --project APP --from-messages <id1>,<id2> --priority high --json
feedbacks messages reply <id1> "Tracked in APP-42" --json
```

`feedbacks --help` lists every command. Conventions for agents:

- `--json` prints the API response unchanged (stable snake_case fields); errors print
  `{"error": {"code", "message", "details"}}` to stdout.
- Exit codes: `0` ok · `1` error · `2` usage · `3` auth/permission · `4` not found · `5` conflict
  (`already_linked`, `doc_conflict`) · `6` rate limited · `7` network.
- `@name` / `@email` in message and comment text are turned into mentions when they match exactly one
  member (`--no-mentions` to disable).
- Every write carries an automatic `Idempotency-Key`, reused on automatic retries: a network retry never
  creates a duplicate.
- Credentials: `feedbacks login`, or `FEEDBACKS_URL` / `FEEDBACKS_TOKEN`; `FEEDBACKS_CLIENT` sets the
  "via …" label (default `feedbacks-cli`).

## MCP server

| Tool | Kind | What it does |
|---|---|---|
| `list_channels` | read | Channels the user can read |
| `read_messages` | read | Top-level messages of a channel (attachments, linked tickets) |
| `list_unprocessed_feedback` | read | Messages of others that no ticket was built from yet |
| `get_thread` | read | A message and its replies |
| `search` | read | Full text in messages, tickets, comments, documents |
| `list_projects` / `list_tickets` / `get_ticket` | read | Projects (with `can_create_tickets`), tickets, one ticket with sources and comments |
| `search_docs` / `read_doc` | read | Knowledge base |
| `post_message` / `reply_in_thread` | write | Post as the user (marked "via …") |
| `create_ticket_from_messages` | write | Ticket from messages; `already_linked` unless `force` |
| `link_messages_to_ticket` / `update_ticket` / `add_comment` | write | Follow-ups |
| `update_doc` | write (destructive) | New version of a document, with `base_version` conflict detection |

```bash
# HTTP (no install): stateless Streamable HTTP, JSON responses
claude mcp add --transport http feedbacks https://feedbacks.example.com/api/mcp --header "Authorization: Bearer fbk_…"
# stdio
claude mcp add feedbacks --env FEEDBACKS_URL=https://feedbacks.example.com --env FEEDBACKS_TOKEN=fbk_… -- npx -y @feedbacks/mcp
```

Over stdio the "via …" label is the MCP client's name; over HTTP it comes from the `X-Feedbacks-Client`
header, else from the User-Agent (`claude-code/…` → `claude-code`), else `MCP`.

## REST API v1

- Base URL `https://<instance>/api/v1`, `Authorization: Bearer fbk_…`, JSON in and out (snake_case).
- Main resources: `/me`, `/users`, `/channels`, `/channels/{channel}/messages`
  (`since`, `until`, `unprocessed`, `limit`, `cursor`), `/messages/{id}`, `/messages/{id}/thread`,
  `/messages/{id}/replies`, `/search`, `/projects`, `/labels`, `/tickets` (filters, cursor),
  `/tickets/{KEY-12|id}` (GET, PATCH), `/tickets/{ticket}/comments`, `/tickets/{ticket}/links`,
  `/docs/tree`, `/docs/search`, `/docs/{id}` (GET, PATCH with `base_version`), `/docs` (POST),
  `/notifications`, `/notifications/read`.
- Channels accept an id or a name (`feedback`, `#feedback`); tickets a key (`APP-12`, former keys
  included) or an id; assignees `me`, an id or an email; labels names or ids; priorities 0–4 or names.
- **Errors**: `{ "error": { "code", "message", "details" } }` with stable codes: `unauthorized` (401),
  `insufficient_scope` / `forbidden` (403), `not_found` (404, also for things you may not see),
  `invalid_request` (400), `already_linked` / `doc_conflict` / `idempotency_in_progress` (409),
  `idempotency_key_reused` / `unprocessable` (422), `rate_limited` (429).
- **Idempotency**: send `Idempotency-Key` on POST/PATCH/DELETE; the first response is replayed for 24 h
  (`Idempotent-Replayed: true`).
- **Pagination**: `limit` + opaque `cursor`; responses carry `next_cursor` (null on the last page).
- **Rate limits**: per token, `API_RATE_LIMIT_PER_MIN` requests and `API_WRITE_RATE_LIMIT_PER_MIN` writes
  (defaults 300 and 60); `429` with `Retry-After`.
- Attachment `url`s are authenticated: send the same bearer token.

## Good practices for agent workflows

1. **Read, then propose, then act.** Let the user approve the plan before creating tickets.
2. **Group** a text and the screenshots posted right after it into one ticket; link later precisions.
3. **Search for duplicates** (`search`, `tickets list --status open`) before creating.
4. **Never `force`** a message into a second ticket unless the user asked.
5. **Close the loop**: reply in the reporter's thread with the ticket key.
6. For documents, always send the `version` you read as `base_version`; on `doc_conflict`, re-read and
   merge instead of forcing.
