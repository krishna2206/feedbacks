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
| Projects | `project` (key → `APP-42`, server-side ticket counter, visibility `org`/`members`), `project_member` (lead/contributor/reporter/viewer), `label` |
| Chat | `channel` (public/private/dm, optional default project, `last_seq`), `channel_member` (`last_read_seq`), `message` (`seq`, `parent_id` for threads, `reply_count`, `ticket_count`), `attachment` (pending until sent), `reaction` |
| Tickets | `ticket`, `ticket_label`, **`ticket_source`** (N:N ticket ↔ message, the link from feedback to work), `ticket_alias` (former keys of moved tickets), `comment`, `activity` |
| Notifications | `notification` (mentions, assignments, status changes, comments, "your message became a ticket", access requests; `read_at`, `archived_at`), `notification_setting` (per user and organization: muted kinds, browser notifications) |
| Internal (not synced) | `storage_deletion` (files waiting to be deleted from storage, with retry state), `search_doc` (full-text index, maintained by triggers) |
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
3. A sweeper runs in the API process at startup and every `UPLOAD_SWEEP_INTERVAL_MIN` (daily by default): it deletes *pending* uploads (never attached to a message: an abandoned draft) older than `UPLOAD_PENDING_TTL_HOURS` (24 h), then retries due deletions. Rows are claimed with `FOR UPDATE SKIP LOCKED` in batches, and deleting a missing file succeeds, so several API instances can sweep concurrently and every run is idempotent. Admins can run it by hand: `pnpm uploads:sweep [--dry-run]`; `UPLOAD_SWEEP_INTERVAL_MIN=0` turns the in-process sweeper off (e.g. to run the CLI from a cron job instead).

Deleting a message soft-deletes the message itself (its thread stays readable) but hard-deletes its attachments.

**Query plans.** Zero appends the primary key to every `ORDER BY`, so indexes end with `id` (e.g. `message (channel_id, created_at, id)`), and zero-cache mirrors Postgres indexes in its SQLite replica. `pnpm analyze-query` shows the plans: chat and ticket queries search indexes; the remaining `TEMP B-TREE FOR LAST TERM OF ORDER BY` lines are tie-breaker sorts on `id` inside an index range.

## Ticket mechanics

**Numbering without gaps or duplicates.** `tickets.create` (and `tickets.move`) run `update project set ticket_counter = ticket_counter + 1 … returning` inside the server transaction. The update row-locks the project, so concurrent creations are serialized: numbers are unique and contiguous, and a failed transaction rolls the counter back with everything else. The client applies the same increment to its local copy, so an optimistic ticket shows a *provisional* number; if someone else created a ticket at the same moment, the authoritative row syncs back with the final number a few milliseconds later. Keys (`APP-42`) are never stored: they're `project.key` + `number`, and project keys can't be changed.

**Moving a ticket** gives it the next number of the target project and records the former `(project, number)` in `ticket_alias`, so links to the old key still resolve (the ticket page redirects). Counters never go back, so a number is never reused.

**Messages → tickets, idempotently.** `ticket_source` links a ticket to the chat messages it was built from (text, screenshots, a precision posted later). Creating a ticket from messages, or linking messages to a ticket, is refused with an `ALREADY_LINKED` application error when a message already backs another ticket; the error's `details` list the existing links (`{ code, links: [{ messageId, ticketId }] }`), and the same call with `force: true` links it anyway. This is the rule the REST API and the MCP server will expose, so an agent can safely re-run "turn today's feedback into tickets". The web app checks the same thing locally first and asks before forcing.

**"Unprocessed" messages.** `message.ticket_count` is maintained by a trigger on `ticket_source` (insert/delete, including cascades), so the *Unprocessed* tab is a plain indexed filter (`ticket_count = 0`) rather than an anti-join, which Zero doesn't support on the client.

**Activities and notifications.** Mutations record activities (`created`, `status`, `priority`, `assignee`, `title`, `description`, `labels`, `project`, `linked_messages`, `unlinked_messages`) with ids derived from the caller's `eventId`, so the optimistic and authoritative runs write the same rows. Notifications are created on the server only: assignment (to the assignee), status change (creator, assignee and **authors of the source messages**: the people who reported the problem learn that it moved), "your message became a ticket" (source authors), comments and mentions. The actor is never notified.

**Descriptions and comments** are Markdown rendered to React elements by a small block renderer (headings, quotes, lists, code) on top of the chat's inline renderer: no HTML string is ever injected, so there is nothing to sanitize.

## Notifications and search

**Notifications, not an inbox.** A conversation lives in the chat, where unread badges already show it; an *event* lives in the notifications. So there's no Inbox page: a bell in the sidebar opens a panel (Unread / All, mark read or unread, archive, mark all read), the tab title shows the unread count (`(3) Feedbacks`), and people can opt in to browser notifications, shown only when the tab isn't focused. The kinds:

