import { dmChannelId } from "@feedbacks/schema/chat";
import type { TicketStatus } from "@feedbacks/schema/enums";
import { ticketKey } from "@feedbacks/schema/tickets";
import { mutators, queries } from "@feedbacks/schema/zero";
import { Avatar, Icon, type IconName, Kbd, type MenuEntry, toast } from "@feedbacks/ui";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { useLocation } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { LANGUAGES, setLanguage } from "../../i18n";
import { setTheme, useTheme } from "../../lib/theme";
import { useGo } from "../go";
import { useOrg } from "../org-context";
import { useOrgMembers } from "../org-data";
import { matchesQuery, useServerSearch } from "../search/client";
import { Highlighted } from "../search/Highlighted";
import { useTicketActions } from "../tickets/actions";
import { openCreateTicket, useLabels, useProjects, useWritableProjects } from "../tickets/data";
import { ProjectBadge, TicketStatusIcon } from "../tickets/meta";
import { assigneeEntries, labelEntries, priorityEntries, projectEntries, statusEntries } from "../tickets/pickers";
import { closeCommandMenu, openNewChannel, openShortcutsHelp } from "../ui-state";
import "./cmdk.css";
import { pushRecent, type RecentItem, readRecent } from "./recent";

/*
 * ⌘K — one box for commands, navigation and search.
 * - Root page: recent items, context actions (current ticket or channel), create, navigate;
 *   typing filters everything locally (accent-insensitive) and adds tickets / messages / people,
 *   local results first (instant), server full-text results as they arrive.
 * - Sub-pages (status, priority, assignee, labels, project, language) replace the list in the same
 *   box; the chip shows the path, Backspace on an empty input or Escape goes back.
 */

type Page = { id: "root" } | { id: "status" | "priority" | "assignee" | "labels" | "project" } | { id: "language" };

type Item = {
  id: string;
  group: string;
  label: ReactNode;
  /** Text used for filtering (defaults to the label when it's a string) */
  text?: string;
  icon?: ReactNode;
  detail?: ReactNode;
  hint?: ReactNode;
  checked?: boolean;
  /** Keep the box open after running (multi-select sub-pages) */
  keep?: boolean;
  run: () => void;
};

const KEY_RE = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/;
const NONE = "__none__";

