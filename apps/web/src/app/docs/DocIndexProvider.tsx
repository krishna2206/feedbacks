import { queries } from "@feedbacks/schema/zero";
import { useQuery } from "@rocicorp/zero/react";
import { type ReactNode, useMemo } from "react";
import { useOrg } from "../org-context";
import { type DocIndex, DocIndexContext } from "./data";

/**
 * Titles of the documents the user can read (the tree query, without bodies): renders `<doc:id>`
 * mentions in chat, comments and documents, and feeds the `[[` autocomplete.
 */
export function DocIndexProvider({ children }: { children: ReactNode }) {
  const { org } = useOrg();
  const [docs] = useQuery(queries.docs.list({ organizationId: org.id }));
  const index = useMemo<DocIndex>(() => new Map(docs.map((d) => [d.id, { id: d.id, title: d.title }])), [docs]);
  return <DocIndexContext value={index}>{children}</DocIndexContext>;
}
