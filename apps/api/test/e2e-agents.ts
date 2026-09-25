/**
 * End-to-end proof of the agent interfaces (M5) against the live stack started by scripts/e2e-sync.mjs,
 * after e2e-sync.ts (reuses its users: owner@, bob@, carol@ in Acme; eve@ in another organization).
 *   personal access tokens (scopes, revocation, expiry) → REST API v1 (same permissions as the app,
 *   idempotency, rate limit, messages → ticket with ALREADY_LINKED, doc conflicts) → CLI (--json, exit codes)
 *   → MCP (stdio and Streamable HTTP).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mentionToken } from "@feedbacks/schema/chat";
import { newId } from "@feedbacks/schema/ids";
import { mutators, schema } from "@feedbacks/schema/zero";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Zero } from "@rocicorp/zero";
import pg from "pg";

const API = `http://localhost:${process.env.API_PORT}`;
const ZERO = `http://localhost:${process.env.ZERO_PORT}`;
const ROOT = join(import.meta.dirname, "..", "..", "..");
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const step = (msg: string) => console.log(`✓ ${msg}`);
type Session = { token: string; cookie: string; userId: string };
// biome-ignore lint/suspicious/noExplicitAny: loose JSON in a test
type Json = any;

async function signIn(email: string): Promise<Session> {
  const res = await fetch(`${API}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: process.env.APP_URL ?? API },
    body: JSON.stringify({ email, password: "correct-horse-battery" }),
  });
  const json: Json = await res.json();
  assert.equal(res.status, 200, `sign-in ${email}: ${JSON.stringify(json)}`);
  return {
    token: res.headers.get("set-auth-token") ?? "",
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
    userId: json.user.id,
  };
}

const zeroFor = (s: Session) =>
  new Zero({ cacheURL: ZERO, userID: s.userId, auth: s.token, context: { userID: s.userId }, schema, mutators, kvStore: "mem" });
const ok = async (w: { server: Promise<{ type: string }> }, what: string) => {
  const r = await w.server;
  assert.equal(r.type, "success", `${what}: ${JSON.stringify(r)}`);
};

async function createToken(s: Session, organizationId: string, name: string, scope: "read" | "read-write") {
  const res = await fetch(`${API}/api/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: s.cookie },
    body: JSON.stringify({ organizationId, name, scope }),
  });
  const json: Json = await res.json();
  assert.equal(res.status, 201, JSON.stringify(json));
  assert.match(json.token, /^fbk_[A-Za-z0-9_-]{43}$/);
  return json as { id: string; token: string };
}

/** REST call; returns status, JSON and headers */
async function api(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, headers: res.headers };
}
const expect = async (p: ReturnType<typeof api>, status: number, what: string) => {
  const r = await p;
  assert.equal(r.status, status, `${what}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json as Json;
};

/* ------------------------------ Fixtures ------------------------------ */

const owner = await signIn("owner@example.com");
const bob = await signIn("bob@example.com");
const carol = await signIn("carol@example.com");
const eve = await signIn("eve@example.com");
const orgId: string = (await db.query("select id from organization where slug = 'acme'")).rows[0].id;
const otherOrgId: string = (await db.query("select organization_id from member where user_id = $1", [eve.userId])).rows[0].organization_id;
const zo = zeroFor(owner);
const zc = zeroFor(carol);
const now = () => Date.now();

// #support (public), #board-room (private, owner only), project SUP (org-visible) and VIP (members only)
const supportId = newId();
await ok(
  zo.mutate(mutators.channels.create({ id: supportId, organizationId: orgId, name: "support", kind: "public", createdAt: now() })),
  "create #support",
);
const boardId = newId();
await ok(
  zo.mutate(mutators.channels.create({ id: boardId, organizationId: orgId, name: "board-room", kind: "private", createdAt: now() })),
  "create #board-room",
);
await ok(
  zo.mutate(
    mutators.messages.send({ id: newId(), organizationId: orgId, channelId: boardId, body: "Quarterly figures", createdAt: now() }),
  ),
  "private message",
);
const supId = newId();
await ok(
  zo.mutate(
    mutators.projects.create({
      id: supId,
      organizationId: orgId,
      key: "SUP",
      name: "Support",
      color: "#4cb782",
      visibility: "org",
      createdAt: now(),
    }),
  ),
  "create SUP",
);
const vipId = newId();
await ok(
  zo.mutate(
    mutators.projects.create({
      id: vipId,
      organizationId: orgId,
      key: "VIP",
      name: "Board",
      color: "#eb5757",
      visibility: "members",
      createdAt: now(),
    }),
  ),
  "create VIP",
);
await ok(
  zo.mutate(
    mutators.tickets.create({
      id: newId(),
      organizationId: orgId,
      eventId: newId(),
      at: now(),
      projectId: vipId,
      title: "Confidential acquisition",
      status: "todo",
      priority: 0,
      assigneeId: null,
    }),
  ),
  "VIP ticket",
);
// Carol posts feedback (a text and its screenshot) in #support
const carolText = newId();
const carolShot = newId();
await ok(
  zc.mutate(
    mutators.messages.send({
      id: carolText,
      organizationId: orgId,
      channelId: supportId,
      body: "Checkout button does nothing on Safari",
      createdAt: now(),
    }),
  ),
  "carol feedback",
);
await ok(
  zc.mutate(
    mutators.messages.send({ id: carolShot, organizationId: orgId, channelId: supportId, body: "see the console error", createdAt: now() }),
  ),
  "carol precision",
);
// Restricted folder with a secret document (owner only)
const boardFolder = newId();
await ok(
  zo.mutate(
    mutators.folders.create({ id: boardFolder, organizationId: orgId, parentId: null, name: "Board minutes", sortOrder: 1e9, at: now() }),
  ),
  "board folder",
);
await ok(zo.mutate(mutators.access.setInherit({ organizationId: orgId, nodeId: boardFolder, inherit: false, at: now() })), "restrict");
await ok(zo.mutate(mutators.access.revoke({ organizationId: orgId, grantId: `${boardFolder}:org:org` })), "revoke org access");
const secretDoc = newId();
await ok(
  zo.mutate(
    mutators.docs.create({
      id: secretDoc,
      organizationId: orgId,
      folderId: boardFolder,
      title: "Acquisition memo",
      content: "Codename zeppelin",
      sortOrder: 1,
      versionId: newId(),
      at: now(),
    }),
  ),
  "secret doc",
);
step("fixtures: #support, private #board-room, projects SUP (org) and VIP (members only), restricted folder");

/* ------------------------------ Tokens ------------------------------ */

const ownerTok = await createToken(owner, orgId, "owner laptop", "read-write");
const bobRead = await createToken(bob, orgId, "bob read", "read");
const bobRw = await createToken(bob, orgId, "bob agent", "read-write");
const eveTok = await createToken(eve, otherOrgId, "eve", "read-write");
const stored = (await db.query("select token_hash, prefix from api_token where id = $1", [bobRw.id])).rows[0];
assert.notEqual(stored.token_hash, bobRw.token, "only the hash is stored");
assert.ok(bobRw.token.startsWith(stored.prefix));
const myTokens: Json = await (await fetch(`${API}/api/tokens?organizationId=${orgId}`, { headers: { cookie: bob.cookie } })).json();
assert.deepEqual(myTokens.tokens.map((t: { name: string }) => t.name).sort(), ["bob agent", "bob read"]);
assert.ok(!JSON.stringify(myTokens).includes(bobRw.token), "secrets are never listed");
assert.equal((await fetch(`${API}/api/tokens?organizationId=${orgId}&all=1`, { headers: { cookie: bob.cookie } })).status, 403);
const allTokens: Json = await (
  await fetch(`${API}/api/tokens?organizationId=${orgId}&all=1`, { headers: { cookie: owner.cookie } })
).json();
assert.ok(
  allTokens.tokens.some((t: { name: string }) => t.name === "bob agent"),
  "admins see the organization's tokens",
);
assert.equal((await fetch(`${API}/api/tokens?organizationId=${orgId}`, { headers: { cookie: eve.cookie } })).status, 403);

const me = await expect(api(bobRw.token, "GET", "/me"), 200, "me");
assert.deepEqual([me.user.id, me.organization.id, me.role, me.token.scope], [bob.userId, orgId, "member", "read-write"]);
await expect(api(null, "GET", "/me"), 401, "no token");
await expect(api("fbk_not-a-real-token-at-all-000000000000000000", "GET", "/me"), 401, "unknown token");
await expect(api(bob.token, "GET", "/me"), 401, "a session token is not an API token");
const scope = await expect(api(bobRead.token, "POST", "/channels/support/messages", { body: "hi" }), 403, "read token writes");
assert.equal(scope.error.code, "insufficient_scope");
await expect(api(bobRead.token, "GET", "/channels"), 200, "read token reads");
step("tokens: hashed, listed without secrets, admins see all; bearer auth; read scope can't write");

/* ------------------------------ Chat ------------------------------ */

const channels = await expect(api(bobRw.token, "GET", "/channels"), 200, "channels");
const names = channels.data.map((c: { name: string }) => c.name);
assert.ok(names.includes("support") && !names.includes("board-room"), "private channels stay hidden");
for (const path of ["/channels/board-room", `/channels/${boardId}/messages`])
  assert.equal((await expect(api(bobRw.token, "GET", path), 404, path)).error.code, "not_found");
await expect(api(bobRw.token, "POST", `/channels/${boardId}/messages`, { body: "let me in" }), 404, "post in private");

const posted = await expect(
  api(
    bobRw.token,
    "POST",
    "/channels/%23support/messages",
    { body: `${mentionToken(owner.userId)} I'll triage this` },
    { "x-feedbacks-client": "Claude Code" },
  ),
  201,
  "post",
);
assert.equal(posted.via, "Claude Code");
assert.equal(posted.text, "@Olivia Owner I'll triage this");
assert.equal((await db.query("select via, author_id from message where id = $1", [posted.id])).rows[0].via, "Claude Code");
assert.equal(
  (await db.query("select 1 from notification where user_id = $1 and message_id = $2 and kind = 'mention'", [owner.userId, posted.id]))
    .rowCount,
  1,
  "mentions notify as in the app",
);
const reply = await expect(api(bobRw.token, "POST", `/messages/${carolText}/replies`, { body: "Which Safari version?" }), 201, "reply");
assert.equal(reply.parent_id, carolText);
const thread = await expect(api(bobRw.token, "GET", `/messages/${carolText}/thread`), 200, "thread");
assert.equal(thread.replies.length, 1);

