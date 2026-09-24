import { mutators, schema } from "@feedbacks/schema/zero";
import { ZeroProvider } from "@rocicorp/zero/react";
import { Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import "./layout.css";
import { useOrg } from "./org-context";
import { Sidebar } from "./Sidebar";
import { setSidebar, useSidebar } from "./sidebar-state";

/** Signed-in app shell. Zero syncs through the same origin: /sync → zero-cache (cookies forwarded). */
export function OrgLayout() {
  const { user } = useOrg();
  const { collapsed } = useSidebar();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[") setSidebar({ collapsed: !collapsed });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed]);

  return (
    <ZeroProvider userID={user.id} context={{ userID: user.id }} cacheURL={`${location.origin}/sync`} schema={schema} mutators={mutators}>
      <div className="app-root">
        <div className="app" data-sidebar-collapsed={collapsed}>
          <Sidebar />
          <main className="main">
            <Outlet />
          </main>
        </div>
      </div>
    </ZeroProvider>
  );
}
