import { mutators, schema } from "@feedbacks/schema/zero";
import { ZeroProvider } from "@rocicorp/zero/react";
import { Outlet } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import "./layout.css";
import { NewChannelModal } from "./NewChannelModal";
import { useNotificationEffects } from "./notifications/effects";
import { useOrg } from "./org-context";
import { Sidebar } from "./Sidebar";
import { ShortcutsHelp, useGlobalShortcuts } from "./shortcuts";
import { setSidebar, useSidebar } from "./sidebar-state";
import { openCreateTicket, useCreateTicketDraft } from "./tickets/data";
import { closeNewChannel, preloadCommandMenu, shortcutsBlocked, useCommandMenuOpen, useNewChannelOpen } from "./ui-state";

// Dialogs (and their chunks) load the first time they're opened
const CreateTicketModal = lazy(() => import("./tickets/CreateTicketModal").then((m) => ({ default: m.CreateTicketModal })));
const CommandMenu = lazy(() => import("./cmdk/CommandMenu").then((m) => ({ default: m.CommandMenu })));

/** Signed-in app shell. Zero syncs through the same origin: /sync → zero-cache (cookies forwarded). */
export function OrgLayout() {
  const { user } = useOrg();
  return (
    <ZeroProvider userID={user.id} context={{ userID: user.id }} cacheURL={`${location.origin}/sync`} schema={schema} mutators={mutators}>
      <Shell />
    </ZeroProvider>
  );
}

function Shell() {
  const { collapsed } = useSidebar();
  const draft = useCreateTicketDraft();
  const newChannel = useNewChannelOpen();
  useGlobalShortcuts();
  useNotificationEffects();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || shortcutsBlocked(e)) return;
      if (e.key === "[") setSidebar({ collapsed: !collapsed });
      // `c` = new ticket, except where a page handles it (channel selection, project page)
      else if (e.key === "c" && !/\/(c|projects)\//.test(location.pathname)) {
        e.preventDefault();
        openCreateTicket();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed]);

  // The command menu chunk is fetched while the browser is idle, so ⌘K opens instantly
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 2000));
    idle(() => preloadCommandMenu());
  }, []);

  return (
    <div className="app-root">
      <div className="app" data-sidebar-collapsed={collapsed}>
        <Sidebar />
        <main className="main">
          <Outlet />
        </main>
        {draft && (
          <Suspense fallback={null}>
            <CreateTicketModal />
          </Suspense>
        )}
        <CommandMenuHost />
        <ShortcutsHelp />
        <NewChannelModal open={newChannel} onClose={closeNewChannel} />
      </div>
    </div>
  );
}

/** Keeps the menu mounted ~120 ms after closing, for its exit animation */
function CommandMenuHost() {
  const open = useCommandMenuOpen();
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), 120);
    return () => window.clearTimeout(timer);
  }, [open]);
  if (!mounted && !open) return null;
  return (
    <Suspense fallback={null}>
      <CommandMenu closing={!open} />
    </Suspense>
  );
}
