# Feedbacks

**Team chat that turns feedback into tickets.** Open source, self-hosted, local-first, AI-native.

Most teams collect feedback in group chats: screenshots from support, bug reports from sales, notes before a release. It gets lost between messages. Feedbacks keeps the conversation *and* the work in one place:

- **Chat**: public and private channels, direct messages, threads, @mentions, reactions, attachments (drag & drop or paste, image previews), unread counters.
- **Messages → tickets**: select a message and its screenshot, create a ticket pre-filled from them, or link them to an existing ticket. Every ticket keeps its **source messages**, and the people who reported the problem are notified when it moves.
- **Tickets**: projects with roles (lead, contributor, reporter, viewer) and visibility, list and board views, statuses, priorities, labels, assignees, comments and activity, keyboard-first navigation. Moving a ticket to another project keeps its former key working.
- **Notifications, ⌘K and search**: a bell for what concerns you (mentions, assignments, status changes, comments on tickets you follow, "your message became a ticket"), never for direct messages: conversations stay in the chat. A command menu to do and find anything from the keyboard, and full-text search across messages, tickets and comments that ignores case and accents and never shows what you can't read.
- **Knowledge base**: Markdown documents in folders, with Drive-like sharing (organization, teams or people × read / edit / manage, inherited through folders, restrictable), version history with diffs and restore, conflict detection, trash, a table of contents, links to tickets, `[[document]]` mentions in chat, search, and import from a `.zip` of Markdown files. Owners and admins can preview what a member sees ("view as").
- **AI-native**: a REST API and an **MCP server**, so agents like Claude Code can read conversations, turn feedback into tickets and pick up work, with exactly the permissions of the person using them.
- **Fast**: every interaction is instant. Data is synced locally with [Zero](https://zero.rocicorp.dev), so the UI never waits for the network.

> **Status: early development.** Milestones M0 (foundations), M1 (chat), M2 (tickets) and M3 (notifications, command menu, search) are done. See the [roadmap](#roadmap).

## Stack

| Layer | Choice |
|---|---|
| Web | React 19, Vite, TypeScript, TanStack Router, plain CSS with design tokens, i18next (English, French) |
| Sync | [Zero](https://zero.rocicorp.dev) (local-first, query-driven sync over Postgres logical replication) |
| API | [Hono](https://hono.dev) on Node: auth, Zero query/mutate endpoints, REST API (coming) |
| Auth | [Better Auth](https://www.better-auth.com): email and password, optional Google, organizations and invitations |
| Data | PostgreSQL (source of truth), Drizzle ORM and migrations |

Architecture details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Develop

Requirements: **Node 22+** and **pnpm**. There is nothing else to install: Postgres runs embedded from `node_modules`, with no Docker and no global database.

```bash
pnpm install
pnpm dev            # Postgres + migrations + zero-cache + API + web → http://localhost:5301
```

On a fresh instance, open the app. You're redirected to **/setup** to create your account and your organization, and you become its owner. Alternatively, load demo data:

```bash
pnpm db:seed        # owner demo@example.com / demo-password, organization "Demo": channels, a DM, a thread, an image,
                    # 3 projects, labels and tickets (some built from chat messages, others left "unprocessed")
```

| Command | What it does |
|---|---|
| `pnpm dev` | Full stack with prefixed logs; Ctrl+C stops everything |
| `pnpm db:migrate` | Apply migrations (starts the embedded Postgres if needed) |
| `pnpm db:generate` | Generate a migration and the Zero schema after editing `packages/schema/src/db` |
| `pnpm db:seed` | Demo data on an empty instance |
| `pnpm user:reset-password <email> [password]` | Reset a password without email configured |
| `pnpm uploads:sweep [--dry-run] [--ttl-hours=N]` | Delete expired pending uploads and retry failed file deletions (also runs automatically; in Docker: `node dist/sweep-uploads.js`) |
| `pnpm lint` · `pnpm typecheck` · `pnpm build` | Checks |
| `pnpm test:e2e-sync` | Integration test on an isolated stack: auth, invitations, Zero writes, chat permissions, mentions, unread counters, attachments, project roles, concurrent ticket numbering, messages → tickets, comments, moves |
| `pnpm analyze-query --zero-cache-url=http://localhost:4848 --admin-password=dev --cookie=… --user-id=… --query-name=… --query-args=…` | Query plan of a Zero query against a running zero-cache |

Dev data lives in `.data/`. Delete that folder to start from scratch.

## Self-host

```bash
cp .env.example .env     # set APP_URL, POSTGRES_PASSWORD, BETTER_AUTH_SECRET, ZERO_ADMIN_PASSWORD
docker compose up -d     # → http://localhost:8080 (HTTP_PORT)
```

Four containers: `postgres` (with `wal_level=logical`), `api`, `zero-cache` and `web`. Attachments are stored in the `uploads-data` volume by default, or in any S3-compatible bucket with `STORAGE_DRIVER=s3` (AWS, OCI Object Storage, MinIO, R2…). The `web` container is the single entry point: nginx serves the app and routes `/api` to the API and `/sync` to zero-cache. Behind Traefik, Dokploy or any other reverse proxy, point your domain at `web:80`. Migrations run automatically when the API starts.

### Access model

- A **fresh instance** lets the first person sign up: they create the organization and become its **owner**.
- After that, **sign-up is invitation-only**. The owner and admins invite people by email and choose their role. The invitation link lets the invitee set a name and password and join.
- **Email is optional.** Without SMTP (`SMTP_*`), invitation and password-reset links are printed in the API logs, and owners can copy invitation links from the UI. `pnpm user:reset-password` resets a password from the server.
- **Google sign-in** is enabled only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set. Register `${APP_URL}/api/auth/callback/google` as a redirect URI.

## Roadmap

| | Milestone |
|---|---|
| ✅ M0 | Foundations: monorepo, Postgres + Zero + API, auth and invitations, app shell, working channel, Docker, CI |
| ✅ M1 | Chat: public/private channels, direct messages, threads, mentions, reactions, attachments (disk or S3), unread counters |
| ✅ M2 | Tickets: projects and roles, list and board, **messages → ticket**, source messages, comments, activity |
| ✅ M3 | Notifications (bell, preferences, browser notifications), ⌘K command menu, full-text search, keyboard shortcuts |
| ✅ M4 | Knowledge base: teams, folders and Markdown documents, inherited permissions, versions and conflicts, trash, links to tickets, import |
| M5 | REST API v1, **MCP server**, CLI |
| M6 | Production deployment guide, mobile app (Expo) |

## License

[AGPL-3.0](LICENSE). You can use, modify and self-host Feedbacks freely. If you offer a modified version as a network service, you must publish your changes.
