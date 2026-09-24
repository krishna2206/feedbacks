import { Button, Icon, Tooltip } from "@feedbacks/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { setSidebar, useSidebar } from "./sidebar-state";

/** 44px view header. Put crumbs/title first, actions after a <span className="spacer" />. */
export function ViewHeader({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { collapsed } = useSidebar();
  return (
    <header className="view-header">
      {collapsed && (
        <Tooltip content={t("nav.showSidebar")} shortcut="[" placement="bottom">
          <Button
            className="sidebar-reveal"
            variant="muted"
            size="sm"
            iconOnly
            icon={<Icon name="sidebar" size={14} />}
            onClick={() => setSidebar({ collapsed: false })}
            aria-label={t("nav.showSidebar")}
          />
        </Tooltip>
      )}
      {children}
    </header>
  );
}
