/**
 * Authentication (Better Auth): email + password, optional Google, organizations with
 * invitations. Access rules of an instance:
 *  - a fresh instance lets the first person sign up; they create the organization (owner);
 *  - afterwards sign-up is invitation-only: an account can only be created for an email
 *    that has a pending invitation (owners/admins invite and choose the role).
 */
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import * as schema from "@feedbacks/schema/db";
import { newId } from "@feedbacks/schema/ids";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer, organization } from "better-auth/plugins";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { db } from "./db";
import { sendEmail } from "./email";
import { env } from "./env";

export async function instanceHasUsers() {
  const [row] = await db.select({ n: count() }).from(schema.user);
  return (row?.n ?? 0) > 0;
}

export async function instanceHasOrganization() {
  const [row] = await db.select({ n: count() }).from(schema.organization);
  return (row?.n ?? 0) > 0;
}

async function hasPendingInvitation(email: string) {
  const [row] = await db
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        sql`lower(${schema.invitation.email}) = lower(${email})`,
        eq(schema.invitation.status, "pending"),
        gt(schema.invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return !!row;
}

/** New members join the organization's #general channel (unread starts now) */
async function joinDefaultChannels(organizationId: string, userId: string) {
  const channels = await db
    .select({ id: schema.channel.id, lastSeq: schema.channel.lastSeq })
    .from(schema.channel)
    .where(and(eq(schema.channel.organizationId, organizationId), eq(schema.channel.kind, "public"), eq(schema.channel.name, "general")));
  const now = new Date();
  for (const c of channels) {
    await db
      .insert(schema.channelMember)
      .values({ id: `${c.id}:${userId}`, organizationId, channelId: c.id, userId, lastReadAt: now, lastReadSeq: c.lastSeq, joinedAt: now })
      .onConflictDoNothing();
  }
}

export const inviteUrl = (invitationId: string) => `${env.appUrl}/invite/${invitationId}`;

export const auth = betterAuth({
  appName: "Feedbacks",
  baseURL: env.appUrl,
  basePath: "/api/auth",
  secret: env.authSecret,
  trustedOrigins: [env.appUrl],
  // Behind the reverse proxy (nginx/Traefik) the client IP comes from forwarding headers
  advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for", "x-real-ip"] } },
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      void sendEmail({
        to: user.email,
        subject: "Reset your Feedbacks password",
        text: `Hi ${user.name},\n\nReset your password with this link (valid 1 hour):\n${url}\n\nIf you didn't ask for it, ignore this email.`,
      });
    },
  },
  socialProviders: env.google ? { google: env.google } : {},
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!(await instanceHasUsers())) return { data: user }; // first user of a fresh instance
          if (await hasPendingInvitation(user.email)) return { data: user };
          throw new APIError("FORBIDDEN", { message: "Sign-up is by invitation only." });
        },
      },
    },
  },
  plugins: [
    // Session token as `Authorization: Bearer` — used by non-browser clients (Zero in Node, MCP, CLI)
    bearer(),
    organization({
      teams: { enabled: true },
      // One organization per instance for now: only a fresh instance can create one.
      allowUserToCreateOrganization: async () => !(await instanceHasOrganization()),
      invitationExpiresIn: 60 * 60 * 24 * 7,
      cancelPendingInvitationsOnReInvite: true,
      sendInvitationEmail: async (data) => {
        void sendEmail({
          to: data.email,
          subject: `${data.inviter.user.name} invited you to ${data.organization.name} on Feedbacks`,
          text: `${data.inviter.user.name} (${data.inviter.user.email}) invited you to join ${data.organization.name}.\n\nAccept the invitation: ${inviteUrl(data.id)}`,
        });
      },
      organizationHooks: {
        afterAcceptInvitation: async ({ member }) => joinDefaultChannels(member.organizationId, member.userId),
        afterAddMember: async ({ member }) => joinDefaultChannels(member.organizationId, member.userId),
        // Every organization starts with a #general channel
        afterCreateOrganization: async ({ organization: org, user }) => {
          const channelId = newId();
          const now = new Date();
          await db.insert(schema.channel).values({
            id: channelId,
            organizationId: org.id,
            kind: "public",
            name: "general",
            topic: null,
            createdBy: user.id,
            createdAt: now,
          });
          await db.insert(schema.channelMember).values({
            id: `${channelId}:${user.id}`,
            organizationId: org.id,
            channelId,
            userId: user.id,
            lastReadAt: now,
            joinedAt: now,
          });
        },
      },
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