const unprocessed = await expect(api(bobRw.token, "GET", "/channels/support/messages?unprocessed=true&since=1h"), 200, "unprocessed");
const unprocessedIds = unprocessed.data.map((m: { id: string }) => m.id);
assert.ok(unprocessedIds.includes(carolText) && unprocessedIds.includes(carolShot), "carol's feedback is unprocessed");
assert.ok(!unprocessedIds.includes(posted.id), "own messages are not feedback to triage");
const page1 = await expect(api(bobRw.token, "GET", "/channels/support/messages?limit=1"), 200, "page 1");
assert.equal(page1.data.length, 1);
const page2 = await expect(api(bobRw.token, "GET", `/channels/support/messages?limit=1&cursor=${page1.next_cursor}`), 200, "page 2");
assert.notEqual(page2.data[0].id, page1.data[0].id, "cursor pagination");
step("chat: private channels invisible, posts marked via client, mentions notify, threads, unprocessed feed, cursors");

/* ------------------------------ Idempotency and rate limit ------------------------------ */

const key = { "idempotency-key": `e2e-${newId()}` };
const first = await api(bobRw.token, "POST", "/channels/support/messages", { body: "Retried post" }, key);
const again = await api(bobRw.token, "POST", "/channels/support/messages", { body: "Retried post" }, key);
assert.equal(first.status, 201);
assert.equal(again.status, 201);
assert.equal(again.json.id, first.json.id, "the stored response is replayed");
assert.equal(again.headers.get("idempotent-replayed"), "true");
assert.equal((await db.query("select count(*)::int as n from message where body = 'Retried post'")).rows[0].n, 1, "no duplicate");
assert.equal(
  (await api(bobRw.token, "POST", "/channels/support/messages", { body: "Other body" }, key)).json.error.code,
  "idempotency_key_reused",
);

