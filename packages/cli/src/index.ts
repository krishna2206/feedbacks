/**
 * `feedbacks` — command-line interface of Feedbacks for humans and AI agents.
 *
 * Output: readable text by default, `--json` for a stable machine-readable format (the API response
 * as-is, or `{ "error": { code, message, details } }` on failure). Exit codes:
 *   0 ok · 1 error · 2 usage · 3 auth/permission · 4 not found · 5 conflict · 6 rate limited · 7 network
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  createClient,
  FeedbacksApiError,
  type FeedbacksClient,
  type Member,
  type Message,
  type Ticket,
  type TicketDetail,
} from "@feedbacks/client";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

/* ------------------------------ Args ------------------------------ */

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  url: { type: "string" },
  token: { type: "string" },
  // listings
  since: { type: "string" },
  until: { type: "string" },
  unprocessed: { type: "boolean" },
  limit: { type: "string" },
  all: { type: "boolean" },
  cursor: { type: "string" },
  kind: { type: "string" },
  joined: { type: "boolean" },
  type: { type: "string" },
  channel: { type: "string" },
  // tickets
  project: { type: "string" },
  status: { type: "string" },
  priority: { type: "string" },
  assignee: { type: "string" },
  label: { type: "string", multiple: true },
  title: { type: "string" },
  description: { type: "string" },
  "description-file": { type: "string" },
  "from-messages": { type: "string" },
  force: { type: "boolean" },
  // docs
  folder: { type: "string" },
  file: { type: "string" },
  "base-version": { type: "string" },
  raw: { type: "boolean" },
  // api
  data: { type: "string" },
  "idempotency-key": { type: "string" },
  "no-mentions": { type: "boolean" },
} as const;

type Flags = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K] extends { multiple: true }
    ? string[]
    : (typeof OPTIONS)[K]["type"] extends "boolean"
      ? boolean
      : string;
};

class UsageError extends Error {}

/* ------------------------------ Output ------------------------------ */

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[22m` : s),
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[22m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[39m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[39m` : s),
  cyan: (s: string) => (tty ? `\x1b[36m${s}\x1b[39m` : s),
};
const out = (s = "") => process.stdout.write(`${s}\n`);
const trunc = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
const when = (isoDate: string) => {
  const d = new Date(isoDate);
  return `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`;
};

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const visible = (s: string) => s.replace(ANSI, "").length;

function table(rows: string[][]) {
  const widths: number[] = [];
  for (const r of rows) {
    r.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visible(cell));
    });
  }
  for (const r of rows)
    out(r.map((cell, i) => (i === r.length - 1 ? cell : cell + " ".repeat((widths[i] ?? 0) - visible(cell)))).join("  "));
}

function printMessage(m: Message, indent = "") {
  const who = m.author?.name ?? "Unknown";
  const meta = [when(m.created_at), m.via ? `via ${m.via}` : "", m.reply_count ? `${m.reply_count} replies` : ""]
    .filter(Boolean)
    .join(" · ");
  out(`${indent}${c.bold(who)} ${c.dim(meta)} ${c.dim(`[${m.id}]`)}`);
  for (const line of m.text.split("\n")) out(`${indent}  ${line}`);
  for (const a of m.attachments) out(`${indent}  ${c.dim(`📎 ${a.name} (${a.mime_type}, ${Math.round(a.size / 1024)} KB) ${a.url}`)}`);
  if (m.tickets.length) out(`${indent}  ${c.cyan(m.tickets.map((t) => `→ ${t.key} [${t.status}] ${t.title}`).join("  "))}`);
}

function printTicket(t: Ticket) {
  const labels = t.labels.map((l) => l.name).join(", ");
  table([
    [c.bold(t.key), t.title],
    [c.dim("status"), `${t.status} · priority ${t.priority_name}${t.assignee ? ` · assignee ${t.assignee.name}` : ""}`],
    ...(labels ? [[c.dim("labels"), labels]] : []),
    [c.dim("created"), `${when(t.created_at)} by ${t.creator?.name ?? "?"} (${t.created_via})`],
    [c.dim("url"), t.url],
  ]);
}

