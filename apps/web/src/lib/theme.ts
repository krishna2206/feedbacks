import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
const listeners = new Set<() => void>();

export const getTheme = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("theme", theme);
  } catch {}
  for (const l of listeners) l();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getTheme,
    () => "dark",
  );
}