const limiter = await createToken(carol, orgId, "burst", "read");
const limit = Number(process.env.API_RATE_LIMIT_PER_MIN ?? 300);
const burst = await Promise.all(Array.from({ length: limit + 5 }, () => api(limiter.token, "GET", "/me")));
const limited = burst.find((r) => r.status === 429);
assert.ok(limited, "the limit is enforced");
assert.equal(limited?.json.error.code, "rate_limited");
assert.ok(Number(limited?.headers.get("retry-after")) >= 1);
assert.equal((await api(bobRw.token, "GET", "/me")).status, 200, "limits are per token");
step("idempotency: replay without duplicates, key reuse refused; rate limit per token with Retry-After");

/* ------------------------------ Tickets ------------------------------ */

const denied = await expect(
  api(bobRw.token, "POST", "/tickets", { project: "SUP", source_message_ids: [carolText] }),
  403,
  "viewer creating a ticket",
);
assert.equal(denied.error.code, "forbidden");
await ok(
  zo.mutate(mutators.projects.setMember({ organizationId: orgId, projectId: supId, userId: bob.userId, role: "contributor", at: now() })),
  "bob contributor",
);
const created = await expect(
  api(
    bobRw.token,
    "POST",
    "/tickets",
    { project: "sup", source_message_ids: [carolText, carolShot], priority: "high", labels: [] },
    { "x-feedbacks-client": "Claude Code" },
  ),
  201,
  "create from messages",
);
assert.equal(created.key, "SUP-1");
assert.equal(created.created_via, "api");
assert.equal(created.status, "triage", "tickets from messages start in triage");
assert.equal(created.title, "Checkout button does nothing on Safari", "title from the first message");
assert.match(created.description, /\*\*Carol Member\*\* · \d\d:\d\d — Checkout button/);
assert.deepEqual(created.source_messages.map((m: { id: string }) => m.id).sort(), [carolText, carolShot].sort());
assert.equal(created.priority_name, "high");
assert.equal(
  (
    await db.query("select 1 from notification where user_id = $1 and ticket_id = $2 and kind = 'ticket_from_my_message'", [
      carol.userId,
      created.id,
    ])
  ).rowCount,
  1,
  "the reporter is told her message became a ticket",
);
const dup = await expect(
  api(bobRw.token, "POST", "/tickets", { project: "SUP", title: "Again", source_message_ids: [carolText] }),
  409,
  "already linked",
);
assert.equal(dup.error.code, "already_linked");
assert.deepEqual(dup.error.details.links, [{ messageId: carolText, ticketId: created.id }]);
const forced = await expect(
  api(bobRw.token, "POST", "/tickets", { project: "SUP", title: "Safari umbrella", source_message_ids: [carolText], force: true }),
  201,
  "force",
);
assert.equal(forced.key, "SUP-2");
const afterUnprocessed = await expect(api(bobRw.token, "GET", "/channels/support/messages?unprocessed=true"), 200, "unprocessed after");
assert.ok(!afterUnprocessed.data.some((m: { id: string }) => m.id === carolText), "processed feedback leaves the feed");