function printTicketDetail(t: TicketDetail) {
  printTicket(t);
  if (t.description) {
    out();
    out(t.description);
  }
  if (t.source_messages.length) {
    out();
    out(c.bold(`Source messages (${t.source_messages.length})`));
    for (const m of t.source_messages) printMessage(m, "  ");
  }
  if (t.comments.length) {
    out();
    out(c.bold(`Comments (${t.comments.length})`));
    for (const cm of t.comments) {
      out(`  ${c.bold(cm.author?.name ?? "?")} ${c.dim(when(cm.created_at))}${cm.via ? c.dim(` via ${cm.via}`) : ""}`);
      for (const line of cm.text.split("\n")) out(`    ${line}`);
    }
  }
  if (t.docs.length) {
    out();
    out(c.bold("Documents"));
    for (const d of t.docs) out(`  ${d.title} ${c.dim(d.url)}`);
  }
}

/* ------------------------------ Config ------------------------------ */

const configPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "feedbacks", "config.json");

function loadConfig(): { url?: string; token?: string } {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg: { url: string; token: string }) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  chmodSync(p, 0o600);
}

function clientFrom(flags: Flags): FeedbacksClient {
  const cfg = loadConfig();
  // Empty variables count as unset
  const url = flags.url || process.env.FEEDBACKS_URL || cfg.url;
  const token = flags.token || process.env.FEEDBACKS_TOKEN || cfg.token;
  if (!url || !token)
    throw new UsageError("Not logged in: run `feedbacks login --url <instance> --token <fbk_…>` or set FEEDBACKS_URL / FEEDBACKS_TOKEN");
  return createClient({ url, token, client: process.env.FEEDBACKS_CLIENT || "feedbacks-cli" });
}

/* ------------------------------ Helpers ------------------------------ */

const need = (v: string | undefined, what: string) => {
  if (!v) throw new UsageError(`Missing ${what}`);
  return v;
};
const intFlag = (v: string | undefined, what: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`${what} must be an integer`);
  return n;
};

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Text from positionals, or from stdin when the text is "-" (or absent and stdin is piped) */
function textArg(parts: string[], what: string): string {
  if (parts.length === 1 && parts[0] === "-") return readStdin();
  if (parts.length) return parts.join(" ");
  if (!process.stdin.isTTY) return readStdin();
  throw new UsageError(`Missing ${what}`);
}

const fileArg = (path: string) => (path === "-" ? readStdin() : readFileSync(path, "utf8"));

/** "@alice" / "@alice@example.com" → `<@userId>` when it matches exactly one member (name, first name or email) */
async function resolveMentions(api: FeedbacksClient, text: string, flags: Flags) {
  if (flags["no-mentions"] || !/(^|\s)@[\p{L}\p{N}._-]/u.test(text)) return text;
  const members: Member[] = (await api.users.list()).data;
  const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return text.replace(/(^|\s)@([\p{L}\p{N}._+-]+(?:@[\w.-]+)?)/gu, (all, pre: string, handle: string) => {
    const h = norm(handle);
    const hits = members.filter(
      (m) =>
        norm(m.email) === h ||
        norm(m.email.split("@")[0] ?? "") === h ||
        norm(m.name).replace(/\s+/g, "") === h ||
        norm(m.name.split(/\s+/)[0] ?? "") === h,
    );
    return hits.length === 1 ? `${pre}<@${(hits[0] as Member).id}>` : all;
  });
}

/* ------------------------------ Commands ------------------------------ */

