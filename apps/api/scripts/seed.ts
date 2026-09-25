/**
 * Demo data for a FRESH instance (refuses to run if users exist):
 *   pnpm db:seed   → owner demo@example.com / demo-password, organization "Demo" with channels, a private
 *   channel, a DM, a thread, reactions, mentions and an image attachment.
 */

import { crc32, deflateSync } from "node:zlib";
import { dmChannelId, excerpt, mentionedUserIds, mentionToken } from "@feedbacks/schema/chat";
import * as s from "@feedbacks/schema/db";
import { newId } from "@feedbacks/schema/ids";
import { and, eq, sql } from "drizzle-orm";
import { auth, instanceHasUsers } from "../src/auth";
import { db, pool } from "../src/db";
import { storage } from "../src/storage";

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
const [ownerU, alex, sam] = members as [(typeof members)[number], (typeof members)[number], (typeof members)[number]];
const everyone = members.map((m) => m.id);

/* ---------- Helpers: channels with members, messages with channel sequences ---------- */

const seqs = new Map<string, number>();
async function createChannel(c: {
  name: string;
  topic: string | null;
  kind: "public" | "private" | "dm";
  memberIds: string[];
  id?: string;
}) {
  const id = c.id ?? newId();
  await db.insert(s.channel).values({
    id,
    organizationId: org.id,
    kind: c.kind,
    name: c.name,
    topic: c.topic,
    createdBy: ownerU.id,
    createdAt: new Date(now - 2 * 86_400_000),
  });
  for (const userId of c.memberIds) {
    await db
      .insert(s.channelMember)
      .values({
        id: `${id}:${userId}`,
        organizationId: org.id,
        channelId: id,
        userId,
        lastReadSeq: 0,
        joinedAt: new Date(now - 2 * 86_400_000),
      })
      .onConflictDoNothing();
  }
  seqs.set(id, 0);
  return id;
}

let clock = now - 5 * 3_600_000;
async function post(channelId: string, authorId: string, body: string, opts: { parentId?: string; minutes?: number } = {}) {
  clock += (opts.minutes ?? 6) * 60_000;
  const id = newId();
  const seq = opts.parentId ? null : (seqs.get(channelId) ?? 0) + 1;
  if (seq !== null) seqs.set(channelId, seq);
  await db
    .insert(s.message)
    .values({ id, organizationId: org.id, channelId, authorId, parentId: opts.parentId ?? null, body, seq, createdAt: new Date(clock) });
  if (opts.parentId) {
    await db
      .update(s.message)
      .set({ replyCount: sql`${s.message.replyCount} + 1`, lastReplyAt: new Date(clock) })
      .where(eq(s.message.id, opts.parentId));
  }
  return id;
}
async function react(messageId: string, userId: string, emoji: string) {
  await db.insert(s.reaction).values({ id: `${messageId}:${userId}:${emoji}`, organizationId: org.id, messageId, userId, emoji });
}

/** A small generated PNG (no binary fixture in the repo): a soft diagonal gradient */
function gradientPng(width: number, height: number) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(94 + t * 60);
      raw[o + 1] = Math.round(105 + t * 90);
      raw[o + 2] = Math.round(210 - t * 40);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- Channels ---------- */

const [general] = await db
  .select()
  .from(s.channel)
  .where(and(eq(s.channel.organizationId, org.id), eq(s.channel.name, "general")));
if (!general) throw new Error("#general missing");
for (const userId of everyone) {
  await db
    .insert(s.channelMember)
    .values({ id: `${general.id}:${userId}`, organizationId: org.id, channelId: general.id, userId, lastReadSeq: 0 })
    .onConflictDoNothing();
}
seqs.set(general.id, 0);

const feedback = await createChannel({
  name: "feedback",
  topic: "Customer feedback shared by the support team",
  kind: "public",
  memberIds: everyone,
});
const bugs = await createChannel({
  name: "bugs",
  topic: "Bug reports — pick the project when turning a report into a ticket",
  kind: "public",
  memberIds: everyone,
});
const release = await createChannel({
  name: "release-testing",
  topic: "Test the app before each release and report here",
  kind: "public",
  memberIds: [ownerU.id, sam.id],
});
const leads = await createChannel({
  name: "leads",
  topic: "Private: planning and priorities",
  kind: "private",
  memberIds: [ownerU.id, sam.id],
});
const dm = await createChannel({
  id: dmChannelId(org.id, [ownerU.id, alex.id]),
  name: "",
  topic: null,
  kind: "dm",
  memberIds: [ownerU.id, alex.id],
});