const byKey = await expect(api(bobRw.token, "GET", "/tickets/sup-1"), 200, "get by key");
assert.equal(byKey.id, created.id);
const listed = await expect(api(bobRw.token, "GET", "/tickets?project=SUP&status=open&created_via=api"), 200, "list");
assert.deepEqual(listed.data.map((t: { key: string }) => t.key).sort(), ["SUP-1", "SUP-2"]);
const updated = await expect(api(bobRw.token, "PATCH", "/tickets/SUP-1", { status: "in_progress", assignee: "me" }), 200, "update");
assert.deepEqual([updated.status, updated.assignee.id], ["in_progress", bob.userId]);
assert.equal(
  (await db.query("select 1 from activity where ticket_id = $1 and kind = 'status' and actor_id = $2", [created.id, bob.userId])).rowCount,
  1,
  "activities recorded",
);
const comment = await expect(
  api(bobRw.token, "POST", "/tickets/SUP-1/comments", { body: "Reproduced on Safari 17" }, { "x-feedbacks-client": "Claude Code" }),
  201,
  "comment",
);
assert.equal(comment.via, "Claude Code");
const precision = newId();
await ok(
  zc.mutate(
    mutators.messages.send({ id: precision, organizationId: orgId, channelId: supportId, body: "Only with Apple Pay", createdAt: now() }),
  ),
  "precision",
);
const linked = await expect(api(bobRw.token, "POST", "/tickets/SUP-1/links", { message_ids: [precision] }), 200, "link");
assert.equal(linked.source_message_ids.length, 3);
const unlinked = await expect(api(bobRw.token, "DELETE", `/tickets/SUP-1/links/${precision}`), 200, "unlink");
assert.equal(unlinked.source_message_ids.length, 2);

