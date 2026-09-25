import { useEffect, useRef, useState } from "react";

/** One result of `GET /api/search` (see apps/api/src/routes/search.ts) */
export type SearchResult = {
  id: string;
  kind: "message" | "ticket" | "comment" | "doc";
  entityId: string;
  createdAt: number;
  /** Excerpt with \uE000…\uE001 around matches (render with <Highlighted>) */
  snippet: string;
  /** Highlighted ticket title (tickets and comments) */
  title: string;
  author: { id: string; name: string } | null;
  channel: { id: string; name: string; kind: string } | null;
  doc?: { id: string; title: string; folderId: string | null } | null;
  parentId: string | null;
  ticket: { id: string; key: string; title: string; status: string } | null;
  project: { id: string; key: string; name: string; color: string } | null;
};

export type SearchFilters = {
  types?: SearchResult["kind"][];
  channelId?: string;
  projectId?: string;
  authorId?: string;
  from?: number;
  to?: number;
  limit?: number;
};

export async function searchApi(organizationId: string, q: string, filters: SearchFilters, signal?: AbortSignal) {
  const params = new URLSearchParams({ organizationId, q });
  if (filters.types?.length) params.set("types", filters.types.join(","));
  for (const key of ["channelId", "projectId", "authorId", "from", "to", "limit"] as const) {
    const v = filters[key];
    if (v !== undefined && v !== "") params.set(key, String(v));
  }
  const res = await fetch(`/api/search?${params}`, { signal, credentials: "same-origin" });
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  return ((await res.json()) as { results: SearchResult[] }).results;
}

/**
 * Debounced server search (120 ms by default): stale requests are aborted, so results always
 * match the latest query. `results` stays on the previous answer while the next one loads.
 */
export function useServerSearch(organizationId: string, q: string, filters: SearchFilters = {}, delay = 120) {
  const [state, setState] = useState<{ q: string; results: SearchResult[]; loading: boolean; error: boolean }>({
    q: "",
    results: [],
    loading: false,
    error: false,
  });
  const key = JSON.stringify(filters);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // biome-ignore lint/correctness/useExhaustiveDependencies: filters are compared by value through `key`
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setState({ q: "", results: [], loading: false, error: false });
      return;
    }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      searchApi(organizationId, query, filtersRef.current, ctrl.signal)
        .then((results) => setState({ q: query, results, loading: false, error: false }))
        .catch((e: unknown) => {
          if ((e as Error).name !== "AbortError") setState((s) => ({ ...s, loading: false, error: true }));
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [organizationId, q, key, delay]);
  return state;
}

/** Accent/case folding for local (client-side) filtering */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** True when every word of `query` starts a word of `text` (same rule as the server) */
export function matchesQuery(text: string, query: string) {
  const words = fold(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!words.length) return true;
  const hay = fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return words.every((w) => hay.some((h) => h.startsWith(w)));
}
