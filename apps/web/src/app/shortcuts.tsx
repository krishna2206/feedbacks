import { Kbd, Modal } from "@feedbacks/ui";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useGo } from "./go";
import { closeShortcutsHelp, openShortcutsHelp, shortcutsBlocked, toggleCommandMenu, useShortcutsHelpOpen } from "./ui-state";

/**
 * App-wide shortcuts (capture phase, so a "G then P" sequence never reaches a page's own `p` handler):
 *   ⌘K / Ctrl+K  command menu (works everywhere, even while typing)
 *   G then M / P / S / D   My tickets, Projects, Settings, Documents
 *   /  search     ?  shortcuts help
 * Page shortcuts (lists, chat selection, ticket page) are handled by the pages themselves.
 */
export function useGlobalShortcuts() {
  const go = useGo();
  const pendingG = useRef<number | null>(null);
  useEffect(() => {
    const clearG = () => {
      if (pendingG.current) window.clearTimeout(pendingG.current);
      pendingG.current = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleCommandMenu();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || shortcutsBlocked(e)) {
        clearG();
        return;
      }
      const key = e.key.toLowerCase();
      if (pendingG.current) {
        const target = { m: go.myTickets, p: go.projects, s: () => go.settings("notifications"), d: go.docs }[key];
        clearG();
        if (target) {
          e.preventDefault();
          e.stopImmediatePropagation();
          void target();
        }
        return;
      }
      if (key === "g" && !e.shiftKey) {
        pendingG.current = window.setTimeout(clearG, 1200);
      } else if (e.key === "/") {
        e.preventDefault();
        void go.search();
      } else if (e.key === "?") {
        e.preventDefault();
        openShortcutsHelp();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearG();
    };
  }, [go]);
}

const GROUPS: { id: string; items: { keys: string[]; label: string }[] }[] = [
  {
    id: "general",
    items: [
      { keys: ["⌘", "K"], label: "commandMenu" },
      { keys: ["/"], label: "search" },
      { keys: ["C"], label: "newTicket" },
      { keys: ["["], label: "sidebar" },
      { keys: ["?"], label: "help" },
    ],
  },
  {
    id: "navigation",
    items: [
      { keys: ["G", "M"], label: "myTickets" },
      { keys: ["G", "P"], label: "projects" },
      { keys: ["G", "D"], label: "docs" },
      { keys: ["G", "S"], label: "settings" },
    ],
  },
  {
    id: "lists",
    items: [
      { keys: ["J", "K"], label: "move" },
      { keys: ["↵"], label: "open" },
      { keys: ["X"], label: "select" },
      { keys: ["S"], label: "status" },
      { keys: ["P"], label: "priority" },
      { keys: ["A"], label: "assignee" },
      { keys: ["L"], label: "labels" },
      { keys: ["esc"], label: "clear" },
    ],
  },
  {
    id: "chat",
    items: [
      { keys: ["X"], label: "selectMessage" },
      { keys: ["C"], label: "ticketFromSelection" },
      { keys: ["L"], label: "linkSelection" },
      { keys: ["↵"], label: "send" },
      { keys: ["⇧", "↵"], label: "newLine" },
    ],
  },
];

/** `?` — every shortcut, grouped */
export function ShortcutsHelp() {
  const { t } = useTranslation();
  const open = useShortcutsHelpOpen();
  return (
    <Modal open={open} onClose={closeShortcutsHelp} width={560} labelledBy="shortcuts-title">
      <div className="modal__header">
        <h2 id="shortcuts-title" className="shortcuts-title">
          {t("shortcuts.title")}
        </h2>
      </div>
      <div className="modal__body shortcuts">
        {GROUPS.map((g) => (
          <section key={g.id} className="shortcuts__group">
            <h3>{t(`shortcuts.groups.${g.id}`)}</h3>
            {g.items.map((it) => (
              <div key={`${g.id}:${it.label}`} className="shortcuts__row">
                <span>{t(`shortcuts.items.${it.label}`)}</span>
                <span className="shortcuts__keys">
                  {g.id === "navigation" ? (
                    <>
                      <Kbd keys={it.keys[0] as string} />
                      <span className="kbd-then">{t("shortcuts.then")}</span>
                      <Kbd keys={it.keys[1] as string} />
                    </>
                  ) : (
                    <Kbd keys={it.keys} />
                  )}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