const vipKey = "VIP-1";
await expect(api(bobRw.token, "GET", `/tickets/${vipKey}`), 404, "members-only project");
await expect(api(bobRw.token, "POST", "/tickets", { project: "VIP", title: "sneaky" }), 404, "create in hidden project");
assert.ok(!(await expect(api(bobRw.token, "GET", "/tickets"), 200, "all tickets")).data.some((t: { key: string }) => t.key === vipKey));
assert.equal((await expect(api(ownerTok.token, "GET", `/tickets/${vipKey}`), 200, "owner reads VIP")).title, "Confidential acquisition");
step(
  "tickets: roles enforced, from messages (defaults, notification, created_via=api), ALREADY_LINKED then force, update, comment, link/unlink, hidden projects",
);

/* ------------------------------ Search and documents ------------------------------ */

const searched = await expect(api(bobRw.token, "GET", "/search?q=safari"), 200, "search");
assert.ok(searched.data.some((r: { kind: string; id: string }) => r.kind === "message" && r.id === carolText));
assert.equal(
  (await expect(api(bobRw.token, "GET", "/search?q=quarterly"), 200, "private search")).data.length,
  0,
  "private channel never searchable",
);
assert.equal(
  (await expect(api(bobRw.token, "GET", "/search?q=acquisition"), 200, "hidden search")).data.length,
  0,
  "hidden ticket and doc stay hidden",
);

