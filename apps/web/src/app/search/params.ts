/* Search page URL parameters (kept out of the page chunk: the router imports this) */

export type SearchParams = {
  q?: string;
  type?: "message" | "ticket" | "comment";
  channel?: string;
  project?: string;
  author?: string;
  range?: "7d" | "30d" | "365d";
};

export function validateSearchParams(s: Record<string, unknown>): SearchParams {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    q: str(s.q),
    type: s.type === "message" || s.type === "ticket" || s.type === "comment" ? s.type : undefined,
    channel: str(s.channel),
    project: str(s.project),
    author: str(s.author),
    range: s.range === "7d" || s.range === "30d" || s.range === "365d" ? s.range : undefined,
  };
}
