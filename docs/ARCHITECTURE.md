# Architecture

## Overview

```
 Browser                          Server (one origin, e.g. https://feedbacks.example.com)
┌──────────────────────┐        ┌────────────────────────────────────────────────────────────┐
│ React SPA            │  /     │ web (nginx): static files + reverse proxy                   │
│  ├ Zero client ──────┼──WS────┼─▶ /sync ──▶ zero-cache ──(logical replication)──┐          │
│  │  (IndexedDB)      │        │               │  ▲ SQLite replica                │          │
│  │                   │        │               │  └ calls, forwarding cookies:     │          │
│  │                   │        │               ▼    /api/zero/query, /mutate      │          │
│  └ Better Auth client┼─HTTP───┼─▶ /api ───▶ api (Hono) ──────── SQL ─────────▶ Postgres    │
└──────────────────────┘        └────────────────────────────────────────────────────────────┘
```

- **Postgres is the source of truth.** Everything else can be rebuilt from it. zero-cache keeps a SQLite replica, fed by logical replication (`wal_level=logical`).
- **Reads (queries)**: the client runs a named query (e.g. `messages.byChannel`) against its local store first, so the UI updates instantly. zero-cache then asks the API (`/api/zero/query`) to turn the name and arguments into ZQL for **this user**. Permission filters are applied at that point. zero-cache runs the result against its replica and keeps the client up to date.
- **Writes (mutators)**: a mutator (e.g. `messages.send`) runs optimistically on the client, then again **on the server** in a Postgres transaction (`/api/zero/mutate`). The server run is authoritative: it checks permissions and uses the server clock. If it fails, the client change is rolled back.
- **Auth**: Better Auth sessions (cookies). zero-cache forwards the browser's cookies to the API, so query and mutate endpoints know the user. Non-browser clients (tests, MCP, CLI) authenticate with the session token as `Authorization: Bearer` (the Better Auth `bearer` plugin).
- **One origin**: `/`, `/api` and `/sync` share a domain, so there is no CORS and no cross-site cookie. zero-cache accepts an optional first path segment (`/sync/sync/v51/connect`), which is why a plain path route works. The client uses `cacheURL = ${origin}/sync`.

## Packages

| Path | Role |
|---|---|
| `packages/schema` | Drizzle schema (`src/db`), migrations, generated Zero schema (`src/zero/schema.ts`, via drizzle-zero), **shared queries and mutators with their permission rules**, enums, ids |
| `packages/ui` | Design tokens, base styles, components (Button, Menu, Modal, Tooltip, toasts, Avatar, icons, status and priority icons) |
| `apps/api` | Hono server: Better Auth (`/api/auth/*`), Zero endpoints, public instance and invitation endpoints, email, CLI scripts |
| `apps/web` | SPA: routes (TanStack Router, one chunk per page), auth screens, app shell, channel view |
| `scripts/` | Dev orchestration: embedded Postgres, `pnpm dev`, migrations, integration test |

## Data model

Every business table has `organization_id`, so an instance can host several organizations (the UI currently creates one). Primary keys are **client-generated ids** (`packages/schema/src/ids.ts`), which Zero needs to create rows optimistically.

| Area | Tables |
|---|---|
| Identity | `user`, `session`, `account`, `verification`, `organization`, `member` (owner/admin/member), `invitation`, `team`, `team_member` (Better Auth) |
| Projects | `project` (key → `APP-42`, server-side ticket counter), `project_member` (lead/contributor/reporter/viewer), `label` |
| Chat | `channel` (public/private/dm, optional default project), `channel_member` (last read), `message` (`parent_id` for threads), `attachment`, `reaction` |
| Tickets | `ticket`, `ticket_label`, **`ticket_source`** (N:N ticket ↔ message, the link from feedback to work), `comment`, `activity` |
| Notifications | `notification` (mentions, assignments, status changes, "your message became a ticket", access requests) |
| Knowledge base | `doc_folder`, `doc` (Markdown), `doc_version`, `access_grant` (org/team/user × read/edit/manage, inherited through folders) |

### What gets synced

The Postgres publication `zero_data` (migration `0001_zero_publication.sql`) and `drizzle-zero.config.ts` define what zero-cache replicates. Secrets never leave Postgres: `session`, `account` and `verification` are excluded, and `user` only exposes public profile columns. When you add a table, add it to both.

## Permissions

- **Queries** filter rows server-side (`packages/schema/src/zero/permissions.ts`). For example, a channel is visible if it's public and the user belongs to its organization, or if the user is a member of the channel. Clients only ever receive rows they may see.
- **Mutators** check permissions only when `tx.location === "server"`. On the client, the rows needed for the check may not be synced, and the server decides anyway.
- **Organization roles** (Better Auth): owner and admins invite members and change roles. **Project roles** and **document grants** are enforced by the same query and mutator mechanism as those features land.
- **Agents** (MCP, CLI) act through a user's session, so they never have more rights than that user.

## Decisions

| Decision | Why |
|---|---|
| Local-first sync (Zero) instead of REST + cache | Instant UI everywhere, realtime for free, one permission model for reads and writes. Postgres stays the source of truth, so the sync layer could be replaced |
| SPA served statically | An authenticated realtime app gains nothing from SSR. Static hosting is trivial and light |
| Invitation-only sign-up with first-run setup | Self-hosted team tool: the owner controls who joins |
| Email optional | A fresh self-hosted instance must work without SMTP |
| Embedded Postgres in dev | Zero global installs, same Postgres major as production, logical replication on |
| AGPL-3.0 | Keeps hosted forks open |