const tree = await expect(api(bobRw.token, "GET", "/docs/tree"), 200, "tree");
assert.ok(!tree.folders.some((f: { id: string }) => f.id === boardFolder) && !tree.docs.some((d: { id: string }) => d.id === secretDoc));
await expect(api(bobRw.token, "GET", `/docs/${secretDoc}`), 404, "restricted doc");
assert.equal((await expect(api(bobRw.token, "GET", "/docs/search?q=zeppelin"), 200, "doc search")).data.length, 0);
assert.equal((await expect(api(ownerTok.token, "GET", `/docs/${secretDoc}`), 200, "owner reads")).content, "Codename zeppelin");
const doc = await expect(api(bobRw.token, "POST", "/docs", { title: "Triage guide", content: "# Triage\n\nStep one." }), 201, "create doc");
assert.deepEqual([doc.version, doc.level, doc.content], [1, "edit", "# Triage\n\nStep one."]);
const v2 = await expect(
  api(bobRw.token, "PATCH", `/docs/${doc.id}`, { content: "# Triage\n\nStep two.", base_version: 1 }),
  200,
  "save v2",
);
assert.equal(v2.version, 2);
const conflict = await expect(api(bobRw.token, "PATCH", `/docs/${doc.id}`, { content: "stale", base_version: 1 }), 409, "stale save");
assert.deepEqual([conflict.error.code, conflict.error.details.currentVersion], ["doc_conflict", 2]);
assert.equal((await expect(api(bobRw.token, "PATCH", `/docs/${doc.id}`, { content: "forced", force: true }), 200, "force")).version, 3);
await expect(api(bobRw.token, "PATCH", `/docs/${secretDoc}`, { content: "x", force: true }), 404, "write restricted doc");
step("search and documents: permissions applied (private channel, hidden project, restricted folder), versions, DOC_CONFLICT");

/* ------------------------------ Other organization, revocation, expiry ------------------------------ */

assert.ok(!(await expect(api(eveTok.token, "GET", "/channels"), 200, "eve channels")).data.some((c: { id: string }) => c.id === supportId));
for (const path of [`/messages/${carolText}`, "/tickets/SUP-1", `/docs/${doc.id}`])
  await expect(api(eveTok.token, "GET", path), 404, `eve ${path}`);
await expect(api(eveTok.token, "POST", `/channels/${supportId}/messages`, { body: "hi" }), 404, "eve posting into Acme");
assert.equal((await expect(api(eveTok.token, "GET", "/search?q=safari"), 200, "eve search")).data.length, 0);

assert.equal(
  (await fetch(`${API}/api/tokens/${bobRead.id}`, { method: "DELETE", headers: { cookie: carol.cookie } })).status,
  404,
  "others can't revoke",
);
assert.equal((await fetch(`${API}/api/tokens/${bobRead.id}`, { method: "DELETE", headers: { cookie: bob.cookie } })).status, 200);
await expect(api(bobRead.token, "GET", "/me"), 401, "revoked");
const shortLived = await createToken(bob, orgId, "short", "read");
await db.query("update api_token set expires_at = now() - interval '1 minute' where id = $1", [shortLived.id]);
await expect(api(shortLived.token, "GET", "/me"), 401, "expired");
const spec: Json = await (await fetch(`${API}/api/v1/openapi.json`)).json();
assert.equal(spec.openapi, "3.1.0");
assert.ok(
  spec.paths["/tickets/{ticket}"].patch &&
    spec.paths["/channels/{channel}/messages"].get.parameters.some((p: { name: string }) => p.name === "unprocessed"),
);
assert.equal((await fetch(`${API}/api/v1/reference`)).status, 200);
step("isolation: another organization sees nothing; revoked and expired tokens refused; OpenAPI 3.1 served");

/* ------------------------------ CLI ------------------------------ */

