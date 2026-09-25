/**
 * End-to-end proof of the sync chain against a live stack (see scripts/e2e-sync.mjs):
 *   setup (owner + org) → invitation → invitee joins → Zero mutator writes to Postgres
 *   → authorized query returns the row → a user of another organization sees nothing
 *   and cannot write into the first organization.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dmChannelId, mentionToken } from "@feedbacks/schema/chat";
import { newId } from "@feedbacks/schema/ids";
import { mutators, queries, schema } from "@feedbacks/schema/zero";
import { Zero } from "@rocicorp/zero";
import { strToU8, zipSync } from "fflate";
import pg from "pg";

const API = `http://localhost:${process.env.API_PORT}`;
const ZERO = `http://localhost:${process.env.ZERO_PORT}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

type Session = { token: string; cookie: string; userId: string };

async function authPost(path: string, body: unknown, s?: Session, extraHeaders: Record<string, string> = {}) {
  const res = await fetch(`${API}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: process.env.APP_URL ?? API,
      ...(s ? { cookie: s.cookie } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON in a test
  const json: any = await res.json().catch(() => null);
  return { res, json };
}

async function signUp(name: string, email: string, extraHeaders: Record<string, string> = {}): Promise<Session> {
  const { res, json } = await authPost("/sign-up/email", { name, email, password: "correct-horse-battery" }, undefined, extraHeaders);
  assert.equal(res.status, 200, `sign-up ${email}: ${res.status} ${JSON.stringify(json)}`);
  return {
    token: res.headers.get("set-auth-token") ?? "",
    cookie: res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
    userId: json.user.id,
  };
}

function zeroFor(s: Session) {
  return new Zero({ cacheURL: ZERO, userID: s.userId, auth: s.token, context: { userID: s.userId }, schema, mutators, kvStore: "mem" });
}

const step = (msg: string) => console.log(`✓ ${msg}`);

// 0. Fresh public instance: claiming it needs SETUP_TOKEN (set by scripts/e2e-sync.mjs)
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? "";
assert.ok(SETUP_TOKEN, "the e2e stack runs with SETUP_TOKEN");
const ownerBody = { name: "Olivia Owner", email: "owner@example.com", password: "correct-horse-battery" };
const noToken = await authPost("/sign-up/email", ownerBody);
assert.equal(noToken.res.status, 403, "first sign-up without the setup token is refused");
const badToken = await authPost("/sign-up/email", ownerBody, undefined, { "x-setup-token": "not-the-token" });
assert.equal(badToken.res.status, 403, "first sign-up with a wrong setup token is refused");
assert.equal((await db.query('select count(*)::int as n from "user"')).rows[0].n, 0, "no account was created");
step("setup token: fresh instance can't be claimed without it");

// 1. Fresh instance: first user creates the organization and becomes owner
const setupHeaders = { "x-setup-token": SETUP_TOKEN };
const owner = await signUp("Olivia Owner", "owner@example.com", setupHeaders);
const orgNoToken = await authPost("/organization/create", { name: "Acme", slug: "acme" }, owner);
assert.equal(orgNoToken.res.status, 403, "first organization without the setup token is refused");
const created = await authPost("/organization/create", { name: "Acme", slug: "acme" }, owner, setupHeaders);
assert.equal(created.res.status, 200, JSON.stringify(created.json));
const orgId: string = created.json.id;
const general = (await db.query("select id from channel where organization_id = $1 and name = 'general'", [orgId])).rows[0];
assert.ok(general, "#general channel created with the organization");
step("setup: owner + organization + #general");

// 2. Sign-up is now invitation-only
const intruder = await authPost("/sign-up/email", { name: "Mallory", email: "mallory@example.com", password: "correct-horse-battery" });
assert.equal(intruder.res.status, 403, "uninvited sign-up is refused");
const secondOrg = await authPost("/organization/create", { name: "Other", slug: "other" }, owner);
assert.notEqual(secondOrg.res.status, 200, "a second organization cannot be created");
step("invitation-only: uninvited sign-up → 403, no second organization");

// 3. Owner invites a member, who signs up and accepts
const invite = await authPost("/organization/invite-member", { email: "bob@example.com", role: "member", organizationId: orgId }, owner);
assert.equal(invite.res.status, 200, JSON.stringify(invite.json));
const bob = await signUp("Bob Member", "bob@example.com");
const accepted = await authPost("/organization/accept-invitation", { invitationId: invite.json.id }, bob);
assert.equal(accepted.res.status, 200, JSON.stringify(accepted.json));
step("invitation: bob joined as member");

// 4. A third user in ANOTHER organization (created directly: one org per instance through the API)
const otherOrgId = newId();
await db.query("insert into organization (id, name, slug, created_at) values ($1, 'Other Co', 'other-co', now())", [otherOrgId]);
const invId = newId();
await db.query(
  "insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id) values ($1, $2, 'eve@example.com', 'member', 'pending', now() + interval '1 day', $3)",
  [invId, otherOrgId, owner.userId],
);
const eve = await signUp("Eve Outsider", "eve@example.com");
const eveAccept = await authPost("/organization/accept-invitation", { invitationId: invId }, eve);
assert.equal(eveAccept.res.status, 200, JSON.stringify(eveAccept.json));
step("eve is a member of another organization only");

// 5. Bob sends a message through a Zero mutator → row in Postgres
const zb = zeroFor(bob);
const msgId = newId();
const write = zb.mutate(
  mutators.messages.send({ id: msgId, organizationId: orgId, channelId: general.id, body: "Hello from Zero", createdAt: Date.now() }),
);
const serverRes = await write.server;
assert.equal(serverRes.type, "success", `server mutation: ${JSON.stringify(serverRes)}`);
const row = (await db.query("select author_id, body from message where id = $1", [msgId])).rows[0];
assert.deepEqual(row, { author_id: bob.userId, body: "Hello from Zero" });
step("mutator: message written to Postgres with the server-side author");

// 6. An authorized query (owner) returns it through zero-cache
const zo = zeroFor(owner);
const ownerView = await zo.run(queries.messages.byChannel({ organizationId: orgId, channelId: general.id, limit: 50 }), {
  type: "complete",
});
assert.ok(
  ownerView.some((m) => m.id === msgId && m.body === "Hello from Zero"),
  "owner sees bob's message",
);
step("query: owner receives the message via zero-cache");

// 7. Eve (other org) sees nothing and cannot write into Acme
const ze = zeroFor(eve);
const eveChannels = await ze.run(queries.channels.list({ organizationId: orgId }), { type: "complete" });
const eveMessages = await ze.run(queries.messages.byChannel({ organizationId: orgId, channelId: general.id, limit: 50 }), {
  type: "complete",
});
assert.equal(eveChannels.length, 0, "eve sees no channel of Acme");
assert.equal(eveMessages.length, 0, "eve sees no message of Acme");
const evilId = newId();
const evil = await ze.mutate(
  mutators.messages.send({ id: evilId, organizationId: orgId, channelId: general.id, body: "sneaky", createdAt: Date.now() }),
).server;
assert.notEqual(evil.type, "success", "eve's write is rejected by the server");
assert.equal((await db.query("select 1 from message where id = $1", [evilId])).rowCount, 0);
step("isolation: other organization sees nothing and cannot write");

/* ------------------------------------------------------------------ */
/* M1 — chat permissions, mentions, unread counters, attachments        */
/* ------------------------------------------------------------------ */

const ok = async (w: { server: Promise<{ type: string }> }, what: string) => {
  const r = await w.server;
  assert.equal(r.type, "success", `${what}: ${JSON.stringify(r)}`);
};
const rejected = async (w: { server: Promise<{ type: string }> }, what: string) => {
  const r = await w.server;
  assert.notEqual(r.type, "success", `${what} should be rejected`);
};
type UploadedFile = Parameters<typeof mutators.messages.send>[0] extends { attachments?: (infer A)[] } ? A : never;
const bearer = (x: Session) => ({ authorization: `Bearer ${x.token}` });

// 8. Accepting the invitation joined #general
const bobGeneral = await db.query("select last_read_seq from channel_member where channel_id = $1 and user_id = $2", [
  general.id,
  bob.userId,
]);
assert.equal(bobGeneral.rowCount, 1, "bob auto-joined #general");
step("invitation: new member joined #general");

