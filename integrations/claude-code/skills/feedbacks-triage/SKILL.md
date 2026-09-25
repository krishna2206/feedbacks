---
name: feedbacks-triage
description: Triage the unprocessed feedback of a Feedbacks channel into tickets. Use when the user asks to go through, synthesize, sort or "turn into tickets" the recent messages, bug reports, screenshots or feedback of a Feedbacks channel (e.g. "triage #feedback", "what did the support post today?", "create tickets from yesterday's bug reports").
allowed-tools: Bash(feedbacks:*), Bash(npx @feedbacks/cli:*)
---

# Feedbacks triage

Turn the **unprocessed** messages of a channel (feedback nobody has turned into a ticket yet) into a
reviewed plan of tickets, then create them **only after the user approves**, and tell the reporters.

You act with the user's personal access token: you can only see and do what they can.
Use the `feedbacks` CLI with `--json` (stable output). If the CLI isn't available, use the
`feedbacks` MCP tools with the same names (`list_unprocessed_feedback`, `create_ticket_from_messages`, …).

## 0. Preflight

```bash
feedbacks whoami --json          # exit 2 → not logged in: ask the user to run `feedbacks login --url … --token …`
feedbacks projects list --json   # keys + whether the user can create tickets (can_create_tickets)
```

If no project allows `can_create_tickets`, say so and stop after the synthesis (step 2).

## 1. Collect

```bash
feedbacks messages list <channel> --unprocessed --since 24h --json   # default window: ask if unclear
```

For each message worth it, read its thread (`reply_count` > 0) — details asked and answered there
often change the diagnosis:

```bash
feedbacks messages thread <messageId> --json
```

Search for duplicates before proposing a new ticket:

```bash
feedbacks search "<key words>" --type ticket --json
feedbacks tickets list --status open --project <KEY> --json
```

## 2. Group and plan

- A report is usually **a text followed by screenshots** from the same author within a few minutes:
  keep them together (one ticket, several `message_ids`).
- A later precision from someone else about the same problem → link it to the same ticket.
- An existing open ticket already covers it → plan a **link**, not a new ticket.
- Pure chat ("thanks!", "ok") → skip.

Present the plan as a table and **wait for explicit approval** (the user may edit it):

| # | Action | Project | Title | Priority | Messages |
|---|---|---|---|---|---|
| 1 | create | APP | Checkout button unresponsive on Safari 17 | high | m1, m2 |
| 2 | link → APP-12 | | (precision: only with Apple Pay) | | m3 |
| 3 | skip | | "thanks!" | | m4 |

Titles: short, specific, in the language of the messages. Priority: `urgent` only for blocking
money flows / outages; otherwise `high`, `medium`, `low`. Never invent facts that aren't in the messages.

## 3. Execute (after approval only)

```bash
feedbacks tickets create --project APP --from-messages m1,m2 \
  --title "Checkout button unresponsive on Safari 17" --priority high --json
feedbacks tickets link APP-12 m3 --json
```

- The description defaults to a quote of the messages; add a short "Context / Steps / Expected"
  section with `--description` only when the thread brought real information.
- Exit code **5** with `"code": "already_linked"`: someone already created a ticket from that message.
  Read `error.details.links`, report it, and **do not** use `--force` unless the user asks.
- Exit code 3 (`forbidden` / `insufficient_scope`): the user can't create tickets there — report it.

## 4. Close the loop

Reply in each reporter's thread with the ticket key (keep it short, in their language):

```bash
feedbacks messages reply <firstMessageId> "Tracked in APP-42 — thanks!" --json
```

## 5. Report

Summarize: tickets created (key, title, URL), links added, skipped messages and why, errors.