/* ---------- Conversations ---------- */

await post(general.id, ownerU.id, "Welcome to **Demo**! Use #feedback for customer reports and #bugs for anything broken.");
await post(general.id, alex.id, "Thanks! I'll forward what customers send me to #feedback 👍");

await post(feedback, alex.id, "Morning batch of customer feedback 👇");
const exportBug = await post(feedback, alex.id, "A customer says the **export** button does nothing on Safari iOS.", { minutes: 1 });
const shotMsg = await post(feedback, alex.id, "", { minutes: 1 });
await post(feedback, alex.id, "Another one asks for a _dark mode_ — third request this week.", { minutes: 2 });
await post(feedback, sam.id, "Which iOS version? Is it Safari or the installed app?", { parentId: exportBug });
await post(feedback, alex.id, "iOS 17.5, Safari. It works on desktop Chrome.", { parentId: exportBug });
await post(feedback, sam.id, "Reproduced. Looks like the `touchend` handler — I'm on it.", { parentId: exportBug });
await react(exportBug, sam.id, "👀");
await react(exportBug, ownerU.id, "🙏");
await post(feedback, ownerU.id, `${mentionToken(sam.id)} can you check the dark mode effort for next sprint?`);

await post(bugs, sam.id, "The orders table doesn't sort by date anymore when filtered by status.");
await post(bugs, alex.id, `${mentionToken(ownerU.id)} the password reset email goes to spam for Outlook users.`);
await post(
  bugs,
  sam.id,
  "```\nTypeError: Cannot read properties of undefined (reading 'total')\n    at summary.ts:42\n```\nSeen in the logs after yesterday's deploy.",
);

await post(release, ownerU.id, "Release 2.4 is planned for Thursday 🚀 Test your flows and report here before Wednesday 6pm.");
await post(release, sam.id, "Sign-up + onboarding: all good ✅");
await post(leads, ownerU.id, "Priorities for next week: export bug, then dark mode.");
await post(dm, alex.id, "Could you look at the export bug first? The customer is waiting.");
await post(dm, ownerU.id, "Sure, Sam already reproduced it.");

// An image attachment on the screenshot message
const png = gradientPng(480, 300);
const attachmentId = newId();
const storageKey = `${org.id}/demo/${attachmentId}/screenshot.png`;
await storage.put(storageKey, new Uint8Array(png), "image/png");
await db.insert(s.attachment).values({
  id: attachmentId,
  organizationId: org.id,
  messageId: shotMsg,
  channelId: feedback,
  kind: "image",
  name: "screenshot.png",
  mimeType: "image/png",
  size: png.length,
  storageKey,
  width: 480,
  height: 300,
  uploadedBy: alex.id,
});

// Channel sequences, read positions (the owner has unread messages in #bugs) and mention notifications
for (const [channelId, lastSeq] of seqs) {
  await db
    .update(s.channel)
    .set({ lastSeq, lastMessageAt: new Date(clock) })
    .where(eq(s.channel.id, channelId));
  await db
    .update(s.channelMember)
    .set({ lastReadSeq: channelId === bugs ? 0 : lastSeq })
    .where(eq(s.channelMember.channelId, channelId));
}
const mentions = await db
  .select({ id: s.message.id, body: s.message.body, channelId: s.message.channelId, authorId: s.message.authorId })
  .from(s.message)
  .where(and(eq(s.message.organizationId, org.id), sql`${s.message.body} like '%<@%'`));
for (const m of mentions) {
  for (const userId of mentionedUserIds(m.body)) {
    await db.insert(s.notification).values({
      id: `${m.id}:mention:${userId}`,
      organizationId: org.id,
      userId,
      actorId: m.authorId,
      kind: "mention",
      messageId: m.id,
      channelId: m.channelId,
      body: excerpt(m.body),
    });
  }
}

console.log(`seed: organization "Demo" ready. Sign in with ${people[0].email} / ${password}`);
await pool.end();