// 9. Carol, another member of Acme (for DM privacy)
const inviteCarol = await authPost(
  "/organization/invite-member",
  { email: "carol@example.com", role: "member", organizationId: orgId },
  owner,
);
const carol = await signUp("Carol Member", "carol@example.com");
assert.equal((await authPost("/organization/accept-invitation", { invitationId: inviteCarol.json.id }, carol)).res.status, 200);
const zc = zeroFor(carol);

// 10. Private channel: invisible and unwritable for non-members
const privId = newId();
await ok(
  zo.mutate(mutators.channels.create({ id: privId, organizationId: orgId, name: "Leadership", kind: "private", createdAt: Date.now() })),
  "create private",
);
await ok(
  zo.mutate(mutators.messages.send({ id: newId(), organizationId: orgId, channelId: privId, body: "Budget talk", createdAt: Date.now() })),
  "owner posts in private",
);
assert.equal(
  await zb.run(queries.channels.get({ organizationId: orgId, channelId: privId }), { type: "complete" }),
  undefined,
  "bob can't see the private channel",
);
assert.equal(
  (await zb.run(queries.messages.byChannel({ organizationId: orgId, channelId: privId, limit: 50 }), { type: "complete" })).length,
  0,
);
await rejected(
  zb.mutate(mutators.messages.send({ id: newId(), organizationId: orgId, channelId: privId, body: "let me in", createdAt: Date.now() })),
  "bob posting in private",
);
await rejected(zb.mutate(mutators.channels.join({ organizationId: orgId, channelId: privId, at: Date.now() })), "bob joining private");
step("private channel: non-members can neither read, write nor join");

// 11. Direct messages: only their members
await ok(zo.mutate(mutators.channels.openDm({ organizationId: orgId, userIds: [bob.userId], at: Date.now() })), "open DM");
const dmId = dmChannelId(orgId, [owner.userId, bob.userId]);
await ok(
  zo.mutate(mutators.messages.send({ id: newId(), organizationId: orgId, channelId: dmId, body: "Hi Bob", createdAt: Date.now() })),
  "DM message",
);
await ok(zo.mutate(mutators.channels.openDm({ organizationId: orgId, userIds: [bob.userId], at: Date.now() })), "re-open DM is a no-op");
assert.equal((await db.query("select 1 from channel where id = $1", [dmId])).rowCount, 1);
assert.equal(
  (await zc.run(queries.messages.byChannel({ organizationId: orgId, channelId: dmId, limit: 50 }), { type: "complete" })).length,
  0,
  "carol can't read the DM",
);
await rejected(
  zc.mutate(mutators.messages.send({ id: newId(), organizationId: orgId, channelId: dmId, body: "hey", createdAt: Date.now() })),
  "carol writing in DM",
);
step("direct messages: private to their members, idempotent opening");

// 12. Editing / deleting someone else's message is refused
const ownerMsg = newId();
await ok(
  zo.mutate(
    mutators.messages.send({
      id: ownerMsg,
      organizationId: orgId,
      channelId: general.id,
      body: "Release notes are out",
      createdAt: Date.now(),
    }),
  ),
  "owner message",
);
await rejected(
  zb.mutate(mutators.messages.edit({ organizationId: orgId, id: ownerMsg, body: "hacked", at: Date.now() })),
  "bob editing owner's message",
);
await rejected(
  zb.mutate(mutators.messages.delete({ organizationId: orgId, id: ownerMsg, at: Date.now() })),
  "bob deleting owner's message",
);
assert.deepEqual((await db.query("select body, deleted_at from message where id = $1", [ownerMsg])).rows[0], {
  body: "Release notes are out",
  deleted_at: null,
});
await ok(
  zo.mutate(mutators.messages.edit({ organizationId: orgId, id: ownerMsg, body: "Release notes are out (v2)", at: Date.now() })),
  "owner edits own",
);
assert.notEqual((await db.query("select edited_at from message where id = $1", [ownerMsg])).rows[0].edited_at, null);
step("messages: only the author edits; deleting others' messages needs admin rights");

// 13. Mentions create notifications (only for people who can read the channel)
const mentionMsg = newId();
await ok(
  zo.mutate(
    mutators.messages.send({
      id: mentionMsg,
      organizationId: orgId,
      channelId: general.id,
      body: `${mentionToken(bob.userId)} can you check?`,
      createdAt: Date.now(),
    }),
  ),
  "mention",
);
const notif = await db.query("select kind, actor_id, channel_id from notification where user_id = $1 and message_id = $2", [
  bob.userId,
  mentionMsg,
]);
assert.deepEqual(notif.rows[0], { kind: "mention", actor_id: owner.userId, channel_id: general.id });
await ok(
  zo.mutate(
    mutators.messages.send({
      id: newId(),
      organizationId: orgId,
      channelId: privId,
      body: `${mentionToken(bob.userId)} secret`,
      createdAt: Date.now(),
    }),
  ),
  "mention in private",
);
assert.equal(
  (await db.query("select 1 from notification where user_id = $1 and channel_id = $2", [bob.userId, privId])).rowCount,
  0,
  "no notification leaks a private channel",
);
step("mentions: notification for the mentioned member, none for channels they can't read");

// 14. Unread counters: channel.last_seq - channel_member.last_read_seq
const unread = async () =>
  Number(
    (
      await db.query(
        "select c.last_seq - m.last_read_seq as n from channel c join channel_member m on m.channel_id = c.id where c.id = $1 and m.user_id = $2",
        [general.id, bob.userId],
      )
    ).rows[0].n,
  );
assert.ok((await unread()) >= 2, "bob has unread messages in #general");
const lastSeq = Number((await db.query("select last_seq from channel where id = $1", [general.id])).rows[0].last_seq);
await ok(zb.mutate(mutators.channels.markRead({ channelId: general.id, seq: lastSeq, at: Date.now() })), "mark read");
assert.equal(await unread(), 0, "read up to the last message");
await ok(
  zo.mutate(mutators.messages.send({ id: newId(), organizationId: orgId, channelId: general.id, body: "one more", createdAt: Date.now() })),
  "new msg",
);
assert.equal(await unread(), 1, "one new message");
await ok(
  zb.mutate(
    mutators.messages.send({ id: newId(), organizationId: orgId, channelId: general.id, body: "caught up", createdAt: Date.now() }),
  ),
  "bob replies",
);
assert.equal(await unread(), 0, "sending marks the channel as read");
step("unread: O(1) counters move with new messages, reads and own posts");

// 15. Threads and reactions
await ok(
  zb.mutate(
    mutators.messages.send({
      id: newId(),
      organizationId: orgId,
      channelId: general.id,
      parentId: ownerMsg,
      body: "Nice!",
      createdAt: Date.now(),
    }),
  ),
  "reply",
);
assert.equal(Number((await db.query("select reply_count from message where id = $1", [ownerMsg])).rows[0].reply_count), 1);
await ok(zb.mutate(mutators.reactions.toggle({ organizationId: orgId, messageId: ownerMsg, emoji: "🎉", at: Date.now() })), "react");
assert.equal((await db.query("select 1 from reaction where message_id = $1 and user_id = $2", [ownerMsg, bob.userId])).rowCount, 1);
await ok(zb.mutate(mutators.reactions.toggle({ organizationId: orgId, messageId: ownerMsg, emoji: "🎉", at: Date.now() })), "unreact");
assert.equal((await db.query("select 1 from reaction where message_id = $1 and user_id = $2", [ownerMsg, bob.userId])).rowCount, 0);
await rejected(
  ze.mutate(mutators.reactions.toggle({ organizationId: orgId, messageId: ownerMsg, emoji: "👎", at: Date.now() })),
  "eve reacting",
);
step("threads and reactions: reply counter, toggle, outsiders refused");

