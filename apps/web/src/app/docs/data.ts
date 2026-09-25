/**
 * Knowledge base data on the client: the tree (folders + documents without bodies), the user's level on
 * every node (derived from the synced ACL entries, the same rule as the server), "view as" state.
 */
import { type AclRow, atLeast, docMentionToken, levelFor } from "@feedbacks/schema/docs";
import type { AccessLevel } from "@feedbacks/schema/enums";
import { queries } from "@feedbacks/schema/zero";
import { useQuery } from "@rocicorp/zero/react";
import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import { useOrg } from "../org-context";
import { useOrgMembers } from "../org-data";

/* "View as" (owners/admins): previews a member's access, read-only. Module state, reset on reload. */
let viewAsValue: string | null = null;
const viewAsListeners = new Set<() => void>();
export const setViewAs = (userId: string | null) => {
  viewAsValue = userId;
  for (const l of viewAsListeners) l();
};
export const useViewAs = () =>
  useSyncExternalStore(
    (l) => {
      viewAsListeners.add(l);
      return () => viewAsListeners.delete(l);
    },
    () => viewAsValue,
    () => null,
  );

export function useMyTeamIds(userId: string) {
  const { org } = useOrg();
  const [teams] = useQuery(queries.teams.list({ organizationId: org.id }));
  return useMemo(() => new Set(teams.filter((t) => t.members.some((m) => m.userId === userId)).map((t) => t.id)), [teams, userId]);
}

export function useTeams() {
  const { org } = useOrg();
  const [teams] = useQuery(queries.teams.list({ organizationId: org.id }));
  return teams;
}

export type TreeFolder = ReturnType<typeof useDocsTree>["folders"][number];
export type TreeDoc = ReturnType<typeof useDocsTree>["docs"][number];

/** The readable tree of the current user (or of the member being previewed with "view as") */
export function useDocsTree() {
  const { org, user } = useOrg();
  const viewAs = useViewAs();
  const subject = viewAs ?? user.id;
  const { roles, isAdmin } = useOrgMembers();
  const [folders, folderResult] = useQuery(queries.docs.folders({ organizationId: org.id, viewAs: viewAs ?? undefined }));
  const [docs, docResult] = useQuery(queries.docs.list({ organizationId: org.id, viewAs: viewAs ?? undefined }));
  const teamIds = useMyTeamIds(subject);
  const subjectAdmin = viewAs ? ["owner", "admin"].includes(roles.get(viewAs) ?? "") : isAdmin;

  return useMemo(() => {
    const levelOf = (entries: readonly AclRow[]): AccessLevel | null => {
      const level = levelFor(entries, subject, teamIds, subjectAdmin);
      // Previewing someone else is read-only
      return viewAs && level ? "read" : level;
    };
    const folderById = new Map(folders.map((f) => [f.id, f]));
    const docById = new Map(docs.map((d) => [d.id, d]));
    const byOrder = <T extends { sortOrder: number | null; id: string }>(a: T, b: T) =>
      (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id);
    const childFolders = (parentId: string | null) => folders.filter((f) => (f.parentId ?? null) === parentId).sort(byOrder);
    const childDocs = (folderId: string | null) => docs.filter((d) => (d.folderId ?? null) === folderId).sort(byOrder);
    /** Ancestors of a folder, root first (stops at folders the user can't see) */
    const pathOf = (folderId: string | null) => {
      const path: typeof folders = [];
      let cur = folderId ? folderById.get(folderId) : undefined;
      for (let i = 0; cur && i < 100; i++) {
        path.unshift(cur);
        cur = cur.parentId ? folderById.get(cur.parentId) : undefined;
      }
      return path;
    };
    const folderLevel = (id: string | null): AccessLevel | null => {
      if (!id) return viewAs ? "read" : subjectAdmin ? "manage" : "edit"; // root = organization default
      const f = folderById.get(id);
      return f ? levelOf(f.aclEntries) : null;
    };
    const docLevel = (id: string) => {
      const d = docById.get(id);
      return d ? levelOf(d.aclEntries) : null;
    };
    return {
      folders,
      docs,
      folderById,
      docById,
      childFolders,
      childDocs,
      pathOf,
      folderLevel,
      docLevel,
      levelOf,
      loaded: folderResult.type === "complete" && docResult.type === "complete",
      readOnly: !!viewAs,
    };
  }, [folders, docs, folderResult.type, docResult.type, subject, teamIds, subjectAdmin, viewAs]);
}

export const canEdit = (l: AccessLevel | null | undefined) => atLeast(l, "edit");
export const canManage = (l: AccessLevel | null | undefined) => atLeast(l, "manage");

/* ------------------------------------------------------------------ */
/* Document mentions: `[[Title]]` while typing, `<doc:id>` once stored  */
/* ------------------------------------------------------------------ */

export type DocIndex = ReadonlyMap<string, { id: string; title: string }>;
export const DocIndexContext = createContext<DocIndex>(new Map());
export const useDocIndex = () => useContext(DocIndexContext);

/** Replaces `[[Title]]` of readable documents with `<doc:id>` tokens (exact title, case-insensitive) */
export function encodeDocMentions(text: string, index: DocIndex) {
  if (!text.includes("[[")) return text;
  const byTitle = new Map<string, string>();
  for (const d of index.values()) if (!byTitle.has(d.title.toLowerCase())) byTitle.set(d.title.toLowerCase(), d.id);
  return text.replace(/\[\[([^\]\n]{1,200})\]\]/g, (all, title: string) => {
    const id = byTitle.get(title.trim().toLowerCase());
    return id ? docMentionToken(id) : all;
  });
}

/** Inverse of encodeDocMentions, for editing (unreadable documents keep their token) */
export function decodeDocMentions(text: string, index: DocIndex) {
  return text.replace(/<doc:([A-Za-z0-9_-]{1,64})>/g, (all, id: string) => {
    const d = index.get(id);
    return d ? `[[${d.title}]]` : all;
  });
}
