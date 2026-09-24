/**
 * End-to-end proof of the sync chain against a live stack (see scripts/e2e-sync.mjs):
 *   setup (owner + org) → invitation → invitee joins → Zero mutator writes to Postgres
 *   → authorized query returns the row → a user of another organization sees nothing
 *   and cannot write into the first organization.
 */
import assert from "node:assert/strict";
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
  const json = await res.json().catch(() => null);
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

await Promise.all([zb.close(), zo.close(), ze.close()]);
await db.end();
console.log("\nAll sync checks passed.");
