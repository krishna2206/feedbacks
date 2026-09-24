import { queries } from "@feedbacks/schema/zero";
import { avatarColor, Button, Caret, Icon, type IconName, Menu, Tooltip, useMenu } from "@feedbacks/ui";
import { useQuery } from "@rocicorp/zero/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LANGUAGES, setLanguage } from "../i18n";
import { authClient } from "../lib/auth-client";
import { setTheme, useTheme } from "../lib/theme";
import { NewChannelModal } from "./NewChannelModal";
import { useOrg } from "./org-context";
import { setSidebar, useSidebar } from "./sidebar-state";

function NavLink({
  to,
  params,
  icon,
  label,
  trailing,
}: {
  to: string;
  params?: Record<string, string>;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
}) {
  return (
    <Link to={to} params={params} className="nav-link" activeProps={{ "data-active": true } as object}>
      {icon}
      <span className="nav-link__label">{label}</span>
      {trailing}
    </Link>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="nav-section">
      <div className="nav-section__row">
        <button type="button" className="nav-section__head" data-open={open} onClick={() => setOpen(!open)}>
          {title}
          <Caret />
        </button>
        {action}
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

export function Sidebar() {
  const { t, i18n } = useTranslation();
  const { org, user } = useOrg();
  const navigate = useNavigate();
  const theme = useTheme();
  const { width, collapsed } = useSidebar();
  const [channels] = useQuery(queries.channels.list({ organizationId: org.id }));
  const wsMenu = useMenu();
  const [newChannel, setNewChannel] = useState(false);
  const [dragging, setDragging] = useState(false);
  const moved = useRef(false);

  const onResizeDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      moved.current = false;
      setDragging(true);
      const startX = e.clientX;
      const onMove = (ev: PointerEvent) => {
        moved.current = true;
        setSidebar({ width: Math.max(192, Math.min(330, width + ev.clientX - startX)) });
      };
      const onUp = () => {
        setDragging(false);
        if (!moved.current) setSidebar({ collapsed: true });
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width],
  );

  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");
  const channelIcon = (kind: string): IconName => (kind === "private" ? "lock" : "hash");

  return (
    <div
      className="sidebar-slot"
      data-collapsed={collapsed}
      data-dragging={dragging}
      inert={collapsed}
      style={{ ["--sb-w" as string]: `${width}px` }}
    >
      <nav className="sidebar" data-surface="sidebar">
        <div className="sidebar__top">
          <button type="button" className="ws-btn" data-active={wsMenu.open} onClick={wsMenu.toggleFrom}>
            <span className="ws-logo" style={{ background: avatarColor(org.id) }}>
              {org.name[0]?.toUpperCase()}
            </span>
            <span className="ws-name truncate">{org.name}</span>
            <Caret />
          </button>
          <div style={{ display: "flex" }}>
            <Tooltip content={`${t("nav.search")} · ${t("common.comingSoon")}`} shortcut={["⌘", "K"]} placement="bottom">
              <Button variant="muted" size="md" iconOnly icon={<Icon name="search" />} aria-label={t("nav.search")} />
            </Tooltip>
            <Tooltip content={`${t("nav.newTicket")} · ${t("common.comingSoon")}`} shortcut="C" placement="bottom">
              <Button variant="secondary" size="md" iconOnly icon={<Icon name="compose" />} aria-label={t("nav.newTicket")} />
            </Tooltip>
          </div>
        </div>

        <div className="sidebar__scroll">
          <NavLink to="/$orgSlug/inbox" params={{ orgSlug: org.slug }} icon={<Icon name="inbox" />} label={t("nav.inbox")} />
          <NavLink to="/$orgSlug/tickets" params={{ orgSlug: org.slug }} icon={<Icon name="target" />} label={t("nav.tickets")} />
          <NavLink to="/$orgSlug/docs" params={{ orgSlug: org.slug }} icon={<Icon name="doc" />} label={t("nav.docs")} />

          <Section
            title={t("nav.channels")}
            action={
              <Tooltip content={t("nav.newChannel")} placement="bottom">
                <Button
                  variant="muted"
                  size="sm"
                  iconOnly
                  icon={<Icon name="plus" size={14} />}
                  onClick={() => setNewChannel(true)}
                  aria-label={t("nav.newChannel")}
                />
              </Tooltip>
            }
          >
            {channels
              .filter((c) => c.kind !== "dm")
              .map((c) => (
                <NavLink
                  key={c.id}
                  to="/$orgSlug/c/$channelId"
                  params={{ orgSlug: org.slug, channelId: c.id }}
                  icon={<Icon name={channelIcon(c.kind)} />}
                  label={c.name}
                />
              ))}
          </Section>
        </div>

        <div className="sidebar__bottom">
          <Tooltip content={theme === "dark" ? t("nav.themeLight") : t("nav.themeDark")} placement="top">
            <Button
              variant="muted"
              size="md"
              iconOnly
              icon={<Icon name={theme === "dark" ? "sun" : "moon"} />}
              onClick={toggleTheme}
              aria-label={t("nav.themeLight")}
            />
          </Tooltip>
          <span className="spacer" />
          <Tooltip content={t("nav.collapseSidebar")} shortcut="[" placement="top">
            <Button
              variant="muted"
              size="md"
              iconOnly
              icon={<Icon name="sidebar" />}
              onClick={() => setSidebar({ collapsed: true })}
              aria-label={t("nav.collapseSidebar")}
            />
          </Tooltip>
        </div>

        <div className="resize-handle" data-dragging={dragging} onPointerDown={onResizeDown} title={t("nav.resizeHint")} />
      </nav>

      <Menu
        anchor={wsMenu.anchor}
        onClose={wsMenu.close}
        width={240}
        header={<div className="menu-group">{user.email}</div>}
        items={[
          {
            id: "members",
            label: t("members.nav"),
            icon: <Icon name="users" />,
            onSelect: () => void navigate({ to: "/$orgSlug/settings/members", params: { orgSlug: org.slug } }),
          },
          { kind: "separator", id: "s0" },
          {
            id: "theme",
            label: theme === "dark" ? t("nav.themeLight") : t("nav.themeDark"),
            icon: <Icon name={theme === "dark" ? "sun" : "moon"} />,
            onSelect: toggleTheme,
          },
          { kind: "group", id: "lang", label: t("nav.language") },
          ...LANGUAGES.map((l) => ({
            id: `lang-${l.code}`,
            label: l.label,
            checked: i18n.language === l.code,
            onSelect: () => setLanguage(l.code),
          })),
          { kind: "separator", id: "s1" },
          {
            id: "signout",
            label: t("auth.signOut"),
            icon: <Icon name="signOut" />,
            onSelect: async () => {
              await authClient.signOut();
              void navigate({ to: "/login" });
            },
          },
        ]}
      />
      <NewChannelModal open={newChannel} onClose={() => setNewChannel(false)} />
    </div>
  );
}
