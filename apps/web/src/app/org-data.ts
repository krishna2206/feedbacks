import { queries } from "@feedbacks/schema/zero";
import { useQuery } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { useOrg } from "./org-context";

export type OrgUser = { id: string; name: string; email: string; image: string | null };

/** Members of the current organization (synced once, shared by every screen) */
export function useOrgMembers() {
  const { org, user } = useOrg();
  const [orgs] = useQuery(queries.orgs.mine());
  return useMemo(() => {
    const current = orgs.find((o) => o.id === org.id);
    const members = current?.members ?? [];
    const users = new Map<string, OrgUser>();
    const roles = new Map<string, string>();
    for (const m of members) {
      if (m.user) users.set(m.user.id, m.user as OrgUser);
      roles.set(m.userId, m.role ?? "member");
    }
    const myRole = members.find((m) => m.userId === user.id)?.role ?? "member";
    const sorted = [...users.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { users, sorted, roles, myRole, isAdmin: myRole === "owner" || myRole === "admin" };
  }, [orgs, org.id, user.id]);
}
