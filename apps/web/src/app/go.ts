import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useOrg } from "./org-context";

/** Typed navigation targets shared by notifications, the command menu, search and shortcuts */
export function useGo() {
  const navigate = useNavigate();
  const { org } = useOrg();
  return useMemo(() => {
    const orgSlug = org.slug;
    return {
      /** A ticket by key ("APP-12") or id */
      ticket: (ref: string) => navigate({ to: "/$orgSlug/issue/$ref", params: { orgSlug, ref } }),
      /** A channel; with a message it scrolls to it (and opens its thread when it's a reply) */
      channel: (channelId: string, messageId?: string, parentId?: string | null) =>
        navigate({
          to: "/$orgSlug/c/$channelId",
          params: { orgSlug, channelId },
          search: { m: parentId ?? messageId, thread: parentId ?? undefined },
        }),
      project: (projectKey: string) => navigate({ to: "/$orgSlug/projects/$projectKey", params: { orgSlug, projectKey } }),
      projects: () => navigate({ to: "/$orgSlug/projects", params: { orgSlug } }),
      myTickets: () => navigate({ to: "/$orgSlug/tickets", params: { orgSlug } }),
      docs: (folderId?: string | null) =>
        folderId
          ? navigate({ to: "/$orgSlug/docs/f/$folderId", params: { orgSlug, folderId } })
          : navigate({ to: "/$orgSlug/docs", params: { orgSlug } }),
      doc: (docId: string, opts: { edit?: boolean; history?: boolean } = {}) =>
        navigate({ to: "/$orgSlug/docs/d/$docId", params: { orgSlug, docId }, search: opts }),
      search: (q?: string) => navigate({ to: "/$orgSlug/search", params: { orgSlug }, search: q ? { q } : {} }),
      settings: (page: "notifications" | "members" | "teams" = "notifications") =>
        page === "members"
          ? navigate({ to: "/$orgSlug/settings/members", params: { orgSlug } })
          : page === "teams"
            ? navigate({ to: "/$orgSlug/settings/teams", params: { orgSlug } })
            : navigate({ to: "/$orgSlug/settings/notifications", params: { orgSlug } }),
    };
  }, [navigate, org.slug]);
}
