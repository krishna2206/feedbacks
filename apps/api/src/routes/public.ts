/** Unauthenticated endpoints needed before sign-in (instance status, invitation preview). */
import * as s from "@feedbacks/schema/db";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { instanceHasOrganization, instanceHasUsers } from "../auth";
import { db } from "../db";
import { emailEnabled } from "../email";
import { env } from "../env";

export function mountPublic(app: Hono) {
  app.get("/api/health", (c) => c.json({ ok: true }));

  /** What the login/setup screens need to render */
  app.get("/api/instance", async (c) =>
    c.json({
      needsSetup: !(await instanceHasUsers()) || !(await instanceHasOrganization()),
      hasUsers: await instanceHasUsers(),
      setupTokenRequired: env.setupToken !== null,
      googleEnabled: env.google !== null,
      emailEnabled,
    }),
  );

  /** Invitation preview for the /invite/:id page (email is shown so the invitee knows which account to use) */
  app.get("/api/invitations/:id", async (c) => {
    const [row] = await db
      .select({
        id: s.invitation.id,
        email: s.invitation.email,
        role: s.invitation.role,
        status: s.invitation.status,
        expiresAt: s.invitation.expiresAt,
        organizationName: s.organization.name,
        inviterName: s.user.name,
      })
      .from(s.invitation)
      .innerJoin(s.organization, eq(s.organization.id, s.invitation.organizationId))
      .innerJoin(s.user, eq(s.user.id, s.invitation.inviterId))
      .where(eq(s.invitation.id, c.req.param("id")))
      .limit(1);
    if (!row) return c.json({ error: "not_found" }, 404);
    const [existing] = await db.select({ id: s.user.id }).from(s.user).where(eq(s.user.email, row.email)).limit(1);
    return c.json({
      ...row,
      expired: row.expiresAt.getTime() < Date.now(),
      accountExists: !!existing,
    });
  });
}
