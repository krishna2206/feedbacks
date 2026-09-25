/**
 * Row-visibility rules shared by queries and mutators. Queries run on the server with
 * these filters, so clients can only ever sync rows they are allowed to see.
 *
 * Channel rules:
 *  - public channels: readable by every member of the organization, writable once joined
 *    (sending a message in a public channel joins it automatically);
 *  - private channels and direct messages: readable and writable by their members only.
 */
import type { Query, Transaction } from "@rocicorp/zero";
import type { EffectiveProjectRole } from "../tickets";
import { type Schema, zql } from "./schema";

type ChannelQuery = typeof zql.channel;

/** Organizations the user belongs to */
export function myOrganizations(userID: string) {
  return zql.organization.whereExists("members", (m) => m.where("userId", userID));
}

/**
 * Restricts a channel query to what the user may see in an organization:
 * public channels for any org member, private channels and DMs for their members only.
 */
// biome-ignore lint/suspicious/noExplicitAny: works on list queries and one-to-one relationships (shape preserved by the cast)
export function channelVisibility<Q extends Query<"channel", Schema, any>>(q: Q, userID: string, organizationId: string): Q {
  return (q as unknown as ChannelQuery).where("organizationId", organizationId).where(({ or, and, cmp, exists }) =>
    or(
      and(
        cmp("kind", "public"),
        exists("organization", (o) => o.whereExists("members", (m) => m.where("userId", userID))),
      ),
      exists("members", (m) => m.where("userId", userID)),
    ),
  ) as unknown as Q;
}

export const visibleChannels = (userID: string, organizationId: string) => channelVisibility(zql.channel, userID, organizationId);

/* ------------------------------------------------------------------ */
/* Server-side checks used by mutators (tx.location === "server")      */
/* ------------------------------------------------------------------ */

export class PermissionError extends Error {}

export async function orgMembership(tx: Transaction, userID: string, organizationId: string) {
  return tx.run(zql.member.where("organizationId", organizationId).where("userId", userID).one());
}

export async function assertOrgMember(tx: Transaction, userID: string, organizationId: string) {
  const m = await orgMembership(tx, userID, organizationId);
  if (!m) throw new PermissionError("Not a member of this organization");
  return m;
}

export const isOrgAdmin = (role: string | null | undefined) => role === "owner" || role === "admin";

/** The channel if the user can read it, otherwise throws */
export async function assertCanReadChannel(tx: Transaction, userID: string, organizationId: string, channelId: string) {
  const ch = await tx.run(
    visibleChannels(userID, organizationId)
      .where("id", channelId)
      .related("members", (m) => m.where("userId", userID))
      .one(),
  );
  if (!ch) throw new PermissionError("Channel not found or not accessible");
  return ch;
}

/** Channel creator, organization owners and admins can edit, archive or rename a channel */
export async function assertCanManageChannel(tx: Transaction, userID: string, organizationId: string, channelId: string) {
  const ch = await assertCanReadChannel(tx, userID, organizationId, channelId);
  if (ch.kind === "dm") throw new PermissionError("Direct conversations cannot be managed");
  if (ch.createdBy === userID) return ch;
  const m = await orgMembership(tx, userID, organizationId);
  if (!isOrgAdmin(m?.role)) throw new PermissionError("Only the creator or an admin can manage this channel");
  return ch;
}

/* ------------------------------------------------------------------ */
/* Projects and tickets                                                */
/* ------------------------------------------------------------------ */
/*
 * A project is readable by:
 *  - organization owners and admins;
 *  - its members (any project role);
 *  - every organization member when its visibility is "org" (implicit viewer).
 * A ticket is readable when its project is, or when one of its source messages was written by the user
 * (people who reported something can always follow what became of it).
 */

type ProjectQuery = typeof zql.project;
type TicketQuery = typeof zql.ticket;

export function projectVisibilityFilter(q: ProjectQuery, userID: string, organizationId: string): ProjectQuery {
  return q
    .where("organizationId", organizationId)
    .whereExists("organization", (o) => o.whereExists("members", (m) => m.where("userId", userID)))
    .where(({ or, cmp, exists }) =>
      or(
        cmp("visibility", "org"),
        exists("members", (m) => m.where("userId", userID)),
        exists("organization", (o) => o.whereExists("members", (m) => m.where("userId", userID).where("role", "IN", ["owner", "admin"]))),
      ),
    );
}

export const visibleProjects = (userID: string, organizationId: string) => projectVisibilityFilter(zql.project, userID, organizationId);

/** Works on list queries and on one-to-one relationships (e.g. `ticketSource.ticket`) */
// biome-ignore lint/suspicious/noExplicitAny: the result shape (list or single row) is preserved by the cast
export function ticketVisibilityFilter<Q extends Query<"ticket", Schema, any>>(q: Q, userID: string, organizationId: string): Q {
  return (q as unknown as TicketQuery)
    .where("organizationId", organizationId)
    .whereExists("organization", (o) => o.whereExists("members", (m) => m.where("userId", userID)))
    .where(({ or, exists }) =>
      or(
        exists("project", (p) =>
          p.where(({ or: or2, cmp, exists: exists2 }) =>
            or2(
              cmp("visibility", "org"),
              exists2("members", (m) => m.where("userId", userID)),
              exists2("organization", (o) =>
                o.whereExists("members", (m) => m.where("userId", userID).where("role", "IN", ["owner", "admin"])),
              ),
            ),
          ),
        ),
        exists("sources", (s) => s.whereExists("message", (m) => m.where("authorId", userID))),
      ),
    ) as unknown as Q;
}

export const visibleTickets = (userID: string, organizationId: string) => ticketVisibilityFilter(zql.ticket, userID, organizationId);

/** Effective role of a user in a project (server-side), or null when the project isn't readable */
export async function projectRole(
  tx: Transaction,
  userID: string,
  project: { id: string; organizationId: string; visibility: string | null },
): Promise<EffectiveProjectRole | null> {
  const m = await orgMembership(tx, userID, project.organizationId);
  if (!m) return null;
  if (isOrgAdmin(m.role)) return "admin";
  const pm = await tx.run(zql.projectMember.where("projectId", project.id).where("userId", userID).one());
  if (pm) return pm.role as EffectiveProjectRole;
  return project.visibility === "org" ? "viewer" : null;
}

/** The project and the user's role in it, if readable; otherwise throws */
export async function assertProjectAccess(tx: Transaction, userID: string, organizationId: string, projectId: string) {
  const project = await tx.run(zql.project.where("id", projectId).where("organizationId", organizationId).one());
  const role = project ? await projectRole(tx, userID, project) : null;
  if (!project || !role) throw new PermissionError("Project not found or not accessible");
  return { project, role };
}

/** True when one of the ticket's source messages was written by the user */
export async function isSourceAuthor(tx: Transaction, userID: string, ticketId: string) {
  const src = await tx.run(
    zql.ticketSource
      .where("ticketId", ticketId)
      .whereExists("message", (m) => m.where("authorId", userID))
      .one(),
  );
  return !!src;
}
