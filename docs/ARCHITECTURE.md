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
| Chat | `channel` (public/private/dm, optional default project, `last_seq`), `channel_member` (`last_read_seq`), `message` (`seq`, `parent_id` for threads, `reply_count`), `attachment` (pending until sent), `reaction` |
| Tickets | `ticket`, `ticket_label`, **`ticket_source`** (N:N ticket ↔ message, the link from feedback to work), `comment`, `activity` |
| Notifications | `notification` (mentions, assignments, status changes, "your message became a ticket", access requests) |
| Internal (not synced) | `storage_deletion` (files waiting to be deleted from storage, with retry state) |
| Knowledge base | `doc_folder`, `doc` (Markdown), `doc_version`, `access_grant` (org/team/user × read/edit/manage, inherited through folders) |

### What gets synced

The Postgres publication `zero_data` (migration `0001_zero_publication.sql`) and `drizzle-zero.config.ts` define what zero-cache replicates. Secrets never leave Postgres: `session`, `account` and `verification` are excluded, and `user` only exposes public profile columns. When you add a table, add it to both.

## Chat mechanics

**Unread counters without COUNT queries.** `messages.send` allocates a per-channel sequence on the server (`update channel set last_seq = last_seq + 1 … returning`) and stores it in `message.seq`. Each member keeps `channel_member.last_read_seq`, so the unread count is `channel.last_seq - last_read_seq`: O(1), no aggregate query (Zero has none). The client mirrors the increment optimistically. Opening a channel captures the read position once to draw the "New messages" divider; the list marks the channel read while its bottom is visible (`channels.markRead`, which never moves backwards). Sending a message marks the channel read for its author.

**Threads.** A reply is a `message` with `parent_id`. The parent keeps `reply_count` and `last_reply_at` (updated atomically on the server), so lists show "3 replies · last reply 2h ago" and the last repliers without fetching the thread.

**Mentions.** Bodies store `<@userId>` tokens (stable when people are renamed); clients render them as @Name. The server creates one `mention` notification per mentioned member who can read the channel (never for a private channel or DM they aren't in), with a deterministic id so editing a message doesn't duplicate it.

**Direct messages.** A DM is a channel of kind `dm` whose id is derived from its members (`dmChannelId`): opening the same conversation twice, from two devices or by both people at once, targets the same channel.

**Attachments.** `POST /api/uploads` (authenticated, the user must be able to post in the channel) stores the file and creates a *pending* `attachment` row owned by the uploader; `messages.send` then attaches it, after checking the uploader, the channel and that it isn't already attached. Images are measured and get a small WebP preview **in the browser** before upload, so the server needs no native image library. `GET /api/files/:id[/thumb]` checks access on every request (pending files: uploader only; otherwise: whoever can read the channel) and answers 404 either way, so ids don't reveal anything. Local files are streamed with `nosniff` and a sandboxing CSP; non-images are always downloaded; SVG is treated as a file. With `STORAGE_DRIVER=s3`, the API redirects to a 5-minute presigned URL (signed with `aws4fetch`, a few KB, instead of the AWS SDK).

**Uploads lifecycle — deleted means deleted.** A file must not outlive its message: people delete messages to remove what they shared (a customer's ID document, a screenshot with personal data), so keeping the file in storage would silently break that promise. Three rules make sure it's gone:

1. *Any* deletion of an `attachment` row queues its files (original and preview): a Postgres trigger inserts their keys into `storage_deletion`, whatever the cause — message deleted by its author or an admin, channel or organization removed (cascades), expired upload. Application code can't forget it.
2. The API deletes queued files right after each mutation (seconds later), so the user action never waits for, nor fails because of, the storage backend. A failed deletion stays queued with an exponential backoff (1 min → 1 day) and a `last_error`.
3. A sweeper runs in the API process at startup and every `UPLOAD_SWEEP_INTERVAL_MIN` (daily by default): it deletes *pending* uploads (never attached to a message: an abandoned draft) older than `UPLOAD_PENDING_TTL_HOURS` (24 h), then retries due deletions. Rows are claimed with `FOR UPDATE SKIP LOCKED` in batches, and deleting a missing file succeeds, so several API instances can sweep concurrently and every run is idempotent. Admins can run it by hand: `pnpm uploads:sweep [--dry-run]`.

Deleting a message soft-deletes the message itself (its thread stays readable) but hard-deletes its attachments.

**Query plans.** Zero appends the primary key to every `ORDER BY`, so indexes end with `id` (e.g. `message (channel_id, created_at, id)`), and zero-cache mirrors Postgres indexes in its SQLite replica. `pnpm analyze-query` shows the plans: the chat queries run without table scans or full sorts.

## Permissions

- **Queries** filter rows server-side (`packages/schema/src/zero/permissions.ts`). For example, a channel is visible if it's public and the user belongs to its organization, or if the user is a member of the channel. Clients only ever receive rows they may see.
- **Mutators** check permissions only when `tx.location === "server"`. On the client, the rows needed for the check may not be synced, and the server decides anyway.
- **Channels**: public channels are readable by every organization member and writable once joined (posting joins automatically); private channels and DMs are readable and writable by their members only; only their members can add people to a private channel. The creator, owners and admins rename, re-scope or archive a channel. Authors edit their messages; authors, owners and admins delete them.
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
| Browser-side image previews, `aws4fetch` for S3 | Keeps the API image small and free of native dependencies |
| Soft delete of messages, hard delete of their files | Threads stay readable; files are really gone (privacy) |
| File deletion queued by a trigger, drained by the API | Covers every deletion path (including cascades) and never fails the user action |
