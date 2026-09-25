import type { TicketStatus } from "@feedbacks/schema/enums";
import { canEditTickets, type EffectiveProjectRole, ticketKey } from "@feedbacks/schema/tickets";
import { queries } from "@feedbacks/schema/zero";
import { useQuery } from "@rocicorp/zero/react";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useOrg } from "../org-context";
import { useOrgMembers } from "../org-data";

/** Projects the user can read (synced once, shared by the sidebar, pickers and pages) */
export function useProjects(includeArchived = false) {
  const { org } = useOrg();
  const [projects] = useQuery(queries.projects.list({ organizationId: org.id, includeArchived }));
  return projects;
}
export type ProjectRow = ReturnType<typeof useProjects>[number];

export function useLabels() {
  const { org } = useOrg();
  const [labels] = useQuery(queries.labels.list({ organizationId: org.id }));
  const byId = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  return { labels, byId };
}

/**
 * Effective project role computed client-side (mirrors the server rule in @feedbacks/schema/zero/permissions):
 * org owner/admin → "admin"; project member → their role; org member of an "org"-visible project → "viewer".
 * The server stays authoritative: this only drives what the UI offers.
 */
export function useProjectRoles() {
  const { user } = useOrg();
  const { isAdmin } = useOrgMembers();
  return useCallback(
    (
      project: { visibility: string | null; members: readonly { userId: string; role: string }[] } | null | undefined,
    ): EffectiveProjectRole | null => {
      if (!project) return null;
      if (isAdmin) return "admin";
      const m = project.members.find((x) => x.userId === user.id);
      if (m) return m.role as EffectiveProjectRole;
      return project.visibility === "org" ? "viewer" : null;
    },
    [isAdmin, user.id],
  );
}

/** Projects where the user can create tickets (create dialogs, "move to project") */
export function useWritableProjects() {
  const projects = useProjects();
  const roleOf = useProjectRoles();
  return useMemo(() => projects.filter((p) => canEditTickets(roleOf(p))), [projects, roleOf]);
}

/** projectId → key, for ticket keys (APP-12) */
export function useProjectKeys() {
  const projects = useProjects(true);
  return useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    // Tickets readable through their sources may belong to projects the user can't list: use the related row
    const keyOf = (t: { projectId: string; number: number; project?: { key: string } | null }) =>
      ticketKey(t.project?.key ?? byId.get(t.projectId)?.key ?? "?", t.number);
    return { byId, keyOf };
  }, [projects]);
}

/* ------------------------------------------------------------------ */
/* Global "create ticket" dialog                                        */
/* ------------------------------------------------------------------ */

export type CreateTicketDraft = {
  projectId?: string;
  status?: TicketStatus;
  /** Chat messages the ticket is built from (ordered) */
  sourceMessageIds?: string[];
  /** Called with the new ticket's id once created (e.g. to clear a message selection) */
  onCreated?: (ticketId: string) => void;
};

let draft: CreateTicketDraft | null = null;
const listeners = new Set<() => void>();

export function openCreateTicket(d: CreateTicketDraft = {}) {
  draft = d;
  for (const l of listeners) l();
}
export function closeCreateTicket() {
  draft = null;
  for (const l of listeners) l();
}
export function useCreateTicketDraft() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => draft,
    () => null,
  );
}
