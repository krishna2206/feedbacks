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
import pg from "pg";

const API = `http://localhost:${process.env.API_PORT}`;
const ZERO = `http://localhost:${process.env.ZERO_PORT}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

type Session = { token: string; cookie: string; userId: string };

async function authPost(path: string, body: unknown, s?: Session) {
  const res = await fetch(`${API}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: process.env.APP_URL ?? API, ...(s ? { cookie: s.cookie } : {}) },
    body: JSON.stringify(body),
  });
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON in a test
  const json: any = await res.json().catch(() => null);
  return { res, json };
}

async function signUp(name: string, email: string): Promise<Session> {
  const { res, json } = await authPost("/sign-up/email", { name, email, password: "correct-horse-battery" });
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

// 1. Fresh instance: first user creates the organization and becomes owner
const owner = await signUp("Olivia Owner", "owner@example.com");
const created = await authPost("/organization/create", { name: "Acme", slug: "acme" }, owner);
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

await Promise.all([zb.close(), zo.close(), ze.close(), zc.close()]);
await db.end();
console.log("\nAll sync checks passed.");
