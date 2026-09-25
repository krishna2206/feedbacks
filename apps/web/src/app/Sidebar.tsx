import { queries } from "@feedbacks/schema/zero";
import { Avatar, avatarColor, Button, Caret, Icon, type IconName, Menu, Tooltip, useMenu } from "@feedbacks/ui";
import { useQuery } from "@rocicorp/zero/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LANGUAGES, setLanguage } from "../i18n";
import { authClient } from "../lib/auth-client";
import { setTheme, useTheme } from "../lib/theme";
import { BrowseChannelsModal, NewDmModal } from "./chat/ChannelModals";
import { NotificationsBell } from "./notifications/NotificationsBell";
import { useOrg } from "./org-context";
import { setSidebar, useSidebar } from "./sidebar-state";
import { openCreateTicket, useProjects } from "./tickets/data";
import { ProjectBadge } from "./tickets/meta";
import { openCommandMenu, openNewChannel, openShortcutsHelp, preloadCommandMenu } from "./ui-state";

function NavLink({
  to,
  params,
  icon,
  label,
  trailing,
  unread,
}: {
  to: string;
  params?: Record<string, string>;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  unread?: boolean;
}) {
  return (
    <Link to={to} params={params} className="nav-link" data-unread={unread || undefined} activeProps={{ "data-active": true } as object}>
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
  const [channels] = useQuery(queries.channels.mine({ organizationId: org.id }));
  const [dms] = useQuery(queries.channels.dms({ organizationId: org.id }));
  const projects = useProjects();
  const [browse, setBrowse] = useState(false);
  const [newDm, setNewDm] = useState(false);
  const wsMenu = useMenu();
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
            <NotificationsBell />
            <Tooltip content={t("nav.search")} shortcut={["⌘", "K"]} placement="bottom">
              <Button
                variant="muted"
                size="md"
                iconOnly
                icon={<Icon name="search" />}
                onClick={openCommandMenu}
                onMouseEnter={preloadCommandMenu}
                aria-label={t("nav.search")}
              />
            </Tooltip>
            <Tooltip content={t("nav.newTicket")} shortcut="C" placement="bottom">
              <Button
                variant="secondary"
                size="md"
                iconOnly
                icon={<Icon name="compose" />}
                onClick={() => openCreateTicket()}
                aria-label={t("nav.newTicket")}
              />
            </Tooltip>
          </div>
        </div>

        <div className="sidebar__scroll">
          <NavLink to="/$orgSlug/tickets" params={{ orgSlug: org.slug }} icon={<Icon name="target" />} label={t("nav.tickets")} />
          <NavLink to="/$orgSlug/docs" params={{ orgSlug: org.slug }} icon={<Icon name="doc" />} label={t("nav.docs")} />

          <Section
            title={t("nav.projects")}
            action={
              <Tooltip content={t("nav.allProjects")} placement="bottom">
                <Button
                  variant="muted"
                  size="sm"
                  iconOnly
                  icon={<Icon name="box" size={14} />}
                  onClick={() => void navigate({ to: "/$orgSlug/projects", params: { orgSlug: org.slug } })}
                  aria-label={t("nav.allProjects")}
                />
              </Tooltip>
            }
          >
            {projects.length === 0 && (
              <Link to="/$orgSlug/projects" params={{ orgSlug: org.slug }} className="nav-link nav-link--button">
                <Icon name="plus" />
                <span className="nav-link__label">{t("nav.noProjects")}</span>
              </Link>
            )}
            {projects.map((p) => (
              <NavLink
                key={p.id}
                to="/$orgSlug/projects/$projectKey"
                params={{ orgSlug: org.slug, projectKey: p.key }}
                icon={<ProjectBadge project={p} size={16} />}
                label={p.name}
              />
            ))}
          </Section>

          <Section
            title={t("nav.channels")}
            action={
              <Tooltip content={t("nav.newChannel")} placement="bottom">
                <Button
                  variant="muted"
                  size="sm"
                  iconOnly
                  icon={<Icon name="plus" size={14} />}
                  onClick={openNewChannel}
                  aria-label={t("nav.newChannel")}
                />
              </Tooltip>
            }
          >
            {channels.map((c) => {
              const unread = Math.max(0, (c.lastSeq ?? 0) - (c.members[0]?.lastReadSeq ?? 0));
              return (
                <NavLink
                  key={c.id}
                  to="/$orgSlug/c/$channelId"
                  params={{ orgSlug: org.slug, channelId: c.id }}
                  icon={<Icon name={channelIcon(c.kind)} />}
                  label={c.name}
                  unread={unread > 0}
                  trailing={unread > 0 ? <span className="nav-link__count">{unread > 99 ? "99+" : unread}</span> : null}
                />
              );
            })}
            <button type="button" className="nav-link nav-link--button" onClick={() => setBrowse(true)}>
              <Icon name="search" />
              <span className="nav-link__label">{t("nav.browseChannels")}</span>
            </button>
          </Section>

          <Section
            title={t("nav.directMessages")}
            action={
              <Tooltip content={t("nav.newDm")} placement="bottom">
                <Button
                  variant="muted"
                  size="sm"
                  iconOnly
                  icon={<Icon name="plus" size={14} />}
                  onClick={() => setNewDm(true)}
                  aria-label={t("nav.newDm")}
                />
              </Tooltip>
            }
          >
            {dms.length === 0 && <div className="nav-empty">{t("nav.noDms")}</div>}
            {dms.map((c) => {
              const mine = c.members.find((m) => m.userId === user.id);
              const others = c.members.filter((m) => m.userId !== user.id).map((m) => m.user);
              const unread = Math.max(0, (c.lastSeq ?? 0) - (mine?.lastReadSeq ?? 0));
              const label = others.map((u) => u?.name ?? "?").join(", ") || user.name;
              return (
                <NavLink
                  key={c.id}
                  to="/$orgSlug/c/$channelId"
                  params={{ orgSlug: org.slug, channelId: c.id }}
                  icon={others.length > 1 ? <Icon name="users" /> : <Avatar user={others[0] ?? null} size={16} />}
                  label={label}
                  unread={unread > 0}
                  trailing={unread > 0 ? <span className="nav-link__badge">{unread > 99 ? "99+" : unread}</span> : null}
                />
              );
            })}
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
            id: "notifications",
            label: t("settings.notifications.title"),
            icon: <Icon name="bell" />,
            onSelect: () => void navigate({ to: "/$orgSlug/settings/notifications", params: { orgSlug: org.slug } }),
          },
          {
            id: "members",
            label: t("members.nav"),
            icon: <Icon name="users" />,
            onSelect: () => void navigate({ to: "/$orgSlug/settings/members", params: { orgSlug: org.slug } }),
          },
          {
            id: "shortcuts",
            label: t("shortcuts.title"),
            icon: <Icon name="cmd" />,
            hint: "?",
            onSelect: openShortcutsHelp,
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
      <BrowseChannelsModal open={browse} onClose={() => setBrowse(false)} />
      <NewDmModal open={newDm} onClose={() => setNewDm(false)} />
    </div>
  );
}
