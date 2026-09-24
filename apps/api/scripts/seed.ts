/**
 * Demo data for a FRESH instance (refuses to run if users exist):
 *   pnpm db:seed   → owner demo@example.com / demo-password, organization "Demo", a few channels and messages.
 */
import * as s from "@feedbacks/schema/db";
import { newId } from "@feedbacks/schema/ids";
import { eq } from "drizzle-orm";
import { auth, instanceHasUsers } from "../src/auth";
import { db, pool } from "../src/db";

if (await instanceHasUsers()) {
  console.log("seed: the instance already has users, nothing to do.");
  await pool.end();
  process.exit(0);
}

const password = "demo-password";
const people = [
  { name: "Demo Owner", email: "demo@example.com" },
  { name: "Alex Support", email: "alex@example.com" },
  { name: "Sam Developer", email: "sam@example.com" },
];

const owner = await auth.api.signUpEmail({ body: { ...people[0], password } });
const org = await auth.api.createOrganization({ body: { name: "Demo", slug: "demo", userId: owner.user.id } });
if (!org) throw new Error("organization not created");

// Other members: invitation + account + membership, as the real flow would do
const members = [owner.user];
for (const p of people.slice(1)) {
  // A pending invitation lets the account through the invitation-only sign-up hook
  const invitationId = newId();
  await db.insert(s.invitation).values({
    id: invitationId,
    organizationId: org.id,
    email: p.email,
    role: "member",
    status: "pending",
    expiresAt: new Date(Date.now() + 86_400_000),
    inviterId: owner.user.id,
  });
  const u = await auth.api.signUpEmail({ body: { ...p, password } });
  await db.update(s.invitation).set({ status: "accepted" }).where(eq(s.invitation.id, invitationId));
  await db.insert(s.member).values({ id: newId(), organizationId: org.id, userId: u.user.id, role: "member", createdAt: new Date() });
  members.push(u.user);
}

const now = Date.now();
const channels = [
  { name: "feedback", topic: "Customer feedback shared by the support team" },
  { name: "bugs", topic: "Bug reports — pick the project when turning a report into a ticket" },
  { name: "release-testing", topic: "Test the app before each release and report here" },
];
for (const c of channels) {
  const id = newId();
  await db.insert(s.channel).values({
    id,
    organizationId: org.id,
    kind: "public",
    name: c.name,
    topic: c.topic,
    createdBy: owner.user.id,
    createdAt: new Date(now - 86_400_000),
  });
  const lines = [
    [1, `Welcome to #${c.name}!`],
    [2, "The export button does nothing on Safari iOS."],
    [0, "Can you share a screenshot and the app version?"],
    [2, "Version 2.3.1, iPhone 13 — screenshot coming."],
  ] as const;
  let t = now - 3 * 3_600_000;
  for (const [who, body] of lines) {
    t += 7 * 60_000;
    await db
      .insert(s.message)
      .values({ id: newId(), organizationId: org.id, channelId: id, authorId: members[who].id, body, createdAt: new Date(t) });
  }
}

console.log(`seed: organization "Demo" ready. Sign in with ${people[0].email} / ${password}`);
await pool.end();