const HELP = `feedbacks ${VERSION} — Feedbacks from the command line (humans and AI agents)

Usage: feedbacks <command> [options]

Setup
  login --url <instance> --token <fbk_…>   Save credentials (~/.config/feedbacks/config.json, mode 600)
  logout                                   Forget them
  whoami                                   User, organization, role and token scope

Chat
  channels list [--kind public|private|dm] [--joined]
  messages list <#channel> [--since 24h] [--until …] [--unprocessed] [--limit N] [--all]
  messages get <messageId>
  messages thread <messageId>
  messages post <#channel> <text…|->        Post a message ("@name" mentions are resolved)
  messages reply <messageId> <text…|->      Reply in the message's thread

Tickets
  projects list        labels list        users list
  tickets list [--project KEY] [--status open|todo,…] [--assignee me|none|email] [--label L] [--limit N] [--all]
  tickets get <KEY-12|id>
  tickets create --project KEY [--title T] [--description D | --description-file F]
                 [--from-messages id,id] [--status S] [--priority urgent|high|medium|low|none]
                 [--assignee me|email] [--label L]… [--force]
                 With --from-messages, title/description default to the messages; a message already
                 linked to another ticket is refused (exit 5, already_linked) unless --force.
  tickets update <ref> [--title] [--description|--description-file] [--status] [--priority] [--assignee] [--label L]… [--project KEY]
  tickets comment <ref> <text…|->
  tickets link <ref> <messageId…> [--force]
  tickets unlink <ref> <messageId>

Search and knowledge base
  search <query…> [--type message,ticket,comment,doc] [--channel C] [--project KEY] [--limit N]
  docs tree            docs get <id> [--raw]            docs search <query…>
  docs create --title T [--folder ID] [--file F|-]
  docs update <id> --file F|- [--title T] [--base-version N] [--force]
  docs edit <id>                           Open in $EDITOR, save as a new version (conflicts detected)

Other
  notifications [--all]                    notifications read <id…> | --all
  api <METHOD> <path> [--data JSON]        Raw call, e.g. feedbacks api GET /tickets?status=open

Global options
  --json                 Stable JSON output (API response as-is; errors as {"error":{code,message,details}})
  --url, --token         Override the saved instance / token (or FEEDBACKS_URL, FEEDBACKS_TOKEN)
  -h, --help             -v, --version

Exit codes: 0 ok · 1 error · 2 usage · 3 auth/permission · 4 not found · 5 conflict · 6 rate limited · 7 network`;

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const flags = values as Flags;
  const json = !!flags.json;
  const print = (data: unknown, human: () => void) => (json ? out(JSON.stringify(data, null, 2)) : human());
  const [cmd, sub, ...rest] = positionals;

  if (flags.version) {
    out(VERSION);
    return 0;
  }
  if (flags.help || !cmd || cmd === "help") {
    out(HELP);
    return 0;
  }

  if (cmd === "login") {
    const url = need(flags.url, "--url");
    const token = need(flags.token || process.env.FEEDBACKS_TOKEN, "--token");
    const me = await createClient({ url, token }).me();
    saveConfig({ url: url.replace(/\/+$/, ""), token });
    print(me, () => out(`${c.green("✓")} Logged in as ${me.user.name} in ${me.organization.name} (${me.token.scope}) — ${configPath()}`));
    return 0;
  }
  if (cmd === "logout") {
    if (existsSync(configPath())) rmSync(configPath());
    print({ ok: true }, () => out("Logged out"));
    return 0;
  }

  const api = clientFrom(flags);
  const limit = intFlag(flags.limit, "--limit");

  switch (cmd) {
    case "whoami": {
      const me = await api.me();
      print(me, () =>
        table([
          [c.dim("user"), `${me.user.name} <${me.user.email}>`],
          [c.dim("organization"), `${me.organization.name} (${me.organization.slug})`],
          [c.dim("role"), me.role],
          [c.dim("token"), `${me.token.scope}`],
        ]),
      );
      return 0;
    }
    case "channels": {
      if (sub !== "list") throw new UsageError("Usage: feedbacks channels list");
      const kind = flags.kind as "public" | "private" | "dm" | undefined;
      const r = await api.channels.list({ kind, joined: flags.joined });
      print(r, () =>
        table(
          r.data.map((ch) => [
            ch.kind === "dm" ? `@${ch.name}` : `#${ch.name}`,
            c.dim(ch.kind),
            ch.is_member ? "" : c.dim("(not joined)"),
            c.dim(ch.topic ? trunc(ch.topic, 60) : ""),
          ]),
        ),
      );
      return 0;
    }
    case "messages": {
      if (sub === "list") {
        const channel = need(rest[0], "<channel>");
        const q = { since: flags.since, until: flags.until, unprocessed: flags.unprocessed, limit, cursor: flags.cursor };
        let page = await api.messages.list(channel, q);
        const data = [...page.data];
        while (flags.all && page.next_cursor && data.length < 5000) {
          page = await api.messages.list(channel, { ...q, cursor: page.next_cursor });
          data.push(...page.data);
        }
        print({ data, next_cursor: flags.all ? null : page.next_cursor }, () => {
          if (!data.length) out(c.dim("No messages"));
          for (const m of [...data].reverse()) {
            printMessage(m);
            out();
          }
          if (!flags.all && page.next_cursor) out(c.dim(`More: --cursor ${page.next_cursor} (or --all)`));
        });
        return 0;
      }
      if (sub === "get") {
        const m = await api.messages.get(need(rest[0], "<messageId>"));
        print(m, () => printMessage(m));
        return 0;
      }
      if (sub === "thread") {
        const t = await api.messages.thread(need(rest[0], "<messageId>"));
        print(t, () => {
          printMessage(t.parent);
          for (const r of t.replies) printMessage(r, "    ");
        });
        return 0;
      }
      if (sub === "post" || sub === "reply") {
        const target = need(rest[0], sub === "post" ? "<channel>" : "<messageId>");
        const text = await resolveMentions(api, textArg(rest.slice(1), "message text"), flags);
        const m = sub === "post" ? await api.messages.post(target, text) : await api.messages.reply(target, text);
        print(m, () => out(`${c.green("✓")} Posted ${c.dim(m.url)}`));
        return 0;
      }
      throw new UsageError("Usage: feedbacks messages list|get|thread|post|reply …");
    }
    case "search": {
      const q = [sub, ...rest].filter(Boolean).join(" ");
      const r = await api.search({ q: need(q, "<query>"), types: flags.type, channel: flags.channel, project: flags.project, limit });
      print(r, () => {
        if (!r.data.length) out(c.dim("No results"));
        for (const x of r.data) {
          const head = x.ticket ? `${x.ticket.key} ${x.ticket.title}` : x.doc ? x.doc.title : x.channel ? `#${x.channel.name}` : x.kind;
          out(`${c.dim(x.kind.padEnd(7))} ${c.bold(trunc(head, 70))} ${c.dim(when(x.created_at))}`);
          if (x.snippet) out(`        ${trunc(x.snippet, 110)}`);
          out(`        ${c.dim(x.url)}`);
        }
      });
      return 0;
    }
    case "projects": {
      const r = await api.projects.list();
      print(r, () => table(r.data.map((p) => [c.bold(p.key), p.name, c.dim(p.role ?? ""), p.archived ? c.dim("archived") : ""])));
      return 0;
    }
    case "labels": {
      const r = await api.labels.list();
      print(r, () => table(r.data.map((l) => [l.name, c.dim(l.color)])));
      return 0;
    }
    case "users": {
      const r = await api.users.list();
      print(r, () => table(r.data.map((u) => [u.name, c.dim(u.email), c.dim(u.role), c.dim(u.id)])));
      return 0;
    }
    case "tickets": {
      if (sub === "list") {
        const q = {
          project: flags.project,
          status: flags.status,
          assignee: flags.assignee,
          label: flags.label?.[0],
          limit,
          cursor: flags.cursor,
        };
        let page = await api.tickets.list(q);
        const data = [...page.data];
        while (flags.all && page.next_cursor && data.length < 5000) {
          page = await api.tickets.list({ ...q, cursor: page.next_cursor });
          data.push(...page.data);
        }
        print({ data, next_cursor: flags.all ? null : page.next_cursor }, () => {
          if (!data.length) out(c.dim("No tickets"));
          table(data.map((t) => [c.bold(t.key), t.status, t.priority_name, trunc(t.title, 70), c.dim(t.assignee?.name ?? "")]));
          if (!flags.all && page.next_cursor) out(c.dim(`More: --cursor ${page.next_cursor} (or --all)`));
        });
        return 0;
      }
      if (sub === "get") {
        const t = await api.tickets.get(need(rest[0], "<ticket>"));
        print(t, () => printTicketDetail(t));
        return 0;
      }
      const description = flags["description-file"] !== undefined ? fileArg(flags["description-file"]) : flags.description;
      const priority = flags.priority !== undefined ? (/^\d$/.test(flags.priority) ? Number(flags.priority) : flags.priority) : undefined;
      if (sub === "create") {
        const t = await api.tickets.create({
          project: need(flags.project, "--project"),
          title: flags.title,
          description,
          status: flags.status as TicketDetail["status"] | undefined,
          priority: priority as never,
          assignee: flags.assignee,
          labels: flags.label,
          source_message_ids: flags["from-messages"]
            ?.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          force: flags.force,
        });
        print(t, () => out(`${c.green("✓")} Created ${c.bold(t.key)} ${t.title}\n  ${c.dim(t.url)}`));
        return 0;
      }
      if (sub === "update") {
        const t = await api.tickets.update(need(rest[0], "<ticket>"), {
          title: flags.title,
          description,
          status: flags.status as TicketDetail["status"] | undefined,
          priority: priority as never,
          assignee: flags.assignee === "none" ? null : flags.assignee,
          labels: flags.label,
          project: flags.project,
        });
        print(t, () => out(`${c.green("✓")} Updated ${c.bold(t.key)} [${t.status}] ${t.title}`));
        return 0;
      }
      if (sub === "comment") {
        const ref = need(rest[0], "<ticket>");
        const cm = await api.tickets.comment(ref, await resolveMentions(api, textArg(rest.slice(1), "comment text"), flags));
        print(cm, () => out(`${c.green("✓")} Commented on ${ref}`));
        return 0;
      }
      if (sub === "link") {
        const ref = need(rest[0], "<ticket>");
        const ids = rest.slice(1);
        if (!ids.length) throw new UsageError("Missing <messageId…>");
        const t = await api.tickets.link(ref, ids, !!flags.force);
        print(t, () => out(`${c.green("✓")} ${t.key} now has ${t.source_message_ids.length} source message(s)`));
        return 0;
      }
      if (sub === "unlink") {
        const t = await api.tickets.unlink(need(rest[0], "<ticket>"), need(rest[1], "<messageId>"));
        print(t, () => out(`${c.green("✓")} Unlinked from ${t.key}`));
        return 0;
      }
      throw new UsageError("Usage: feedbacks tickets list|get|create|update|comment|link|unlink …");
    }
    case "docs": {
      if (sub === "tree") {
        const r = await api.docs.tree();
        print(r, () => {
          const children = (parent: string | null, depth: number) => {
            for (const f of r.folders.filter((x) => x.parent_id === parent)) {
              out(`${"  ".repeat(depth)}${c.bold(`${f.name}/`)} ${c.dim(f.level)}`);
              children(f.id, depth + 1);
            }
            for (const d of r.docs.filter((x) => x.folder_id === parent))
              out(`${"  ".repeat(depth)}${d.title} ${c.dim(`${d.level} · v${d.version} · ${d.id}`)}`);
          };
          children(null, 0);
        });
        return 0;
      }
      if (sub === "get") {
        const d = await api.docs.get(need(rest[0], "<docId>"));
        if (flags.raw && !json) process.stdout.write(d.content);
        else
          print(d, () => {
            out(`${c.bold(d.title)} ${c.dim(`${[...d.path, ""].join(" / ")}v${d.version} · ${d.level} · ${d.url}`)}`);
            out();
            out(d.content);
          });
        return 0;
      }
      if (sub === "search") {
        const r = await api.docs.search(need(rest.join(" "), "<query>"), limit);
        print(r, () => {
          for (const d of r.data) out(`${c.bold(d.title)} ${c.dim(d.id)}\n  ${trunc(d.snippet, 110)}`);
        });
        return 0;
      }
      if (sub === "create") {
        const d = await api.docs.create({
          title: need(flags.title, "--title"),
          content: flags.file ? fileArg(flags.file) : "",
          folder_id: flags.folder ?? null,
        });
        print(d, () => out(`${c.green("✓")} Created ${d.title} ${c.dim(d.url)}`));
        return 0;
      }
      if (sub === "update") {
        const id = need(rest[0], "<docId>");
        const content = fileArg(need(flags.file, "--file"));
        const base = intFlag(flags["base-version"], "--base-version") ?? (flags.force ? undefined : (await api.docs.get(id)).version);
        const d = await api.docs.update(id, { title: flags.title, content, base_version: base, force: flags.force });
        print(d, () => out(`${c.green("✓")} Saved ${d.title} (v${d.version})`));
        return 0;
      }
      if (sub === "edit") {
        const id = need(rest[0], "<docId>");
        const doc = await api.docs.get(id);
        const dir = mkdtempSync(join(tmpdir(), "feedbacks-"));
        const file = join(dir, `${doc.title.replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 60) || "doc"}.md`);
        try {
          writeFileSync(file, doc.content);
          const editor = process.env.VISUAL || process.env.EDITOR || "vi";
          const r = spawnSync(editor, [file], { stdio: "inherit", shell: true });
          if (r.status !== 0) throw new Error(`${editor} exited with ${r.status}`);
          const content = readFileSync(file, "utf8");
          if (content === doc.content) {
            print({ changed: false }, () => out("No changes"));
            return 0;
          }
          const d = await api.docs.update(id, { content, base_version: doc.version });
          print(d, () => out(`${c.green("✓")} Saved ${d.title} (v${d.version})`));
          return 0;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      throw new UsageError("Usage: feedbacks docs tree|get|search|create|update|edit …");
    }
    case "notifications": {
      if (sub === "read") {
        const r = await api.notifications.read(flags.all ? { all: true } : { ids: rest });
        print(r, () => out(`${c.green("✓")} Marked as read`));
        return 0;
      }
      const r = await api.notifications.list({ filter: flags.all ? "all" : "unread", limit });
      print(r, () => {
        if (!r.data.length) out(c.dim("No notifications"));
        for (const n of r.data)
          out(
            `${n.read_at ? " " : c.cyan("●")} ${c.dim(when(n.created_at))} ${n.actor?.name ?? ""} ${c.dim(n.kind)} ${n.ticket?.key ?? ""} ${trunc(n.body, 80)} ${c.dim(n.id)}`,
          );
      });
      return 0;
    }
    case "api": {
      const method = need(sub, "<METHOD>").toUpperCase();
      const path = need(rest[0], "<path>");
      const body = flags.data !== undefined ? JSON.parse(flags.data === "-" ? readStdin() : flags.data) : undefined;
      const r = await api.request(method, path.startsWith("/") ? path : `/${path}`, body, flags["idempotency-key"]);
      out(JSON.stringify(r, null, 2));
      return 0;
    }
    default:
      throw new UsageError(`Unknown command: ${cmd} (see feedbacks --help)`);
  }
}

const EXIT: Record<string, number> = {
  unauthorized: 3,
  insufficient_scope: 3,
  forbidden: 3,
  not_found: 4,
  already_linked: 5,
  doc_conflict: 5,
  conflict: 5,
  idempotency_key_reused: 5,
  idempotency_in_progress: 5,
  rate_limited: 6,
  network_error: 7,
};

const argv = process.argv.slice(2);
const wantsJson = argv.includes("--json");
run(argv).then(
  (code) => process.exit(code),
  (e: unknown) => {
    let code = 1;
    let error: { code: string; message: string; details?: unknown };
    if (e instanceof FeedbacksApiError) {
      code = EXIT[e.code] ?? 1;
      error = { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) };
    } else if (e instanceof UsageError || (e instanceof TypeError && (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS"))) {
      code = 2;
      error = { code: "usage", message: (e as Error).message };
    } else {
      error = { code: "error", message: e instanceof Error ? e.message : String(e) };
    }
    if (wantsJson) out(JSON.stringify({ error }, null, 2));
    else {
      process.stderr.write(
        `${c.red("error")} ${error.message}${error.code !== "usage" && error.code !== "error" ? c.dim(` (${error.code})`) : ""}\n`,
      );
      if (error.code === "already_linked") process.stderr.write("  Retry with --force to link these messages to another ticket anyway.\n");
      if (error.code === "doc_conflict")
        process.stderr.write("  Someone saved in between: re-read the document, merge, and retry (or --force).\n");
    }
    process.exit(code);
  },
);