// 16. Attachments: upload, pending visibility, attach, authorized download
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const upload = async (who: Session, channel: string) => {
  const form = new FormData();
  form.set("file", new File([PNG], "pixel.png", { type: "image/png" }));
  form.set("organizationId", orgId);
  form.set("channelId", channel);
  form.set("width", "1");
  form.set("height", "1");
  return fetch(`${API}/api/uploads`, { method: "POST", headers: bearer(who), body: form });
};
const up = await upload(owner, general.id);
assert.equal(up.status, 200, await up.clone().text());
const att = (await up.json()) as UploadedFile;
const file = (who: Session) => fetch(`${API}/api/files/${att.id}`, { headers: bearer(who) });
assert.equal((await file(owner)).status, 200, "uploader reads a pending file");
assert.equal((await file(bob)).status, 404, "others can't read a pending file");
const fileMsg = newId();
await ok(
  zo.mutate(
    mutators.messages.send({
      id: fileMsg,
      organizationId: orgId,
      channelId: general.id,
      body: "",
      attachments: [att],
      createdAt: Date.now(),
    }),
  ),
  "message with file",
);
const bobFile = await file(bob);
assert.equal(bobFile.status, 200, "channel reader downloads the file");
assert.deepEqual(Buffer.from(await bobFile.arrayBuffer()), PNG);
assert.equal(bobFile.headers.get("x-content-type-options"), "nosniff");
assert.equal((await file(eve)).status, 404, "other organization can't download");
assert.equal((await upload(bob, privId)).status, 403, "no upload into a channel you can't post in");
const stolen = (await (await upload(bob, general.id)).json()) as UploadedFile;
await rejected(
  zc.mutate(
    mutators.messages.send({
      id: newId(),
      organizationId: orgId,
      channelId: general.id,
      body: "mine now",
      attachments: [stolen],
      createdAt: Date.now(),
    }),
  ),
  "attaching someone else's upload",
);
step("attachments: upload, pending privacy, authorized download, no cross-user attach");

/* ------------------------------------------------------------------ */
/* Upload lifecycle: deleted = really deleted, pending uploads expire   */
/* ------------------------------------------------------------------ */