const cliJs = join(ROOT, "packages/cli/dist/feedbacks.js");
const mcpJs = join(ROOT, "packages/mcp/dist/stdio.js");
if (!existsSync(cliJs) || !existsSync(mcpJs)) {
  const b = spawnSync("pnpm", ["--filter", "@feedbacks/cli", "--filter", "@feedbacks/mcp", "build"], { cwd: ROOT, stdio: "inherit" });
  assert.equal(b.status, 0, "build CLI and MCP");
}
const home = mkdtempSync(join(tmpdir(), "feedbacks-cli-"));
const cli = (args: string[], input?: string) => {
  const r = spawnSync("node", [cliJs, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: home, FEEDBACKS_URL: "", FEEDBACKS_TOKEN: "", NO_COLOR: "1" },
    input,
    encoding: "utf8",
  });
  let json: Json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
};
try {
  assert.equal(cli(["whoami", "--json"]).code, 2, "not logged in = usage error");
  const login = cli(["login", "--url", API, "--token", bobRw.token, "--json"]);
  assert.equal(login.code, 0, login.stderr);
  const cfgFile = join(home, "feedbacks", "config.json");
  assert.equal(statSync(cfgFile).mode & 0o777, 0o600, "credentials file is private");
  assert.equal(JSON.parse(readFileSync(cfgFile, "utf8")).token, bobRw.token);
  assert.equal(cli(["whoami", "--json"]).json.user.id, bob.userId);

  const fresh1 = newId();
  const fresh2 = newId();
  await ok(
    zc.mutate(
      mutators.messages.send({ id: fresh1, organizationId: orgId, channelId: supportId, body: "Invoice PDF is blank", createdAt: now() }),
    ),
    "m1",
  );
  await ok(
    zc.mutate(
      mutators.messages.send({ id: fresh2, organizationId: orgId, channelId: supportId, body: "same in Firefox", createdAt: now() }),
    ),
    "m2",
  );
  const list = cli(["messages", "list", "#support", "--unprocessed", "--since", "1h", "--json"]);
  assert.equal(list.code, 0, list.stderr);
  assert.ok(list.json.data.some((m: { id: string }) => m.id === fresh1));
  const human = cli(["messages", "list", "support", "--unprocessed"]);
  assert.match(human.stdout, /Invoice PDF is blank/);

  const made = cli(["tickets", "create", "--project", "SUP", "--from-messages", `${fresh1},${fresh2}`, "--priority", "medium", "--json"]);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  assert.deepEqual([made.json.key, made.json.created_via, made.json.title], ["SUP-3", "api", "Invoice PDF is blank"]);
  const clash = cli(["tickets", "create", "--project", "SUP", "--title", "dup", "--from-messages", fresh1, "--json"]);
  assert.equal(clash.code, 5, "conflict exit code");
  assert.equal(clash.json.error.code, "already_linked");
  const clashHuman = cli(["tickets", "create", "--project", "SUP", "--title", "dup", "--from-messages", fresh1]);
  assert.match(clashHuman.stderr, /--force/);
  assert.equal(cli(["tickets", "get", "VIP-1", "--json"]).code, 4, "not found exit code");
  const replied = cli(["messages", "reply", fresh1, `Tracked in ${made.json.key} @olivia`, "--json"]);
  assert.equal(replied.code, 0, replied.stderr);
  assert.equal(replied.json.via, "feedbacks-cli");
  assert.equal(replied.json.body, `Tracked in SUP-3 ${mentionToken(owner.userId)}`, "@name mentions resolved");
  const docFile = join(home, "doc.md");
  writeFileSync(docFile, "# Guide\n\nFrom the CLI.");
  const upd = cli(["docs", "update", doc.id, "--file", docFile, "--json"]);
  assert.equal(upd.code, 0, upd.stderr);
  assert.equal(upd.json.version, 4);
  assert.equal(cli(["docs", "get", doc.id, "--raw"]).stdout, "# Guide\n\nFrom the CLI.");
  assert.equal(cli(["docs", "update", doc.id, "--file", docFile, "--base-version", "1", "--json"]).code, 5, "doc conflict exit code");
  assert.equal(cli(["tickets", "frobnicate"]).code, 2, "usage exit code");
  assert.equal(cli(["api", "GET", "/me"]).code, 0, "raw api");
  step("CLI: login (0600 config), --json output, unprocessed feed, tickets from messages, exit codes 2/4/5, mentions, docs");
} finally {
  rmSync(home, { recursive: true, force: true });
}

/* ------------------------------ MCP ------------------------------ */

const TOOLS = [
  "add_comment",
  "create_ticket_from_messages",
  "get_thread",
  "get_ticket",
  "link_messages_to_ticket",
  "list_channels",
  "list_projects",
  "list_tickets",
  "list_unprocessed_feedback",
  "post_message",
  "read_doc",
  "read_messages",
  "reply_in_thread",
  "search",
  "search_docs",
  "update_doc",
  "update_ticket",
];
const text = (r: Json) => (r.content?.[0]?.text ?? "") as string;