function useContextTarget() {
  const { pathname } = useLocation();
  const ticketRef = pathname.match(/^\/[^/]+\/issue\/([^/?#]+)/)?.[1];
  const channelId = pathname.match(/^\/[^/]+\/c\/([^/?#]+)/)?.[1];
  return {
    ticketRef: ticketRef ? decodeURIComponent(ticketRef) : undefined,
    channelId: channelId ? decodeURIComponent(channelId) : undefined,
  };
}

export function CommandMenu({ closing }: { closing: boolean }) {
  const { t, i18n } = useTranslation();
  const { org, user } = useOrg();
  const zero = useZero();
  const go = useGo();
  const theme = useTheme();
  const { sorted: people } = useOrgMembers();
  const projects = useProjects();
  const writable = useWritableProjects();
  const { labels } = useLabels();
  const actions = useTicketActions();
  const ctx = useContextTarget();

  // Context: the ticket or channel on screen
  const keyMatch = ctx.ticketRef?.match(KEY_RE);
  // "_" is never a project key: the unused lookup stays empty
  const [byKey] = useQuery(
    queries.tickets.byKey({
      organizationId: org.id,
      key: keyMatch ? (keyMatch[1] as string).toUpperCase() : "_",
      number: keyMatch ? Number(keyMatch[2]) : 1,
    }),
  );
  const ticketId = keyMatch ? byKey?.id : ctx.ticketRef;
  const [ticket] = useQuery(queries.tickets.get({ organizationId: org.id, ticketId: ticketId ?? NONE }));
  const [channel] = useQuery(queries.channels.get({ organizationId: org.id, channelId: ctx.channelId ?? NONE }));
  const [channels] = useQuery(queries.channels.mine({ organizationId: org.id }));
  const [dms] = useQuery(queries.channels.dms({ organizationId: org.id }));
  const [recentTickets] = useQuery(queries.tickets.recent({ organizationId: org.id, limit: 200 }));

  const [pages, setPages] = useState<Page[]>([{ id: "root" }]);
  const page = pages[pages.length - 1] as Page;
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [recent] = useState(() => readRecent(org.id));

  const close = useCallback(() => closeCommandMenu(), []);
  const pulse = () =>
    boxRef.current?.animate([{ transform: "scale(1)" }, { transform: "scale(.98)" }, { transform: "scale(1)" }], {
      duration: 160,
      easing: "ease-out",
    });
  const push = (p: Page) => {
    setPages((s) => [...s, p]);
    setQuery("");
    setFocused(0);
    pulse();
  };
  const back = () => {
    if (pages.length > 1) {
      setPages((s) => s.slice(0, -1));
      setQuery("");
      setFocused(0);
    } else close();
  };

  const tKey = ticket?.project ? ticketKey(ticket.project.key, ticket.number) : null;
  const visit = (r: RecentItem, then: () => unknown) => () => {
    pushRecent(org.id, r);
    close();
    void then();
  };
  const openTicket = (ref: string, title: string, status: string) => visit({ type: "ticket", ref, title, status }, () => go.ticket(ref));
  const openChannel = (c: { id: string; name: string; kind: string }) => visit({ type: "channel", ...c }, () => go.channel(c.id));
  const openProject = (p: { key: string; name: string; color: string }) => visit({ type: "project", ...p }, () => go.project(p.key));
  const openDm = (p: { id: string; name: string }) =>
    visit({ type: "person", ...p }, () => {
      zero.mutate(mutators.channels.openDm({ organizationId: org.id, userIds: [p.id], at: Date.now() }));
      return go.channel(dmChannelId(org.id, [user.id, p.id]));
    });

  const copy = (text: string, message: string) => () => {
    void navigator.clipboard.writeText(text);
    toast({ title: message });
    close();
  };
  const fromEntries = (group: string, entries: MenuEntry[], keep = false): Item[] =>
    entries.flatMap((e) =>
      e.kind === "separator" || e.kind === "group"
        ? []
        : [
            {
              id: `${group}:${e.id}`,
              group,
              label: e.label,
              text: `${e.label} ${e.keywords ?? ""}`,
              icon: e.icon,
              hint: e.hint,
              checked: e.checked,
              keep,
              run: () => {
                e.onSelect();
                if (!keep) close();
              },
            },
          ],
    );

  /* ----------------------------- Items ----------------------------- */
  const q = query.trim();
  const server = useServerSearch(org.id, page.id === "root" ? q : "", { types: ["ticket", "comment", "message"], limit: 12 });

  // Rebuilt on every render: a few hundred items at most, cheaper than tracking every input
  const items: Item[] = (() => {
    const g = (k: string) => t(`cmdk.groups.${k}`);
    const icon = (name: IconName) => <Icon name={name} size={16} />;
    if (page.id !== "root") {
      if (page.id === "language")
        return LANGUAGES.map((l) => ({
          id: `lang:${l.code}`,
          group: g("language"),
          label: l.label,
          checked: i18n.language === l.code,
          run: () => {
            setLanguage(l.code);
            close();
          },
        }));
      if (!ticket) return [];
      const ids = [ticket.id];
      if (page.id === "status")
        return fromEntries(
          g("status"),
          statusEntries(t, ticket.status, (status) => actions.update(ids, { status })),
        );
      if (page.id === "priority")
        return fromEntries(
          g("priority"),
          priorityEntries(t, ticket.priority ?? 0, (priority) => actions.update(ids, { priority })),
        );
      if (page.id === "assignee")
        return fromEntries(
          g("assignee"),
          assigneeEntries(t, people, ticket.assigneeId, user.id, (assigneeId) => actions.update(ids, { assigneeId })),
        );
      if (page.id === "project")
        return fromEntries(
          g("project"),
          projectEntries(
            writable.filter((p) => p.id !== ticket.projectId),
            ticket.projectId,
            (projectId) => actions.move(ticket.id, projectId),
          ),
        );
      const current = ticket.labels.map((l) => l.labelId);
      return fromEntries(
        g("labels"),
        labelEntries(labels, current, (labelId) =>
          actions.setLabels(ticket.id, current.includes(labelId) ? current.filter((l) => l !== labelId) : [...current, labelId]),
        ),
        true,
      );
    }

    const list: Item[] = [];
    // Recent (empty query only)
    if (!q)
      for (const r of recent) {
        if (r.type === "ticket")
          list.push({
            id: `recent:t:${r.ref}`,
            group: g("recent"),
            label: r.title,
            icon: <TicketStatusIcon status={r.status as TicketStatus} size={16} />,
            hint: <span className="tabular">{r.ref}</span>,
            run: openTicket(r.ref, r.title, r.status),
          });
        else if (r.type === "channel")
          list.push({
            id: `recent:c:${r.id}`,
            group: g("recent"),
            label: r.kind === "dm" ? r.name : `#${r.name}`,
            icon: icon(r.kind === "private" ? "lock" : r.kind === "dm" ? "chat" : "hash"),
            run: openChannel(r),
          });
        else if (r.type === "project")
          list.push({
            id: `recent:p:${r.key}`,
            group: g("recent"),
            label: r.name,
            icon: <ProjectBadge project={r} />,
            run: openProject(r),
          });
        else list.push({ id: `recent:u:${r.id}`, group: g("recent"), label: r.name, icon: icon("chat"), run: openDm(r) });
      }

    // Context
    if (ticket && tKey) {
      const ctxGroup = g("ticket");
      list.push(
        {
          id: "ctx:status",
          group: ctxGroup,
          label: t("cmdk.changeStatus"),
          icon: icon("circleDashed"),
          hint: <Kbd keys="S" />,
          keep: true,
          run: () => push({ id: "status" }),
        },
        {
          id: "ctx:priority",
          group: ctxGroup,
          label: t("cmdk.changePriority"),
          icon: icon("sliders"),
          hint: <Kbd keys="P" />,
          keep: true,
          run: () => push({ id: "priority" }),
        },
        {
          id: "ctx:assignee",
          group: ctxGroup,
          label: t("cmdk.assign"),
          icon: icon("user"),
          hint: <Kbd keys="A" />,
          keep: true,
          run: () => push({ id: "assignee" }),
        },
        {
          id: "ctx:labels",
          group: ctxGroup,
          label: t("cmdk.changeLabels"),
          icon: icon("tag"),
          hint: <Kbd keys="L" />,
          keep: true,
          run: () => push({ id: "labels" }),
        },
        {
          id: "ctx:project",
          group: ctxGroup,
          label: t("cmdk.moveProject"),
          icon: icon("box"),
          keep: true,
          run: () => push({ id: "project" }),
        },
        {
          id: "ctx:copyKey",
          group: ctxGroup,
          label: t("cmdk.copyKey", { key: tKey }),
          icon: icon("copy"),
          run: copy(tKey, t("tickets.keyCopied", { key: tKey })),
        },
        {
          id: "ctx:copyLink",
          group: ctxGroup,
          label: t("cmdk.copyLink"),
          icon: icon("link"),
          run: copy(`${location.origin}/${org.slug}/issue/${tKey}`, t("cmdk.linkCopied")),
        },
      );
    }
    if (channel) {
      const ctxGroup = g("channel");
      list.push({
        id: "ctx:newTicket",
        group: ctxGroup,
        label: channel.kind === "dm" ? t("cmdk.newTicketHere") : t("cmdk.newTicketFrom", { name: channel.name }),
        icon: icon("ticket"),
        run: () => {
          close();
          openCreateTicket({ projectId: channel.projectId ?? undefined });
        },
      });
      list.push({
        id: "ctx:markRead",
        group: ctxGroup,
        label: t("cmdk.markChannelRead"),
        icon: icon("check"),
        run: () => {
          zero.mutate(mutators.channels.markRead({ channelId: channel.id, seq: channel.lastSeq ?? 0, at: Date.now() }));
          close();
        },
      });
    }

    // Create
    list.push(
      {
        id: "create:ticket",
        group: g("create"),
        label: t("nav.newTicket"),
        icon: icon("compose"),
        hint: <Kbd keys="C" />,
        run: () => {
          close();
          openCreateTicket();
        },
      },
      {
        id: "create:channel",
        group: g("create"),
        label: t("nav.newChannel"),
        icon: icon("hash"),
        run: () => {
          close();
          openNewChannel();
        },
      },
    );

    // Navigate
    const nav = g("navigate");
    const goTo = (then: () => unknown) => () => {
      close();
      void then();
    };
    list.push(
      {
        id: "nav:tickets",
        group: nav,
        label: t("nav.myTickets"),
        icon: icon("target"),
        hint: <Kbd keys={["G", "M"]} />,
        run: goTo(go.myTickets),
      },
      {
        id: "nav:projects",
        group: nav,
        label: t("nav.allProjects"),
        icon: icon("box"),
        hint: <Kbd keys={["G", "P"]} />,
        run: goTo(go.projects),
      },
      {
        id: "nav:search",
        group: nav,
        label: t("search.title"),
        icon: icon("search"),
        hint: <Kbd keys="/" />,
        run: goTo(() => go.search(q || undefined)),
      },
      { id: "nav:docs", group: nav, label: t("nav.docs"), icon: icon("doc"), run: goTo(go.docs) },
      {
        id: "nav:settings",
        group: nav,
        label: t("settings.notifications.title"),
        text: `${t("settings.title")} ${t("settings.notifications.title")}`,
        icon: icon("settings"),
        hint: <Kbd keys={["G", "S"]} />,
        run: goTo(() => go.settings("notifications")),
      },
      {
        id: "nav:members",
        group: nav,
        label: t("members.title"),
        text: `${t("settings.title")} ${t("members.title")}`,
        icon: icon("users"),
        run: goTo(() => go.settings("members")),
      },
      {
        id: "nav:theme",
        group: nav,
        label: theme === "dark" ? t("nav.themeLight") : t("nav.themeDark"),
        icon: icon(theme === "dark" ? "sun" : "moon"),
        run: () => {
          setTheme(theme === "dark" ? "light" : "dark");
          close();
        },
      },
      {
        id: "nav:language",
        group: nav,
        label: t("cmdk.changeLanguage"),
        icon: icon("language"),
        keep: true,
        run: () => push({ id: "language" }),
      },
      {
        id: "nav:shortcuts",
        group: nav,
        label: t("shortcuts.title"),
        icon: icon("cmd"),
        hint: <Kbd keys="?" />,
        run: () => {
          close();
          openShortcutsHelp();
        },
      },
    );
    // Projects, channels and people only appear when typing (the list stays short)
    if (q) {
      for (const p of projects)
        list.push({
          id: `project:${p.id}`,
          group: nav,
          label: p.name,
          text: `${p.name} ${p.key}`,
          icon: <ProjectBadge project={p} />,
          hint: <span className="tabular">{p.key}</span>,
          run: openProject(p),
        });
      for (const c of channels)
        list.push({
          id: `channel:${c.id}`,
          group: nav,
          label: `#${c.name}`,
          text: c.name,
          icon: icon(c.kind === "private" ? "lock" : "hash"),
          run: openChannel(c),
        });
      for (const c of dms) {
        const others = c.members.filter((m) => m.userId !== user.id).map((m) => m.user?.name ?? "?");
        const name = others.join(", ") || user.name;
        list.push({ id: `dm:${c.id}`, group: nav, label: name, icon: icon("chat"), run: openChannel({ id: c.id, name, kind: "dm" }) });
      }
      for (const p of people)
        if (p.id !== user.id)
          list.push({
            id: `person:${p.id}`,
            group: g("people"),
            label: p.name,
            text: `${p.name} ${p.email}`,
            icon: <Avatar user={p} size={16} />,
            detail: t("cmdk.sendMessage"),
            run: openDm(p),
          });
    }

    const filtered = q ? list.filter((i) => matchesQuery(i.text ?? (typeof i.label === "string" ? i.label : ""), q)) : list;

    if (q) {
      // Tickets: local matches first (instant), then server results (full text, comments)
      const tickets = g("tickets");
      const seen = new Set<string>();
      for (const tk of recentTickets) {
        if (seen.size >= 6) break;
        const key = ticketKey(tk.project?.key ?? "?", tk.number);
        if (!matchesQuery(`${key} ${tk.project?.key ?? ""} ${tk.number} ${tk.title}`, q)) continue;
        seen.add(tk.id);
        filtered.push({
          id: `ticket:${tk.id}`,
          group: tickets,
          label: tk.title,
          icon: <TicketStatusIcon status={tk.status} size={16} />,
          hint: <span className="tabular">{key}</span>,
          run: openTicket(key, tk.title, tk.status),
        });
      }
      for (const r of server.results) {
        if ((r.kind === "ticket" || r.kind === "comment") && r.ticket && !seen.has(r.ticket.id) && seen.size < 8) {
          seen.add(r.ticket.id);
          filtered.push({
            id: `sticket:${r.ticket.id}`,
            group: tickets,
            label: r.title ? <Highlighted text={r.title} /> : r.ticket.title,
            detail: r.kind === "comment" && r.snippet ? <Highlighted text={r.snippet} /> : undefined,
            icon: <TicketStatusIcon status={r.ticket.status as TicketStatus} size={16} />,
            hint: <span className="tabular">{r.ticket.key}</span>,
            run: openTicket(r.ticket.key, r.ticket.title, r.ticket.status),
          });
        }
      }
      let messages = 0;
      for (const r of server.results) {
        if (r.kind !== "message" || !r.channel || messages >= 6) continue;
        messages++;
        const ch = r.channel;
        const where = ch.kind === "dm" ? t("notifications.directMessage") : `#${ch.name}`;
        filtered.push({
          id: `message:${r.entityId}`,
          group: g("messages"),
          label: <Highlighted text={r.snippet} />,
          detail: `${where} · ${r.author?.name ?? ""}`,
          icon: icon("chat"),
          run: () => {
            close();
            void go.channel(ch.id, r.entityId, r.parentId);
          },
        });
      }
    }
    return filtered;
  })();

  // Sub-page filtering (root page is filtered above, with server results)
  const shown = page.id === "root" || !q ? items : items.filter((i) => matchesQuery(i.text ?? String(i.label), q));

  useEffect(() => {
    setFocused((f) => Math.min(f, Math.max(0, shown.length - 1)));
  }, [shown.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${focused}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus the input whenever a sub-page opens or closes
  useEffect(() => {
    inputRef.current?.focus();
  }, [page]);

  const select = (item: Item | undefined) => {
    if (!item) return;
    item.run();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setFocused((f) => (f + 1) % Math.max(1, shown.length));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setFocused((f) => (f - 1 + shown.length) % Math.max(1, shown.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      select(shown[focused]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      back();
    } else if (e.key === "Backspace" && !query && pages.length > 1) {
      e.preventDefault();
      back();
    }
  };

  const pageTitle = page.id === "root" ? null : t(`cmdk.groups.${page.id}`);
  const chip = [
    page.id !== "language" && tKey
      ? `${tKey} — ${ticket?.title ?? ""}`
      : channel && page.id === "root"
        ? channel.kind === "dm"
          ? t("notifications.directMessage")
          : `#${channel.name}`
        : null,
    pageTitle,
  ]
    .filter(Boolean)
    .join(" › ");

  let lastGroup = "";
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the menu
    <div className="cmdk-root" data-closing={closing || undefined} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={boxRef} className="cmdk" data-surface="menu" role="dialog" aria-modal aria-label={t("cmdk.label")} onKeyDown={onKeyDown}>
        {chip && <div className="cmdk-chip truncate">{chip}</div>}
        <div className="cmdk-input">
          {pages.length > 1 && (
            <button type="button" className="cmdk-back" onClick={back} aria-label={t("common.back")}>
              <Icon name="arrowLeft" size={14} />
            </button>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setFocused(0);
            }}
            placeholder={page.id === "root" ? t("cmdk.placeholder") : t("cmdk.filterPlaceholder")}
            aria-label={t("cmdk.placeholder")}
            spellCheck={false}
            autoComplete="off"
          />
          {server.loading && <span className="cmdk-spinner" aria-hidden />}
        </div>
        <div className="cmdk-list" ref={listRef} role="listbox">
          {shown.map((item, idx) => {
            const header = item.group !== lastGroup ? <div className="cmdk-group">{item.group}</div> : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard navigation is handled by the dialog (arrows + Enter) */}
                <div
                  className="cmdk-item"
                  role="option"
                  tabIndex={-1}
                  aria-selected={idx === focused}
                  data-idx={idx}
                  data-focused={idx === focused}
                  onMouseMove={() => idx !== focused && setFocused(idx)}
                  onClick={() => select(item)}
                >
                  <span className="cmdk-item__icon">{item.icon}</span>
                  <span className="cmdk-item__text">
                    <span className="cmdk-item__label truncate">{item.label}</span>
                    {item.detail && <span className="cmdk-item__detail truncate">{item.detail}</span>}
                  </span>
                  {item.checked !== undefined && (
                    <span className="cmdk-item__check">{item.checked && <Icon name="check" size={14} />}</span>
                  )}
                  {item.hint && <span className="cmdk-item__hint">{item.hint}</span>}
                </div>
              </div>
            );
          })}
          {shown.length === 0 && (
            <div className="cmdk-empty">{server.loading ? t("common.loading") : q ? t("cmdk.noResults") : t("cmdk.nothing")}</div>
          )}
        </div>
        <div className="cmdk-foot">
          <span>
            <Kbd keys={["↑", "↓"]} /> {t("cmdk.footNavigate")}
          </span>
          <span>
            <Kbd keys="↵" /> {t("cmdk.footOpen")}
          </span>
          <span>
            <Kbd keys="esc" /> {pages.length > 1 ? t("common.back") : t("common.close")}
          </span>
          {page.id === "root" && q && (
            <button
              type="button"
              className="cmdk-foot__link"
              onClick={() => {
                close();
                void go.search(q);
              }}
            >
              {t("cmdk.allResults")} <Icon name="arrowRight" size={12} />
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
