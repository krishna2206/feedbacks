import { useRouteContext } from "@tanstack/react-router";

/** Current organization + signed-in user (resolved in the /$orgSlug route) */
export function useOrg() {
  return useRouteContext({ from: "/$orgSlug" });
}