| Kind | Who gets it |
|---|---|
| `mention` | people mentioned in a channel, a thread or a ticket comment, if they can read it — **never in a direct message** |
| `ticket_assigned` | the new assignee |
| `ticket_status` | the creator, the assignee and the authors of the source messages |
| `comment` | the ticket's followers: creator, assignee, source-message authors and previous commenters who can still read it |
| `ticket_from_my_message` | authors of the messages a ticket was built from |
| `access_request` | document managers (knowledge base, M4) |

Notifications are written by the server mutators only, never for the actor. **Preferences** (`notification_setting`, one row per user and organization, id `${organizationId}:${userId}`) list muted kinds: a muted kind is simply never created for that person, so there's nothing to filter later. Read state and archiving go through `notifications.setRead / markAllRead / archive`, which refuse to touch someone else's rows. The panel and the badge use `notifications.list` (`unread` or `all`, own rows of one organization, newest first), indexed by `(user_id, organization_id, archived_at, [read_at,] created_at, id)`.

**Full-text search** is served by the API (`GET /api/search`), not by Zero: it needs Postgres full-text search and a ranking, over data that isn't necessarily synced to the client.

- *Index.* `search_doc` has one row per message, ticket and comment (documents come in M4), kept up to date by triggers on the source tables — insert, edit, soft-delete, move, cascade — and backfilled by the migration. Deleting a message removes it from search. `tsv` combines a weighted title (ticket key + title) and body (message with mentions rendered as @Name, ticket description, comment), built with the `simple` configuration over text folded by `search_fold` (`unaccent`): no stemming or stop words, so it behaves the same in every language, and matching ignores case and accents. Ticket keys are indexed as `APP 12`, since the parser reads `APP-12` as a word and the integer `-12`. When the `unaccent` extension isn't available, search still works but becomes accent-sensitive.
- *Query.* Every word of the query must match the start of a word (`'deplo':* & 'paie':*`), so results follow the typing. Results are ranked by `ts_rank_cd`, then by date.
- *Permissions.* The SQL applies the same rules as the Zero queries: messages of public channels of the organization and of channels (private, DMs) the user belongs to; tickets and comments of readable projects, or of tickets built from the user's messages. Non-members of the organization get a 403.
- *Highlights.* Snippets are cut and highlighted by the API on the original text (`ts_headline` could only highlight the folded text and would lose accents), with private-use characters around matches that the client renders as `<mark>` elements, never as HTML.

**Command menu (⌘K).** The chunk loads while the browser is idle. Typing filters commands, projects, channels and people locally (accent-insensitive), shows matching tickets from the local store instantly, then merges server results (tickets, comments, messages) as they arrive; requests are debounced (120 ms) and stale ones aborted. Sub-pages (status, priority, assignee, labels, project, language) act on the ticket or channel on screen. Recently opened items are kept per organization in `localStorage`.

**Keyboard shortcuts** are global (capture phase, so a `G` then `P` sequence never reaches a page's own `P` handler) and never fire while typing: `⌘K`, `/` search, `?` help, `G` then `M` / `P` / `D` / `S`, `C` new ticket, `[` sidebar. Pages add their own (lists, chat selection, ticket page).

## Permissions

- **Queries** filter rows server-side (`packages/schema/src/zero/permissions.ts`). For example, a channel is visible if it's public and the user belongs to its organization, or if the user is a member of the channel. Clients only ever receive rows they may see.
- **Mutators** check permissions only when `tx.location === "server"`. On the client, the rows needed for the check may not be synced, and the server decides anyway.
- **Channels**: public channels are readable by every organization member and writable once joined (posting joins automatically); private channels and DMs are readable and writable by their members only; only their members can add people to a private channel. The creator, owners and admins rename, re-scope or archive a channel. Authors edit their messages; authors, owners and admins delete them.
- **Organization roles** (Better Auth): owner and admins invite members and change roles. **Document grants** will use the same query and mutator mechanism (M4).
- **Projects**: owners and admins create, archive and see every project. A project with visibility `org` is readable by every organization member (implicit *viewer*); with `members`, only by its members. Project roles decide what people can do: **lead** manages the project and its members, **contributor** creates and edits tickets, **reporter** reads and comments, **viewer** reads.
- **Tickets** are readable when their project is, and also by the **authors of their source messages**, even in a project they can't otherwise see: whoever reported a problem can follow what became of it. Creating and editing tickets requires lead/contributor (or admin); commenting requires reporter or above, or being a source author. Labels are created by contributors and above, renamed or deleted by admins.
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
| Ticket counter row-locked in the mutation transaction | Gap-free per-project numbers under concurrency, with provisional numbers on the client |
| `ALREADY_LINKED` + `force` for message → ticket links | Re-running a conversion (human or agent) never silently duplicates tickets |
| `message.ticket_count` maintained by a trigger | "Unprocessed" becomes an indexed filter; correct on every path, including cascades |
| Source authors can read their tickets | Closing the loop with the people who report problems, without opening whole projects |
