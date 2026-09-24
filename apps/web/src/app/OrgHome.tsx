import { queries } from "@feedbacks/schema/zero";
import { useQuery } from "@rocicorp/zero/react";
import { Navigate } from "@tanstack/react-router";
import { useOrg } from "./org-context";

/** /$orgSlug → the #general channel (or the first visible one) once channels are synced */
export function OrgHome() {
  const { org } = useOrg();
  const [channels, result] = useQuery(queries.channels.list({ organizationId: org.id }));
  const target = channels.find((c) => c.name === "general") ?? channels[0];
  if (target) return <Navigate to="/$orgSlug/c/$channelId" params={{ orgSlug: org.slug, channelId: target.id }} replace />;
  return result.type === "complete" ? <div className="empty" /> : null;
}
