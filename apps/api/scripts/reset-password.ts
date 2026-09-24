/**
 * Owner/admin recovery tool when SMTP is not configured:
 *   pnpm user:reset-password <email> [new-password]
 * Without a password argument, a random one is generated and printed.
 */
import { randomBytes } from "node:crypto";
import * as s from "@feedbacks/schema/db";
import { and, eq } from "drizzle-orm";
import { auth } from "../src/auth";
import { db, pool } from "../src/db";

const [email, given] = process.argv.slice(2);
if (!email) {
  console.error("usage: pnpm user:reset-password <email> [new-password]");
  process.exit(1);
}
const password = given ?? randomBytes(9).toString("base64url");
const [u] = await db.select().from(s.user).where(eq(s.user.email, email)).limit(1);
if (!u) {
  console.error(`No user with email ${email}`);
  process.exit(1);
}
const ctx = await auth.$context;
const hash = await ctx.password.hash(password);
const updated = await db
  .update(s.account)
  .set({ password: hash, updatedAt: new Date() })
  .where(and(eq(s.account.userId, u.id), eq(s.account.providerId, "credential")))
  .returning({ id: s.account.id });
if (!updated.length) {
  await ctx.internalAdapter.linkAccount({ userId: u.id, providerId: "credential", accountId: u.id, password: hash });
}
await db.delete(s.session).where(eq(s.session.userId, u.id));
console.log(`Password reset for ${email}. New password: ${password}`);
await pool.end();