async function mcpSession(transport: StdioClientTransport | StreamableHTTPClientTransport, label: string) {
  const client = new Client({ name: "e2e-agent", version: "1.0.0" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS, `${label}: tools`);
  assert.equal(tools.find((t) => t.name === "read_messages")?.annotations?.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === "update_doc")?.annotations?.destructiveHint, true);
  const m1 = newId();
  await ok(
    zc.mutate(
      mutators.messages.send({ id: m1, organizationId: orgId, channelId: supportId, body: `Search is slow (${label})`, createdAt: now() }),
    ),
    label,
  );
  const feed: Json = await client.callTool({ name: "list_unprocessed_feedback", arguments: { channel: "support" } });
  assert.ok(!feed.isError, text(feed));
  assert.ok(JSON.parse(text(feed)).data.some((m: { id: string }) => m.id === m1));
  const read: Json = await client.callTool({ name: "read_messages", arguments: { channel: "#support", limit: 5 } });
  assert.ok(!read.isError && JSON.parse(text(read)).data.length > 0);
  const made: Json = await client.callTool({
    name: "create_ticket_from_messages",
    arguments: { project: "SUP", message_ids: [m1], title: `Slow search (${label})`, priority: "low" },
  });
  assert.ok(!made.isError, text(made));
  const ticket = JSON.parse(text(made));
  assert.equal(ticket.created_via, "mcp");
  const again: Json = await client.callTool({ name: "create_ticket_from_messages", arguments: { project: "SUP", message_ids: [m1] } });
  assert.equal(again.isError, true);
  assert.match(text(again), /^already_linked/);
  const answered: Json = await client.callTool({
    name: "reply_in_thread",
    arguments: { message_id: m1, body: `Tracked in ${ticket.key}` },
  });
  assert.equal(JSON.parse(text(answered)).via, "e2e-agent", "the MCP client's name marks the reply");
  const hidden: Json = await client.callTool({ name: "get_ticket", arguments: { ticket: "VIP-1" } });
  assert.equal(hidden.isError, true, "MCP never exceeds the token's user");
  await client.close();
  return ticket.key as string;
}

const stdioKey = await mcpSession(
  new StdioClientTransport({
    command: "node",
    args: [mcpJs],
    env: { ...(process.env as Record<string, string>), FEEDBACKS_URL: API, FEEDBACKS_TOKEN: bobRw.token, XDG_CONFIG_HOME: tmpdir() },
    stderr: "pipe",
  }),
  "stdio",
);
const httpKey = await mcpSession(
  // Stateless HTTP: the label comes from X-Feedbacks-Client (or the User-Agent)
  new StreamableHTTPClientTransport(new URL(`${API}/api/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bobRw.token}`, "x-feedbacks-client": "e2e-agent" } },
  }),
  "http",
);
assert.notEqual(stdioKey, httpKey);
const noAuth = await fetch(`${API}/api/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
assert.equal(noAuth.status, 401, "MCP over HTTP requires a token");
const readOnly = await createToken(bob, orgId, "mcp read", "read");
const roClient = new Client({ name: "e2e-ro", version: "1.0.0" });
await roClient.connect(
  new StreamableHTTPClientTransport(new URL(`${API}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${readOnly.token}` } } }),
);
const roWrite: Json = await roClient.callTool({ name: "post_message", arguments: { channel: "support", body: "nope" } });
assert.equal(roWrite.isError, true);
assert.match(text(roWrite), /^insufficient_scope/);
await roClient.close();
step(
  "MCP: stdio and Streamable HTTP, 17 tools with annotations, feedback → ticket (created_via=mcp), ALREADY_LINKED, via label, scopes, no leaks",
);

await Promise.all([zo.close(), zc.close()]);
await db.end();
console.log("\nAll agent checks passed.");
