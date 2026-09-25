import { useSyncExternalStore } from "react";

/** Tiny global store (module-level state + useSyncExternalStore), for UI opened from anywhere */
function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const set = (next: T) => {
    if (next === value) return;
    value = next;
    for (const l of listeners) l();
  };
  const use = () =>
    useSyncExternalStore(
      (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      () => value,
      () => initial,
    );
  return { get: () => value, set, use };
}

/* ⌘K — the component and its chunk load on first open (preloaded on hover / idle) */
const commandMenu = createStore(false);
export const openCommandMenu = () => commandMenu.set(true);
export const closeCommandMenu = () => commandMenu.set(false);
export const toggleCommandMenu = () => commandMenu.set(!commandMenu.get());
export const useCommandMenuOpen = commandMenu.use;
export const preloadCommandMenu = () => void import("./cmdk/CommandMenu");

/* Keyboard shortcuts help (`?`) */
const shortcutsHelp = createStore(false);
export const openShortcutsHelp = () => shortcutsHelp.set(true);
export const closeShortcutsHelp = () => shortcutsHelp.set(false);
export const useShortcutsHelpOpen = shortcutsHelp.use;

/* "New channel" dialog (sidebar, command menu) */
const newChannel = createStore(false);
export const openNewChannel = () => newChannel.set(true);
export const closeNewChannel = () => newChannel.set(false);
export const useNewChannelOpen = newChannel.use;

/** True when the key press belongs to a text field or an open overlay: global shortcuts stay quiet */
export function shortcutsBlocked(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return true;
  return !!document.querySelector(".popover, .modal-backdrop, .cmdk-root");
}
