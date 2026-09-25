/** Recently opened items of the command menu, per organization (localStorage, best effort) */
export type RecentItem =
  | { type: "ticket"; ref: string; title: string; status: string }
  | { type: "channel"; id: string; name: string; kind: string }
  | { type: "project"; key: string; name: string; color: string }
  | { type: "person"; id: string; name: string };

const MAX = 6;
const storageKey = (orgId: string) => `feedbacks.recent.${orgId}`;
const idOf = (r: RecentItem) => (r.type === "ticket" ? `t:${r.ref}` : r.type === "project" ? `p:${r.key}` : `${r.type[0]}:${r.id}`);

export function readRecent(orgId: string): RecentItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(orgId)) ?? "[]");
    return Array.isArray(raw) ? (raw as RecentItem[]).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function pushRecent(orgId: string, item: RecentItem) {
  try {
    const list = [item, ...readRecent(orgId).filter((r) => idOf(r) !== idOf(item))].slice(0, MAX);
    localStorage.setItem(storageKey(orgId), JSON.stringify(list));
  } catch {}
}
