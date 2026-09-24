import { useSyncExternalStore } from "react";

/** Sidebar width / collapsed state, persisted per browser */
type State = { width: number; collapsed: boolean };
const read = (): State => {
  try {
    return { width: 244, collapsed: false, ...JSON.parse(localStorage.getItem("sidebar") ?? "{}") };
  } catch {
    return { width: 244, collapsed: false };
  }
};
let state = read();
const listeners = new Set<() => void>();

export function setSidebar(patch: Partial<State>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem("sidebar", JSON.stringify(state));
  } catch {}
  for (const l of listeners) l();
}

export function useSidebar() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