const uploadsDir = join(process.env.DATA_DIR ?? "", "uploads");
const onDisk = (key: string) => existsSync(join(uploadsDir, key));
const waitUntil = async (cond: () => boolean | Promise<boolean>, what: string, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timeout: ${what}`);
};
const sweep = (...args: string[]) => {
  const r = spawnSync("pnpm", ["--silent", "uploads:sweep", ...args], { env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0, `uploads:sweep ${args.join(" ")}: ${r.stdout}${r.stderr}`);
  return r.stdout;
};

// 17. Deleting a message deletes its files (row, storage object, download)
assert.ok(onDisk(att.storageKey), "the attached file is on disk");
await ok(zo.mutate(mutators.messages.delete({ organizationId: orgId, id: fileMsg, at: Date.now() })), "delete message with file");
assert.equal((await db.query("select 1 from attachment where id = $1", [att.id])).rowCount, 0, "attachment row removed");
assert.equal((await file(owner)).status, 404, "download is gone");
await waitUntil(() => !onDisk(att.storageKey), "file removed from storage");
await waitUntil(
  async () => (await db.query("select 1 from storage_deletion where key = $1", [att.storageKey])).rowCount === 0,
  "deletion queue drained",
);
step("deletion: removing a message deletes its files from storage (download → 404)");

// 18. Sweeper: expired pending uploads go, recent ones stay; dry run changes nothing
await db.query("update attachment set created_at = now() - interval '48 hours' where id = $1", [stolen.id]);
const recent = (await (await upload(owner, general.id)).json()) as UploadedFile;
assert.ok(onDisk(stolen.storageKey) && onDisk(recent.storageKey), "both pending files on disk");
const dry = sweep("--dry-run");
assert.match(dry, /dry run: 1 pending upload/, dry);
assert.equal(
  (await db.query("select 1 from attachment where id = any($1)", [[stolen.id, recent.id]])).rowCount,
  2,
  "dry run deletes no row",
);
assert.ok(onDisk(stolen.storageKey) && onDisk(recent.storageKey), "dry run deletes no file");
sweep();
assert.equal((await db.query("select 1 from attachment where id = $1", [stolen.id])).rowCount, 0, "expired pending upload removed");
assert.ok(!onDisk(stolen.storageKey), "expired pending file deleted");
assert.equal((await db.query("select 1 from attachment where id = $1", [recent.id])).rowCount, 1, "recent pending upload kept");
assert.ok(onDisk(recent.storageKey), "recent pending file kept");
step("sweeper: expired pending uploads deleted, recent ones kept, dry run changes nothing");

/* ------------------------------------------------------------------ */
/* M2 — projects, roles, numbering, messages → tickets, comments       */
/* ------------------------------------------------------------------ */

const errorOf = async (w: { server: Promise<unknown> }) =>
  (await w.server) as {
    type: string;
    error?: { message?: string; details?: { code?: string; links?: { messageId: string; ticketId: string }[] } };
  };
const ev = () => ({ eventId: newId(), at: Date.now() });

// Dave: organization member who will only be a project viewer
const inviteDave = await authPost(
  "/organization/invite-member",
  { email: "dave@example.com", role: "member", organizationId: orgId },
  owner,
);
const dave = await signUp("Dave Viewer", "dave@example.com");
assert.equal((await authPost("/organization/accept-invitation", { invitationId: inviteDave.json.id }, dave)).res.status, 200);
const zd = zeroFor(dave);

// 19. Projects: only admins create; roles decide who writes
const appId = newId();
await rejected(
  zb.mutate(
    mutators.projects.create({
      id: newId(),
      organizationId: orgId,
      key: "NOPE",
      name: "Nope",
      color: "#5e6ad2",
      visibility: "org",
      createdAt: Date.now(),
    }),
  ),
  "member creating a project",
);
await ok(
  zo.mutate(
    mutators.projects.create({
      id: appId,
      organizationId: orgId,
      key: "app",
      name: "App",
      color: "#26b5ce",
      visibility: "org",
      members: [
        { userId: bob.userId, role: "contributor" },
        { userId: carol.userId, role: "reporter" },
        { userId: dave.userId, role: "viewer" },
      ],
      createdAt: Date.now(),
    }),
  ),
  "owner creates APP",
);
assert.equal((await db.query("select key from project where id = $1", [appId])).rows[0].key, "APP", "key normalized");
const secId = newId();
await ok(
  zo.mutate(
    mutators.projects.create({
      id: secId,
      organizationId: orgId,
      key: "SEC",
      name: "Security",
      color: "#eb5757",
      visibility: "members",
      createdAt: Date.now(),
    }),
  ),
  "private project",
);
const newTicket = (projectId: string, title: string, extra: Partial<Parameters<typeof mutators.tickets.create>[0]> = {}) =>
  mutators.tickets.create({
    id: newId(),
    ...ev(),
    organizationId: orgId,
    projectId,
    title,
    description: "",
    status: "todo",
    priority: 0,
    assigneeId: null,
    labelIds: [],
    sourceMessageIds: [],
    force: false,
    ...extra,
  });
const firstTicket = newTicket(appId, "First ticket");
await ok(zb.mutate(firstTicket), "contributor creates");
const firstId = firstTicket.args.id;
assert.equal((await db.query("select number, creator_id, created_via from ticket where id = $1", [firstId])).rows[0].number, 1);
await rejected(zc.mutate(newTicket(appId, "reporter tries")), "reporter creating");
await rejected(
  zc.mutate(mutators.tickets.update({ ...ev(), organizationId: orgId, ticketId: firstId, status: "done" })),
  "reporter editing",
);
await rejected(zd.mutate(newTicket(appId, "viewer tries")), "viewer creating");
await rejected(
  zd.mutate(mutators.comments.create({ id: newId(), organizationId: orgId, ticketId: firstId, body: "hi", createdAt: Date.now() })),
  "viewer commenting",
);
await ok(
  zc.mutate(
    mutators.comments.create({ id: newId(), organizationId: orgId, ticketId: firstId, body: "Reporter comment", createdAt: Date.now() }),
  ),
  "reporter comments",
);
assert.ok(await zd.run(queries.tickets.get({ organizationId: orgId, ticketId: firstId }), { type: "complete" }), "viewer reads the ticket");
assert.equal(
  await zb.run(queries.projects.byKey({ organizationId: orgId, key: "SEC" }), { type: "complete" }),
  undefined,
  "private project invisible",
);
await rejected(zb.mutate(newTicket(secId, "not a member")), "creating in a private project");
assert.equal((await ze.run(queries.projects.list({ organizationId: orgId }), { type: "complete" })).length, 0, "other org sees no project");
assert.equal(
  await ze.run(queries.tickets.get({ organizationId: orgId, ticketId: firstId }), { type: "complete" }),
  undefined,
  "other org sees no ticket",
);
await rejected(
  ze.mutate(mutators.comments.create({ id: newId(), organizationId: orgId, ticketId: firstId, body: "x", createdAt: Date.now() })),
  "other org commenting",
);
step("projects: admins create; contributor writes, reporter comments, viewer reads, private project hidden, other org nothing");

// 20. Numbering under concurrency: unique and contiguous
const burst = Array.from({ length: 12 }, (_, i) => (i % 2 ? zo : zb).mutate(newTicket(appId, `Burst ${i}`)));
for (const w of burst) await ok(w, "burst create");
const numbers = (await db.query("select number from ticket where project_id = $1 order by number", [appId])).rows.map((r) =>
  Number(r.number),
);
assert.deepEqual(
  numbers,
  Array.from({ length: 13 }, (_, i) => i + 1),
  "1..13 without gaps or duplicates",
);
assert.equal(Number((await db.query("select ticket_counter from project where id = $1", [appId])).rows[0].ticket_counter), 13);
step("numbering: 12 concurrent creations → unique, contiguous numbers");

// 21. Messages → ticket: sources, chips, notifications, idempotence, force, link, unprocessed
const carolMsg = newId();
const carolShot = newId();
await ok(
  zc.mutate(
    mutators.messages.send({
      id: carolMsg,
      organizationId: orgId,
      channelId: general.id,
      body: "Checkout button does nothing on iOS",
      createdAt: Date.now(),
    }),
  ),
  "carol reports",
);
await ok(
  zc.mutate(
    mutators.messages.send({
      id: carolShot,
      organizationId: orgId,
      channelId: general.id,
      body: "Screenshot attached above",
      createdAt: Date.now(),
    }),
  ),
  "carol follow-up",
);
const fromMsgs = newTicket(appId, "Checkout button does nothing on iOS", {
  status: "triage",
  sourceMessageIds: [carolMsg],
  assigneeId: bob.userId,
});
await ok(zo.mutate(fromMsgs), "ticket from messages");
const fromId = fromMsgs.args.id;
assert.equal((await db.query("select 1 from ticket_source where ticket_id = $1 and message_id = $2", [fromId, carolMsg])).rowCount, 1);
const carolNotif = await db.query("select kind from notification where user_id = $1 and ticket_id = $2", [carol.userId, fromId]);
assert.deepEqual(
  carolNotif.rows.map((r) => r.kind),
  ["ticket_from_my_message"],
  "the author is told",
);
assert.equal(
  (await db.query("select kind from notification where user_id = $1 and ticket_id = $2", [bob.userId, fromId])).rows[0]?.kind,
  "ticket_assigned",
);
const bobChannel = await zb.run(queries.messages.byChannel({ organizationId: orgId, channelId: general.id, limit: 200 }), {
  type: "complete",
});
const chip = bobChannel.find((m) => m.id === carolMsg)?.ticketSources[0]?.ticket;
assert.equal(chip?.id, fromId, "chip: the linked ticket comes with the message");
assert.equal(chip?.project?.key, "APP");
const again = await errorOf(zb.mutate(newTicket(appId, "Duplicate", { sourceMessageIds: [carolMsg] })));
assert.equal(again.type, "error");
assert.equal(again.error?.details?.code, "ALREADY_LINKED", JSON.stringify(again));
assert.deepEqual(again.error?.details?.links, [{ messageId: carolMsg, ticketId: fromId }]);
await ok(zb.mutate(newTicket(appId, "On purpose", { sourceMessageIds: [carolMsg], force: true })), "force");
await ok(
  zb.mutate(mutators.tickets.linkMessages({ ...ev(), organizationId: orgId, ticketId: fromId, messageIds: [carolShot], force: false })),
  "link a later message",
);
assert.equal((await db.query("select count(*)::int as n from ticket_source where ticket_id = $1", [fromId])).rows[0].n, 2);
const loneMsg = newId();
await ok(
  zc.mutate(
    mutators.messages.send({ id: loneMsg, organizationId: orgId, channelId: general.id, body: "Dark mode please", createdAt: Date.now() }),
  ),
  "unrelated",
);
const unprocessed = await zo.run(queries.messages.unprocessed({ organizationId: orgId, channelId: general.id }), { type: "complete" });
assert.ok(
  unprocessed.some((m) => m.id === loneMsg),
  "unlinked message is unprocessed",
);
assert.ok(!unprocessed.some((m) => m.id === carolMsg || m.id === carolShot), "linked messages are processed");
assert.ok(!unprocessed.some((m) => m.authorId === owner.userId), "own messages are not listed");
// Source authors can follow a ticket of a project they can't otherwise read
const bobMsg = newId();
await ok(
  zb.mutate(
    mutators.messages.send({
      id: bobMsg,
      organizationId: orgId,
      channelId: general.id,
      body: "Found a leaked token in logs",
      createdAt: Date.now(),
    }),
  ),
  "bob reports",
);
const secTicket = newTicket(secId, "Leaked token", { sourceMessageIds: [bobMsg] });
await ok(zo.mutate(secTicket), "owner files it in SEC");
await ok(zo.mutate(newTicket(secId, "Unrelated secret")), "other SEC ticket");
assert.ok(
  await zb.run(queries.tickets.get({ organizationId: orgId, ticketId: secTicket.args.id }), { type: "complete" }),
  "bob follows his report",
);
const bobReported = await zb.run(queries.tickets.mine({ organizationId: orgId, filter: "reported" }), { type: "complete" });
assert.ok(
  bobReported.some((t) => t.id === secTicket.args.id),
  "listed in 'my reports'",
);
assert.ok(!bobReported.some((t) => t.title === "Unrelated secret"));
step("messages → ticket: sources, chip, author notified, ALREADY_LINKED then force, later link, unprocessed tab, authors follow");

// 22. Activities and status notifications
await ok(
  zb.mutate(mutators.tickets.update({ ...ev(), organizationId: orgId, ticketId: fromId, status: "in_progress", priority: 2 })),
  "status",
);
const kinds = (await db.query("select kind from activity where ticket_id = $1 order by created_at, kind", [fromId])).rows.map(
  (r) => r.kind,
);
for (const k of ["created", "linked_messages", "status", "priority"]) assert.ok(kinds.includes(k), `activity ${k}`);
assert.ok(
  (await db.query("select 1 from notification where user_id = $1 and ticket_id = $2 and kind = 'ticket_status'", [carol.userId, fromId]))
    .rowCount,
  "source author told about the status change",
);
assert.equal(
  (await db.query("select 1 from notification where user_id = $1 and ticket_id = $2 and kind = 'ticket_status'", [bob.userId, fromId]))
    .rowCount,
  0,
  "the actor is not notified",
);
assert.notEqual((await db.query("select completed_at from ticket where id = $1", [firstId])).rows[0].completed_at, undefined);
await ok(zb.mutate(mutators.tickets.update({ ...ev(), organizationId: orgId, ticketId: firstId, status: "done" })), "close");
assert.notEqual((await db.query("select completed_at from ticket where id = $1", [firstId])).rows[0].completed_at, null, "completedAt set");
const labelId = newId();
await ok(
  zb.mutate(mutators.labels.create({ id: labelId, organizationId: orgId, name: "Bug", color: "#eb5757", createdAt: Date.now() })),
  "contributor creates a label",
);
await rejected(
  zc.mutate(mutators.labels.create({ id: newId(), organizationId: orgId, name: "Nope", color: "#eb5757", createdAt: Date.now() })),
  "reporter creating a label",
);
await ok(zb.mutate(mutators.tickets.setLabels({ ...ev(), organizationId: orgId, ticketId: fromId, labelIds: [labelId] })), "label");
assert.equal((await db.query("select 1 from ticket_label where ticket_id = $1 and label_id = $2", [fromId, labelId])).rowCount, 1);
step("activities: created, linked, status, priority, labels; status notifies creator/assignee/authors, not the actor");

// 23. Comments with mentions
const commentId = newId();
await ok(
  zc.mutate(
    mutators.comments.create({
      id: commentId,
      organizationId: orgId,
      ticketId: fromId,
      body: `${mentionToken(bob.userId)} still broken on 17.5`,
      createdAt: Date.now(),
    }),
  ),
  "comment with mention",
);
assert.equal(
  (await db.query("select kind from notification where user_id = $1 and ticket_id = $2 and kind = 'mention'", [bob.userId, fromId]))
    .rowCount,
  1,
);
await ok(zb.mutate(mutators.comments.react({ organizationId: orgId, commentId, emoji: "👍", at: Date.now() })), "react to comment");
await rejected(
  zb.mutate(mutators.comments.edit({ organizationId: orgId, id: commentId, body: "hacked", at: Date.now() })),
  "editing someone else's comment",
);
step("comments: mention notifies, reactions, only the author edits");

// 24. Moving a ticket: new key, former key still resolves, numbers never reused
const opsId = newId();
await ok(
  zo.mutate(
    mutators.projects.create({
      id: opsId,
      organizationId: orgId,
      key: "OPS",
      name: "Operations",
      color: "#f2994a",
      visibility: "org",
      members: [{ userId: bob.userId, role: "contributor" }],
      createdAt: Date.now(),
    }),
  ),
  "OPS",
);
await ok(zb.mutate(mutators.tickets.move({ ...ev(), organizationId: orgId, ticketId: fromId, projectId: opsId })), "move");
const moved = (await db.query("select project_id, number from ticket where id = $1", [fromId])).rows[0];
assert.deepEqual({ project: moved.project_id, number: Number(moved.number) }, { project: opsId, number: 1 });
const fromNumber = Number((await db.query("select number from ticket_alias where ticket_id = $1", [fromId])).rows[0].number);
const alias = await zb.run(queries.tickets.alias({ organizationId: orgId, projectId: appId, number: fromNumber }), { type: "complete" });
assert.equal(alias?.ticketId, fromId, "former key resolves");
const next = newTicket(appId, "After the move");
await ok(zb.mutate(next), "next APP ticket");
assert.ok(Number((await db.query("select number from ticket where id = $1", [next.args.id])).rows[0].number) > fromNumber, "no reuse");
await rejected(
  zc.mutate(mutators.tickets.move({ ...ev(), organizationId: orgId, ticketId: firstId, projectId: opsId })),
  "reporter moving",
);
step("move: new number in the target project, former key kept as alias, numbers never reused");

/* ------------------------------------------------------------------ */
/* M3 — notifications (rules, preferences, read state) and search      */
/* ------------------------------------------------------------------ */

const notificationsOf = async (userId: string, where = "true") =>
  (
    await db.query(
      `select id, kind, actor_id, ticket_id, message_id, read_at, archived_at from notification where user_id = $1 and organization_id = $2 and ${where} order by created_at`,
      [userId, orgId],
    )
  ).rows;
const say = async (z: Zero, channelId: string, body: string, parentId?: string) => {
  const mid = newId();
  await ok(
    z.mutate(
      mutators.messages.send({ id: mid, organizationId: orgId, channelId, body, parentId: parentId ?? null, createdAt: Date.now() }),
    ),
    `message "${body}"`,
  );
  return mid;
};

// 25. No notification for direct messages: a conversation lives in the chat
const dmMention = await say(zo, dmId, `${mentionToken(bob.userId)} are you around?`);
assert.equal((await notificationsOf(bob.userId, `message_id = '${dmMention}'`)).length, 0, "no notification for a DM mention");
step("notifications: direct messages never notify (not even mentions)");

// 26. Preferences: a muted kind is never created; settings are private
await ok(
  zb.mutate(
    mutators.notifications.updateSettings({ organizationId: orgId, mutedKinds: ["mention"], browserEnabled: true, at: Date.now() }),
  ),
  "bob mutes mentions",
);
const muted = await say(zo, general.id, `${mentionToken(bob.userId)} muted ping`);
assert.equal((await notificationsOf(bob.userId, `message_id = '${muted}'`)).length, 0, "muted kind not created");
await ok(
  zb.mutate(mutators.notifications.updateSettings({ organizationId: orgId, mutedKinds: [], browserEnabled: true, at: Date.now() })),
  "bob unmutes",
);
const unmuted = await say(zo, general.id, `${mentionToken(bob.userId)} audible ping`);
assert.equal((await notificationsOf(bob.userId, `message_id = '${unmuted}'`)).length, 1, "unmuted kind created again");
const bobSettings = await zb.run(queries.notifications.settings({ organizationId: orgId }), { type: "complete" });
assert.equal(bobSettings?.browserEnabled, true, "bob reads his settings");
assert.equal(await zc.run(queries.notifications.settings({ organizationId: orgId }), { type: "complete" }), undefined, "carol has none");
step("notifications: preferences mute a kind at creation; settings stay private");

// 27. Ticket events: assignment, status, comments for every follower
const playground = newTicket(appId, "Notification playground");
await ok(zb.mutate(playground), "bob creates a ticket");
const pgId = playground.args.id;
await ok(
  zc.mutate(
    mutators.comments.create({ id: newId(), organizationId: orgId, ticketId: pgId, body: "I saw this too", createdAt: Date.now() }),
  ),
  "carol comments first",
);
await ok(zo.mutate(mutators.tickets.update({ ...ev(), organizationId: orgId, ticketId: pgId, assigneeId: bob.userId })), "assign bob");
await ok(zo.mutate(mutators.tickets.update({ ...ev(), organizationId: orgId, ticketId: pgId, status: "in_progress" })), "status");
await ok(
  zo.mutate(
    mutators.comments.create({
      id: newId(),
      organizationId: orgId,
      ticketId: pgId,
      body: "Please double-check the zebra layout",
      createdAt: Date.now(),
    }),
  ),
  "owner comments",
);
const kindsFor = async (userId: string) => (await notificationsOf(userId, `ticket_id = '${pgId}'`)).map((n) => n.kind).sort();
assert.deepEqual(
  await kindsFor(bob.userId),
  ["comment", "comment", "ticket_assigned", "ticket_status"],
  "creator + assignee: both comments",
);
assert.deepEqual(await kindsFor(carol.userId), ["comment"], "previous commenter follows the ticket");
assert.deepEqual(await kindsFor(owner.userId), [], "the actor is never notified");
step("notifications: assignment, status and comments reach creator, assignee and previous commenters");

// 28. Read state, archive, isolation
const bobPanel = await zb.run(queries.notifications.list({ organizationId: orgId, filter: "unread", limit: 100 }), { type: "complete" });
const bobUnreadDb = await notificationsOf(bob.userId, "read_at is null and archived_at is null");
assert.equal(bobPanel.length, bobUnreadDb.length, "unread panel = unread rows");
assert.ok(
  bobPanel.every((n) => n.userId === bob.userId && n.organizationId === orgId),
  "only bob's notifications of this organization",
);
const firstNotif = bobPanel[0];
assert.ok(firstNotif);
await rejected(zc.mutate(mutators.notifications.setRead({ ids: [firstNotif.id], read: true, at: Date.now() })), "carol marking bob's");
assert.equal((await notificationsOf(bob.userId, `id = '${firstNotif.id}'`))[0].read_at, null);
await ok(zb.mutate(mutators.notifications.setRead({ ids: [firstNotif.id], read: true, at: Date.now() })), "mark read");
assert.notEqual((await notificationsOf(bob.userId, `id = '${firstNotif.id}'`))[0].read_at, null);
await ok(zb.mutate(mutators.notifications.setRead({ ids: [firstNotif.id], read: false, at: Date.now() })), "mark unread");
assert.equal((await notificationsOf(bob.userId, `id = '${firstNotif.id}'`))[0].read_at, null);
await ok(zb.mutate(mutators.notifications.archive({ ids: [firstNotif.id], at: Date.now() })), "archive");
const bobAll = await zb.run(queries.notifications.list({ organizationId: orgId, filter: "all", limit: 100 }), { type: "complete" });
assert.ok(!bobAll.some((n) => n.id === firstNotif.id), "archived notifications leave the panel");
await ok(zb.mutate(mutators.notifications.markAllRead({ organizationId: orgId, at: Date.now() })), "mark all read");
assert.equal((await notificationsOf(bob.userId, "read_at is null")).length, 0, "everything read");
assert.equal(
  (await ze.run(queries.notifications.list({ organizationId: orgId, filter: "all", limit: 100 }), { type: "complete" })).length,
  0,
  "other organization: nothing",
);
step("notifications: read/unread, archive, mark all read; nobody touches someone else's");

// 29. Search: prefixes, case and accents, permissions
async function searchAs(x: Session, params: Record<string, string>) {
  const res = await fetch(`${API}/api/search?${new URLSearchParams({ organizationId: orgId, ...params })}`, {
    headers: { cookie: x.cookie },
  });
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON in a test
  return { status: res.status, json: (await res.json()) as any };
}
const ids = async (x: Session, q: string, extra: Record<string, string> = {}) => {
  const r = await searchAs(x, { q, ...extra });
  assert.equal(r.status, 200, `search "${q}": ${r.status} ${JSON.stringify(r.json)}`);
  return (r.json.results as { id: string; snippet: string }[]).map((x) => x.id);
};
const deploy = await say(zo, general.id, "Le déploiement du service Paiements a échoué cette nuit");
assert.ok((await ids(bob, "deploiement")).includes(`message:${deploy}`), "accent-insensitive");
assert.ok((await ids(bob, "DÉPLOIE paiem")).includes(`message:${deploy}`), "case-insensitive prefixes, all words");
assert.ok(!(await ids(bob, "deploiement annulé")).includes(`message:${deploy}`), "every word must match");
const capital = await say(zo, general.id, "Échec ÉNORME à l'Étape de paiement");
assert.ok((await ids(bob, "echec enorme etape")).includes(`message:${capital}`), "accented capitals fold too");
const hit = (await searchAs(bob, { q: "echoue" })).json.results.find((r: { id: string }) => r.id === `message:${deploy}`);
assert.ok(hit?.snippet.includes("\uE000échoué\uE001"), `highlighted snippet keeps the original text: ${hit?.snippet}`);
assert.ok(!(await ids(bob, "budget")).some((i) => i.startsWith("message:")), "private channel hidden from non-members");
assert.ok((await ids(owner, "budget")).length > 0, "members find it");
assert.ok(!(await ids(carol, "around")).includes(`message:${dmMention}`), "DMs hidden from outsiders");
assert.ok((await ids(bob, "around")).includes(`message:${dmMention}`), "DM members find it");
assert.ok((await ids(bob, "Bob Member audible")).includes(`message:${unmuted}`), "mentions are searchable by name");
assert.equal((await searchAs(eve, { q: "deploiement" })).status, 403, "other organization: forbidden");
const secret = newTicket(secId, "Secret roadmap for Q4");
await ok(zo.mutate(secret), "owner creates a ticket in the private project");
const secretNumber = Number((await db.query("select number from ticket where id = $1", [secret.args.id])).rows[0].number);
assert.ok((await ids(owner, "secret roadmap")).includes(`ticket:${secret.args.id}`), "admin finds it");
assert.ok((await ids(owner, `SEC-${secretNumber}`)).includes(`ticket:${secret.args.id}`), "search by key");
assert.ok(!(await ids(bob, "secret roadmap")).includes(`ticket:${secret.args.id}`), "private project hidden");
assert.ok(
  (await ids(dave, "zebra")).some((i) => i.startsWith("comment:")),
  "comments of readable tickets",
);
assert.deepEqual(await ids(dave, "zebra", { types: "message" }), [], "type filter");
assert.ok((await ids(bob, "playground", { projectId: appId })).includes(`ticket:${pgId}`), "project filter");
assert.deepEqual(await ids(bob, "playground", { projectId: secId }), [], "project filter excludes");
await ok(zo.mutate(mutators.messages.delete({ organizationId: orgId, id: deploy, at: Date.now() })), "delete");
assert.ok(!(await ids(bob, "deploiement")).includes(`message:${deploy}`), "deleted messages leave the index");
assert.equal((await searchAs(bob, { q: "" })).status, 400, "empty query refused");
step("search: prefixes, case/accent-insensitive, highlights, filters; never leaks private channels, DMs, projects or other orgs");

/* ------------------------------------------------------------------ */
/* M4 — knowledge base: teams, access, versions, trash, import         */
/* ------------------------------------------------------------------ */

/** Retries until `check` passes (rows written by the API with plain SQL reach zero-cache through replication) */
async function eventually(check: () => Promise<void>, what: string, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    try {
      return await check();
    } catch (e) {
      if (Date.now() - start > timeoutMs) throw new Error(`${what}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
const listDocs = (z: Zero, viewAs?: string) => z.run(queries.docs.list({ organizationId: orgId, viewAs }), { type: "complete" });
const listFolders = (z: Zero, viewAs?: string) => z.run(queries.docs.folders({ organizationId: orgId, viewAs }), { type: "complete" });
const getDoc = (z: Zero, docId: string) => z.run(queries.docs.get({ organizationId: orgId, docId }), { type: "complete" });
const has = (rows: readonly { id: string }[], id: string) => rows.some((r) => r.id === id);
const now = () => Date.now();

// 30. Teams: owners/admins manage them
const supportTeam = newId();
await rejected(zb.mutate(mutators.teams.create({ id: newId(), organizationId: orgId, name: "Rogue", at: now() })), "member creates a team");
await ok(zo.mutate(mutators.teams.create({ id: supportTeam, organizationId: orgId, name: "Support", at: now() })), "owner creates a team");
await ok(zo.mutate(mutators.teams.addMember({ organizationId: orgId, teamId: supportTeam, userId: carol.userId, at: now() })), "add carol");
await rejected(
  zo.mutate(mutators.teams.addMember({ organizationId: orgId, teamId: supportTeam, userId: eve.userId, at: now() })),
  "outsider",
);
const teams = await zc.run(queries.teams.list({ organizationId: orgId }), { type: "complete" });
assert.deepEqual(
  teams.find((t) => t.id === supportTeam)?.members.map((m) => m.userId),
  [carol.userId],
);
assert.equal(Number((await db.query("select member_count from team where id = $1", [supportTeam])).rows[0].member_count), 1);
step("teams: owners manage them, members of the organization only");

// 31. Tree: root items inherit the organization default (every member edits)
const handbook = newId();
const onboarding = newId();
const onboardingV1 = "# Onboarding\n\nWelcome aboard: read the **handbook** first.";
await ok(
  zb.mutate(mutators.folders.create({ id: handbook, organizationId: orgId, parentId: null, name: "Handbook", sortOrder: 1, at: now() })),
  "bob creates a root folder",
);
await ok(
  zb.mutate(
    mutators.docs.create({
      id: onboarding,
      organizationId: orgId,
      folderId: handbook,
      title: "Onboarding",
      content: onboardingV1,
      sortOrder: 1,
      versionId: newId(),
      at: now(),
    }),
  ),
  "bob creates a document",
);
const carolOnboarding = await getDoc(zc, onboarding);
assert.equal(carolOnboarding?.versions[0]?.content, onboardingV1, "readers get the body from the current version");
assert.ok(
  carolOnboarding?.aclEntries.some((e) => e.principalType === "org" && e.level === "edit"),
  "inherited org default",
);
assert.equal(
  (await db.query("select content from doc where id = $1", [onboarding])).rows[0].content,
  onboardingV1,
  "body stored server-side",
);

// Restricted folder: stops inheriting, org grant removed → admins only
const finance = newId();
const salaries = newId();
const salariesBody = "Salary grid 2026: quokka bands and zeppelin bonuses";
await ok(
  zo.mutate(mutators.folders.create({ id: finance, organizationId: orgId, parentId: null, name: "Finance", sortOrder: 2, at: now() })),
  "finance",
);
await ok(zo.mutate(mutators.access.setInherit({ organizationId: orgId, nodeId: finance, inherit: false, at: now() })), "restrict");
await eventually(async () => {
  assert.ok(has(await listFolders(zb), finance), "restricting alone keeps current access (inherited entries copied)");
}, "converges");
await ok(zo.mutate(mutators.access.revoke({ organizationId: orgId, grantId: `${finance}:org:org` })), "revoke org access");
await ok(
  zo.mutate(
    mutators.docs.create({
      id: salaries,
      organizationId: orgId,
      folderId: finance,
      title: "Salaries",
      content: salariesBody,
      sortOrder: 1,
      versionId: newId(),
      at: now(),
    }),
  ),
  "salaries",
);
await eventually(async () => {
  assert.ok(!has(await listFolders(zb), finance), "bob doesn't see the restricted folder");
}, "converges");
await eventually(async () => {
  assert.ok(!has(await listDocs(zb), salaries), "…nor its documents");
}, "converges");
assert.equal(await getDoc(zb, salaries), undefined, "…nor their content");
assert.equal(
  (await zb.run(queries.docs.history({ organizationId: orgId, docId: salaries }), { type: "complete" })).length,
  0,
  "…nor their versions",
);
assert.ok(has(await listDocs(zo), salaries), "admins read everything");
await rejected(
  zb.mutate(
    mutators.docs.create({
      id: newId(),
      organizationId: orgId,
      folderId: finance,
      title: "Sneaky",
      content: "",
      sortOrder: 9,
      versionId: newId(),
      at: now(),
    }),
  ),
  "bob can't write into it",
);
step("tree: root items inherit the org default; a restricted folder hides itself and its documents (content, versions)");

// 32. View as (admins only, read-only preview)
assert.ok(!has(await listDocs(zo, bob.userId), salaries), "owner previewing bob's access doesn't see Salaries");
assert.ok(has(await listDocs(zo, bob.userId), onboarding), "…but sees what bob sees");
assert.equal((await listDocs(zb, owner.userId)).length, 0, "a member can't use view-as");
step("view as: admins preview a member's access; nobody else can");

// 33. Teams as principals, levels read / edit / manage
await ok(
  zo.mutate(
    mutators.access.grant({
      organizationId: orgId,
      nodeId: finance,
      principalType: "team",
      principalId: supportTeam,
      level: "read",
      at: now(),
    }),
  ),
  "support team reads Finance",
);
await eventually(async () => {
  assert.ok(has(await listDocs(zc), salaries), "carol (support team) reads Salaries through the folder");
}, "converges");
assert.ok(!has(await listDocs(zb), salaries), "bob still doesn't");
const salV1 = (await getDoc(zc, salaries))?.version ?? 1;
await rejected(
  zc.mutate(
    mutators.docs.save({
      organizationId: orgId,
      docId: salaries,
      title: "Salaries",
      content: "hacked",
      baseVersion: salV1,
      force: false,
      versionId: newId(),
      at: now(),
    }),
  ),
  "read level can't edit",
);
await ok(
  zo.mutate(
    mutators.access.grant({
      organizationId: orgId,
      nodeId: salaries,
      principalType: "user",
      principalId: carol.userId,
      level: "edit",
      at: now(),
    }),
  ),
  "carol edits Salaries (additive document grant)",
);
await ok(
  zc.mutate(
    mutators.docs.save({
      organizationId: orgId,
      docId: salaries,
      title: "Salaries",
      content: `${salariesBody}\n\nUpdated by Carol.`,
      baseVersion: salV1,
      force: false,
      versionId: newId(),
      at: now(),
    }),
  ),
  "edit level saves",
);
await rejected(
  zc.mutate(
    mutators.access.grant({
      organizationId: orgId,
      nodeId: salaries,
      principalType: "user",
      principalId: bob.userId,
      level: "read",
      at: now(),
    }),
  ),
  "edit level can't share",
);
step("teams as principals; read can't edit, edit can't share, grants add to what is inherited");

// 34. Document attachments follow the document's access
const docUpload = (who: Session, docId: string) => {
  const form = new FormData();
  form.set("file", new File([PNG], "chart.png", { type: "image/png" }));
  form.set("organizationId", orgId);
  form.set("docId", docId);
  return fetch(`${API}/api/uploads`, { method: "POST", headers: bearer(who), body: form });
};
const docImg = await docUpload(carol, salaries);
assert.equal(docImg.status, 200, await docImg.clone().text());
const docImgId = ((await docImg.json()) as { id: string }).id;
assert.equal((await docUpload(bob, salaries)).status, 403, "no upload without edit access");
const readImg = (who: Session) => fetch(`${API}/api/files/${docImgId}`, { headers: bearer(who) });
assert.equal((await readImg(carol)).status, 200, "readers of the document read its images");
assert.equal((await readImg(bob)).status, 404, "others don't");
step("attachments: document images need edit to upload, read to download");

// 35. Restricted landing + request access → notification → one-click grant
const nodeInfo = async (who: Session, nodeId: string) =>
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON in a test
  (await (await fetch(`${API}/api/docs/node/${nodeId}?organizationId=${orgId}`, { headers: bearer(who) })).json()) as any;
const bobInfo = await nodeInfo(bob, salaries);
assert.deepEqual([bobInfo.kind, bobInfo.level, bobInfo.title], ["doc", 0, null], "restricted: kind only, no title");
assert.equal(
  (await fetch(`${API}/api/docs/node/${salaries}?organizationId=${orgId}`, { headers: bearer(eve) })).status,
  404,
  "other org: nothing",
);
const requestId = newId();
await ok(
  zb.mutate(mutators.access.request({ organizationId: orgId, nodeId: salaries, level: "read", eventId: requestId, at: now() })),
  "request",
);
const req = (await db.query("select id, user_id, body from notification where kind = 'access_request' and doc_id = $1", [salaries])).rows;
assert.ok(
  req.some((r) => r.user_id === owner.userId && r.body === "read"),
  "managers are notified",
);
assert.ok(!req.some((r) => r.user_id === carol.userId), "editors aren't managers");
await rejected(
  zc.mutate(mutators.access.grantRequest({ organizationId: orgId, notificationId: req[0].id, level: "read", at: now() })),
  "someone else's request",
);
await ok(
  zo.mutate(
    mutators.access.grantRequest({
      organizationId: orgId,
      notificationId: `${requestId}:access_request:${owner.userId}`,
      level: "read",
      at: now(),
    }),
  ),
  "owner grants from the notification",
);
await eventually(async () => {
  assert.ok((await getDoc(zb, salaries))?.versions[0]?.content.includes("Updated by Carol"), "bob now reads Salaries");
}, "converges");
step("request access: managers notified, one-click grant from the notification");

// 36. Versions and conflicts
const base = (await getDoc(zb, onboarding))?.version ?? 1;
await ok(
  zb.mutate(
    mutators.docs.save({
      organizationId: orgId,
      docId: onboarding,
      title: "Onboarding",
      content: `${onboardingV1}\n\nDay 1: laptop.`,
      baseVersion: base,
      force: false,
      versionId: newId(),
      at: now(),
    }),
  ),
  "bob saves v2",
);
const conflict = await errorOf(
  zc.mutate(
    mutators.docs.save({
      organizationId: orgId,
      docId: onboarding,
      title: "Onboarding",
      content: "Carol's stale edit",
      baseVersion: base,
      force: false,
      versionId: newId(),
      at: now(),
    }),
  ),
);
assert.notEqual(conflict.type, "success");
assert.ok(conflict.error?.message?.includes("DOC_CONFLICT"), `conflict detected: ${JSON.stringify(conflict)}`);
await ok(
  zc.mutate(
    mutators.docs.save({
      organizationId: orgId,
      docId: onboarding,
      title: "Onboarding",
      content: "Carol overwrites",
      baseVersion: base,
      force: true,
      versionId: newId(),
      at: now(),
    }),
  ),
  "explicit overwrite",
);
const history = await zb.run(queries.docs.history({ organizationId: orgId, docId: onboarding }), { type: "complete" });
assert.deepEqual(
  history.map((v) => v.number),
  [3, 2, 1],
  "every save is a version",
);
await ok(
  zb.mutate(
    mutators.docs.restoreVersion({
      organizationId: orgId,
      docId: onboarding,
      fromVersionId: history[2].id,
      baseVersion: 3,
      versionId: newId(),
      at: now(),
    }),
  ),
  "restore v1",
);
await eventually(async () => {
  assert.equal((await getDoc(zb, onboarding))?.versions[0]?.content, onboardingV1, "restoring saves the old content as v4");
}, "converges");
assert.equal((await db.query("select version, content from doc where id = $1", [onboarding])).rows[0].version, 4);
step("versions: every save is kept, stale saves are refused (DOC_CONFLICT) unless forced, restore creates a new version");

// 37. Moving changes inheritance
await rejected(
  zb.mutate(mutators.docs.move({ organizationId: orgId, docId: onboarding, folderId: finance, sortOrder: 5, at: now() })),
  "no edit on Finance",
);
await ok(
  zo.mutate(mutators.docs.move({ organizationId: orgId, docId: onboarding, folderId: finance, sortOrder: 5, at: now() })),
  "owner moves it",
);
await eventually(async () => {
  assert.ok(!has(await listDocs(zb), onboarding), "inside Finance, bob loses it");
}, "converges");
await eventually(async () => {
  assert.ok(has(await listDocs(zc), onboarding), "the support team gains it");
}, "converges");
await ok(zo.mutate(mutators.docs.move({ organizationId: orgId, docId: onboarding, folderId: handbook, sortOrder: 1, at: now() })), "back");
await eventually(async () => {
  assert.ok(has(await listDocs(zb), onboarding), "back in Handbook, bob reads it again");
}, "converges");
await rejected(
  zo.mutate(mutators.folders.move({ organizationId: orgId, folderId: handbook, parentId: handbook, sortOrder: 1, at: now() })),
  "no cycles",
);
step("move: access follows the new parent; folders can't be moved inside themselves");

// 38. Trash: delete, restore, purge (admins), search follows
const searchDocIds = async (x: Session, q: string) => (await ids(x, q, { types: "doc" })).filter((i) => i.startsWith("doc:"));
assert.ok((await searchDocIds(bob, "welcome aboard")).includes(`doc:${onboarding}`), "documents are searchable");
await ok(zb.mutate(mutators.trash.delete({ organizationId: orgId, nodeId: handbook, at: now() })), "bob trashes Handbook");
await eventually(async () => {
  assert.ok(!has(await listDocs(zb), onboarding), "its documents leave the tree");
}, "converges");
await eventually(async () => {
  const trash = await zb.run(queries.docs.trashFolders({ organizationId: orgId }), { type: "complete" });
  assert.ok(has(trash, handbook), "the folder is in the trash");
}, "trash");
assert.equal((await db.query("select trash_root_id from doc where id = $1", [onboarding])).rows[0].trash_root_id, handbook);
assert.ok(!(await searchDocIds(bob, "welcome aboard")).length, "trashed documents leave search");
await ok(zb.mutate(mutators.trash.restore({ organizationId: orgId, nodeId: handbook, at: now() })), "restore");
await eventually(async () => {
  assert.ok(has(await listDocs(zb), onboarding), "restored with its content");
}, "converges");
await ok(zb.mutate(mutators.trash.delete({ organizationId: orgId, nodeId: handbook, at: now() })), "trash again");
await rejected(zb.mutate(mutators.trash.purge({ organizationId: orgId, nodeId: handbook })), "members can't purge");
await ok(zo.mutate(mutators.trash.purge({ organizationId: orgId, nodeId: handbook })), "owner purges");
assert.equal((await db.query("select count(*)::int as n from doc where id = $1", [onboarding])).rows[0].n, 0, "gone for good");
step("trash: subtree deleted and restored together, out of search, purge for owners/admins only");

// 39. Search never leaks documents
assert.ok((await searchDocIds(owner, "zeppelin")).includes(`doc:${salaries}`), "admins find restricted documents");
assert.ok((await searchDocIds(bob, "zeppelin")).includes(`doc:${salaries}`), "bob finds it since he was granted read");
await ok(zo.mutate(mutators.access.revoke({ organizationId: orgId, grantId: `${salaries}:user:${bob.userId}` })), "revoke bob");
assert.ok(!(await searchDocIds(bob, "zeppelin")).length, "revoked: no search result");
assert.ok(!(await searchDocIds(dave, "zeppelin")).length, "never granted: nothing");
step("search: documents only for people who can read them");

// 40. Links between documents and tickets
await rejected(
  zd.mutate(mutators.docLinks.link({ organizationId: orgId, ticketId: pgId, docId: salaries, at: now() })),
  "viewer can't link",
);
await ok(zo.mutate(mutators.docLinks.link({ organizationId: orgId, ticketId: pgId, docId: salaries, at: now() })), "owner links Salaries");
await eventually(async () => {
  const ownerTicket = await zo.run(queries.tickets.get({ organizationId: orgId, ticketId: pgId }), { type: "complete" });
  assert.ok(
    ownerTicket?.docLinks.some((l) => l.docId === salaries),
    "owner sees the related document",
  );
}, "converges");
const bobTicket = await zb.run(queries.tickets.get({ organizationId: orgId, ticketId: pgId }), { type: "complete" });
assert.ok(!bobTicket?.docLinks.some((l) => l.docId === salaries), "bob doesn't see a related document he can't read");
const referenced = await getDoc(zo, salaries);
assert.ok(
  referenced?.links.some((l) => l.ticketId === pgId),
  "the document lists the tickets referencing it",
);
step("links: documents ↔ tickets, filtered by both sides' permissions");

// 41. Import: dry run, then for real
const zipped = zipSync({
  "Guides/Deploy.md": strToU8("# Deploy runbook\n\nRun the blue-green switch."),
  "Guides/Recovery/Rollback.md": strToU8("Rollback steps: pelican procedure.\n\n![shot](./shot.png)"),
  "Guides/shot.png": PNG,
  "__MACOSX/Guides/._Deploy.md": strToU8("junk"),
});
const importAs = (who: Session, dryRun: boolean, folderId?: string) => {
  const form = new FormData();
  form.set("file", new File([zipped], "guides.zip", { type: "application/zip" }));
  form.set("organizationId", orgId);
  if (folderId) form.set("folderId", folderId);
  if (dryRun) form.set("dryRun", "1");
  return fetch(`${API}/api/docs/import`, { method: "POST", headers: bearer(who), body: form });
};
assert.equal((await importAs(bob, false, finance)).status, 403, "no import into a folder you can't edit");
const dryImport = await importAs(bob, true);
assert.equal(dryImport.status, 200, await dryImport.clone().text());
// biome-ignore lint/suspicious/noExplicitAny: loose JSON in a test
const dryReport = (await dryImport.json()) as any;
assert.deepEqual(dryReport.docs.map((d: { title: string }) => d.title).sort(), ["Deploy runbook", "Rollback"]);
assert.equal(dryReport.folders.created, 2);
assert.ok(
  dryReport.warnings.some((w: { path: string }) => w.path === "Guides/shot.png"),
  "non-markdown files reported",
);
assert.ok(
  dryReport.warnings.some((w: { message: string }) => w.message.includes("relative")),
  "relative images reported",
);
assert.equal((await db.query("select count(*)::int as n from doc where title = 'Deploy runbook'")).rows[0].n, 0, "dry run writes nothing");
const real = await importAs(bob, false);
assert.equal(real.status, 200, await real.clone().text());
const imported = (await db.query("select id, folder_id, version from doc where source like 'import:Guides/%' order by title")).rows;
assert.equal(imported.length, 2);
await eventually(async () => {
  const docs = await listDocs(zc);
  assert.ok(
    imported.every((d) => has(docs, d.id)),
    "imported documents synced with inherited access",
  );
}, "import sync");
assert.ok((await searchDocIds(carol, "pelican")).length === 1, "imported documents are searchable");
const importedBody = await getDoc(zc, imported[0].id);
assert.equal(importedBody?.versions[0]?.number, 1, "imported documents start at version 1");
step("import: zip of markdown → folders + documents, dry run, report (skipped files, relative images), access checked");

// 42. Other organization: nothing
assert.equal((await listDocs(ze)).length, 0, "eve sees no document of Acme");
assert.equal((await listFolders(ze)).length, 0, "…nor folders");
await rejected(
  ze.mutate(mutators.folders.create({ id: newId(), organizationId: orgId, parentId: null, name: "Evil", sortOrder: 1, at: now() })),
  "eve can't write",
);
step("isolation: another organization sees and writes nothing");

await zd.close();
await Promise.all([zb.close(), zo.close(), ze.close(), zc.close()]);
await db.end();
console.log("\nAll sync checks passed.");
