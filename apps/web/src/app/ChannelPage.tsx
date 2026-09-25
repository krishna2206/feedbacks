import { canEditTickets, parseAlreadyLinked, ticketKey } from "@feedbacks/schema/tickets";
import { mutators, queries } from "@feedbacks/schema/zero";
import { Avatar, Button, Icon, Menu, type MenuEntry, Tooltip, toast, useMenu } from "@feedbacks/ui";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./chat.css";
import { ChannelMembersModal, ChannelSettingsModal } from "./chat/ChannelModals";
import { Composer, type ComposerHandle } from "./chat/Composer";
import { MessageList } from "./chat/MessageList";
import type { MessageData } from "./chat/MessageRow";
import { type ChatSelection, ChatSelectionContext, withFollowingCaptures } from "./chat/selection";
import { ThreadPanel } from "./chat/ThreadPanel";
import { useOrg } from "./org-context";
import { type OrgUser, useOrgMembers } from "./org-data";
import { useTicketActions } from "./tickets/actions";
import { openCreateTicket, useProjectRoles, useProjects } from "./tickets/data";
import { TicketStatusIcon } from "./tickets/meta";
import { ViewHeader } from "./ViewHeader";

const PAGE = 100;

export function ChannelPage() {
  const { channelId } = useParams({ from: "/$orgSlug/c/$channelId" });
  const search = useSearch({ from: "/$orgSlug/c/$channelId" });
  // Remount per channel: scroll position, pagination and "new messages" divider start fresh
  return <ChannelView key={channelId} channelId={channelId} threadId={search.thread} highlightId={search.m} />;
}

function ChannelView({ channelId, threadId, highlightId }: { channelId: string; threadId?: string; highlightId?: string }) {
  const { t } = useTranslation();
  const zero = useZero();
  const navigate = useNavigate();
  const { org, user } = useOrg();
  const { users, sorted, isAdmin } = useOrgMembers();
  const [channel, channelResult] = useQuery(queries.channels.get({ organizationId: org.id, channelId }));
  const [limit, setLimit] = useState(PAGE);
  const [latest] = useQuery(queries.messages.byChannel({ organizationId: org.id, channelId, limit }));
  const messages = useMemo(() => [...latest].reverse() as MessageData[], [latest]);
  const composer = useRef<ComposerHandle>(null);
  const moreMenu = useMenu();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  /* ---------- Messages → tickets: selection, "unprocessed" tab, link to a ticket ---------- */
  const projects = useProjects();
  const roleOf = useProjectRoles();
  const canTicket = useMemo(() => projects.some((p) => canEditTickets(roleOf(p))), [projects, roleOf]);
  const [tab, setTab] = useState<"all" | "unprocessed">("all");
  const [unprocessedRows] = useQuery(canTicket ? queries.messages.unprocessed({ organizationId: org.id, channelId }) : undefined);
  const unprocessed = useMemo(() => [...(unprocessedRows ?? [])].reverse() as MessageData[], [unprocessedRows]);
  const shown = tab === "unprocessed" ? unprocessed : messages;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchorId = useRef<string | null>(null);
  const hovered = useRef<string | null>(null);
  const linkBtn = useRef<HTMLButtonElement>(null);
  const linkMenu = useMenu();
  const actions = useTicketActions();
  const orderedSelection = useCallback(() => shown.filter((m) => selected.has(m.id)).map((m) => m.id), [shown, selected]);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const selection = useMemo<ChatSelection>(
    () => ({
      enabled: canTicket,
      selected,
      toggle: (id, mods) =>
        setSelected((cur) => {
          const next = new Set(cur);
          const ids = shown.map((m) => m.id);
          if (mods?.shiftKey && anchorId.current && ids.includes(anchorId.current) && ids.includes(id)) {
            const [a, b] = [ids.indexOf(anchorId.current), ids.indexOf(id)];
            for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
          } else if (next.has(id)) next.delete(id);
          else next.add(id);
          anchorId.current = id;
          return next;
        }),
      createFrom: (id) =>
        openCreateTicket({
          sourceMessageIds: withFollowingCaptures(shown, id),
          projectId: channel?.projectId ?? undefined,
          onCreated: clearSelection,
        }),
      hover: (id) => {
        hovered.current = id;
      },
    }),
    [canTicket, selected, shown, channel?.projectId, clearSelection],
  );

  const createFromSelection = useCallback(() => {
    const ids = orderedSelection();
    if (ids.length) openCreateTicket({ sourceMessageIds: ids, projectId: channel?.projectId ?? undefined, onCreated: clearSelection });
  }, [orderedSelection, channel?.projectId, clearSelection]);

  const [recent] = useQuery(canTicket && linkMenu.open ? queries.tickets.recent({ organizationId: org.id, limit: 200 }) : undefined);
  const linkTo = useCallback(
    (ticket: { id: string; number: number; project?: { key: string } | null }, force = false) => {
      const ids = orderedSelection();
      const key = ticket.project ? ticketKey(ticket.project.key, ticket.number) : "";
      const w = actions.linkMessages(ticket.id, ids, force);
      clearSelection();
      void w.server.then((r) => {
        if (r.type !== "error") return toast({ title: t("chat.linkedToast", { key, count: ids.length }) });
        const links = parseAlreadyLinked(r.error.message);
        if (!links) return toast({ tone: "error", title: t("tickets.updateFailed"), description: r.error.message });
        toast(
          {
            tone: "error",
            title: t("tickets.alreadyLinkedTitle", { count: links.length }),
            action: { label: t("chat.linkAnyway"), onClick: () => void actions.linkMessages(ticket.id, ids, true) },
          },
          8000,
        );
      });
    },
    [orderedSelection, actions, clearSelection, t],
  );
  const linkEntries: MenuEntry[] = (recent ?? [])
    .filter((x) => canEditTickets(roleOf(projects.find((p) => p.id === x.projectId))))
    .map((x) => ({
      id: x.id,
      label: x.title,
      keywords: x.project ? ticketKey(x.project.key, x.number) : "",
      icon: <TicketStatusIcon status={x.status} />,
      hint: <span className="tabular">{x.project ? ticketKey(x.project.key, x.number) : ""}</span>,
      onSelect: () => linkTo(x),
    }));

  // Selection shortcuts (outside text fields): x toggle hovered · C create · L link · Esc clear
  const live = useRef({
    selected,
    createFromSelection,
    toggle: selection.toggle,
    clearSelection,
    projectId: channel?.projectId ?? undefined,
  });
  live.current = { selected, createFromSelection, toggle: selection.toggle, clearSelection, projectId: channel?.projectId ?? undefined };
  useEffect(() => {
    if (!canTicket) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      if (document.querySelector(".popover, .modal-backdrop")) return;
      const L = live.current;
      if (e.key === "x" && hovered.current) {
        e.preventDefault();
        L.toggle(hovered.current);
      } else if (e.key === "Escape" && L.selected.size) {
        e.preventDefault();
        L.clearSelection();
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        if (L.selected.size) L.createFromSelection();
        else openCreateTicket({ projectId: L.projectId });
      } else if ((e.key === "l" || e.key === "L") && L.selected.size && linkBtn.current) {
        e.preventDefault();
        linkMenu.openFrom(linkBtn.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canTicket, linkMenu]);

  const selMessages = shown.filter((m) => selected.has(m.id));
  const alreadyLinked = selMessages.filter((m) => (m.ticketSources?.length ?? 0) > 0);
  const linkedKeys = [
    ...new Set(
      alreadyLinked.flatMap((m) =>
        (m.ticketSources ?? []).map((s) => (s.ticket?.project ? ticketKey(s.ticket.project.key, s.ticket.number) : "…")),
      ),
    ),
  ];

  const me = channel?.members.find((m) => m.userId === user.id);
  // Read position at open time: the "New messages" divider must not move while reading
  const readAtOpen = useRef<number | null | undefined>(undefined);
  if (readAtOpen.current === undefined && channel) readAtOpen.current = me ? (me.lastReadSeq ?? 0) : null;
  const lastMarked = useRef(0);

  const onReadUpTo = useCallback(
    (seq: number) => {
      if (!me || seq <= Math.max(me.lastReadSeq ?? 0, lastMarked.current)) return;
      lastMarked.current = seq;
      zero.mutate(mutators.channels.markRead({ channelId, seq, at: Date.now() }));
    },
    [me, channelId, zero],
  );

  const openThread = useCallback(
    (id: string) => void navigate({ to: "/$orgSlug/c/$channelId", params: { orgSlug: org.slug, channelId }, search: { thread: id } }),
    [navigate, org.slug, channelId],
  );
  const closeThread = useCallback(
    () => void navigate({ to: "/$orgSlug/c/$channelId", params: { orgSlug: org.slug, channelId }, search: {} }),
    [navigate, org.slug, channelId],
  );

  // Mention candidates: everyone for public channels, members otherwise
  const people = useMemo<OrgUser[]>(() => {
    if (!channel || channel.kind === "public") return sorted;
    return channel.members.map((m) => users.get(m.userId)).filter((u): u is OrgUser => !!u);
  }, [channel, sorted, users]);

  if (!channel) return channelResult.type === "complete" ? <div className="empty">{t("channel.notFound")}</div> : null;

  const isDm = channel.kind === "dm";
  const others = channel.members.filter((m) => m.userId !== user.id).map((m) => users.get(m.userId) ?? m.user);
  const title = isDm ? others.map((u) => u?.name ?? "?").join(", ") || user.name : channel.name;
  const archived = !!channel.archivedAt;
  const canPost = !archived && (!!me || channel.kind === "public");
  const canManage = !isDm && (channel.createdBy === user.id || isAdmin);
  const canAddPeople = !isDm && !archived && (!!me || channel.kind === "public");
  const memberUsers = channel.members.map((m) => ({ userId: m.userId, user: users.get(m.userId) ?? null }));

  const intro = (
    <div className="chat__intro">
      <div className="chat__intro-icon">
        {isDm ? <Avatar user={others[0] ?? null} size={40} /> : <Icon name={channel.kind === "private" ? "lock" : "hash"} size={22} />}
      </div>
      <h2>{isDm ? title : `#${channel.name}`}</h2>
      <p>
        {isDm
          ? t("dm.intro", { names: title })
          : channel.kind === "private"
            ? t("channel.introPrivate", { name: channel.name })
            : t("channel.empty", { name: channel.name })}
      </p>
      {channel.topic && <p className="chat__intro-topic">{channel.topic}</p>}
    </div>
  );

  return (
    <>
      <ViewHeader>
        <span className="crumb">
          {isDm ? <Avatar user={others[0] ?? null} size={16} /> : <Icon name={channel.kind === "private" ? "lock" : "hash"} size={14} />}
          <span className="truncate">{title}</span>
        </span>
        {channel.topic && !isDm && <span className="chat__topic truncate">{channel.topic}</span>}
        {canTicket && !isDm && (
          <div className="view-tabs">
            <Button variant="tab" size="md" active={tab === "all"} onClick={() => setTab("all")}>
              {t("chat.tabMessages")}
            </Button>
            <Tooltip content={t("chat.unprocessedHint")} placement="bottom">
              <Button variant="tab" size="md" active={tab === "unprocessed"} onClick={() => setTab("unprocessed")}>
                {t("chat.tabUnprocessed")}
                {unprocessed.length > 0 && (
                  <span className="chat__tab-count tabular">{unprocessed.length >= 200 ? "200+" : unprocessed.length}</span>
                )}
              </Button>
            </Tooltip>
          </div>
        )}
        <span className="spacer" />
        {!isDm && (
          <Tooltip content={t("channel.members", { count: channel.members.length })} placement="bottom">
            <button type="button" className="member-stack" onClick={() => setMembersOpen(true)}>
              {memberUsers.slice(0, 3).map((m) => (
                <Avatar key={m.userId} user={m.user} size={20} />
              ))}
              <span className="member-stack__count">{channel.members.length}</span>
            </button>
          </Tooltip>
        )}
        {!me && channel.kind === "public" && !archived && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => zero.mutate(mutators.channels.join({ organizationId: org.id, channelId, at: Date.now() }))}
          >
            {t("channel.join")}
          </Button>
        )}
        <Button
          variant="muted"
          size="sm"
          iconOnly
          icon={<Icon name="more" size={16} />}
          onClick={moreMenu.toggleFrom}
          active={moreMenu.open}
          aria-label={t("chat.more")}
        />
      </ViewHeader>

      <ChatSelectionContext.Provider value={selection}>
        <div className="chat-layout">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for attachments */}
          <div
            className="chat"
            data-dragging={dragging || undefined}
            onDragOver={(e) => {
              if (!canPost || !e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDragging(false);
            }}
            onDrop={(e) => {
              if (!canPost) return;
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files.length) composer.current?.addFiles(e.dataTransfer.files);
            }}
          >
            <MessageList
              key={tab}
              messages={shown}
              hasMore={tab === "all" && latest.length >= limit}
              onLoadMore={() => setLimit((l) => l + PAGE)}
              lastReadSeqAtOpen={tab === "all" ? (readAtOpen.current ?? null) : null}
              meId={user.id}
              users={users}
              people={people}
              isAdmin={isAdmin}
              onOpenThread={openThread}
              onReadUpTo={tab === "all" ? onReadUpTo : undefined}
              highlightId={highlightId}
              intro={
                tab === "all" ? (
                  intro
                ) : (
                  <div className="chat__intro">
                    <div className="chat__intro-icon">
                      <Icon name="checkCircle" size={22} />
                    </div>
                    <h2>{unprocessed.length ? t("chat.unprocessedTitle", { count: unprocessed.length }) : t("chat.unprocessedNone")}</h2>
                    <p>{t("chat.unprocessedIntro")}</p>
                  </div>
                )
              }
            />
            {selected.size > 0 && (
              <div className="chat-selbar" data-surface="elevated" role="toolbar" aria-label={t("chat.selectionActions")}>
                <span className="chat-selbar__count tabular" key={selected.size}>
                  {t("chat.selected", { count: selected.size })}
                </span>
                {alreadyLinked.length > 0 && (
                  <span className="chat-selbar__warn">
                    <Icon name="link" size={14} />
                    {t("chat.alreadyLinked", { count: alreadyLinked.length, keys: linkedKeys.join(", ") })}
                  </span>
                )}
                <Tooltip content={t("chat.linkToTicket")} shortcut="L" placement="top">
                  <Button
                    ref={linkBtn}
                    size="md"
                    variant="secondary"
                    icon={<Icon name="link" size={14} />}
                    active={linkMenu.open}
                    onClick={linkMenu.toggleFrom}
                  >
                    {t("chat.link")}
                  </Button>
                </Tooltip>
                <Tooltip content={t("chat.createTicket")} shortcut="C" placement="top">
                  <Button size="md" variant="primary" icon={<Icon name="ticket" size={14} />} onClick={createFromSelection}>
                    {t("chat.createTicket")}
                  </Button>
                </Tooltip>
                <Tooltip content={t("tickets.clearSelection")} shortcut="Esc" placement="top">
                  <Button
                    size="md"
                    variant="muted"
                    iconOnly
                    icon={<Icon name="x" size={14} />}
                    onClick={clearSelection}
                    aria-label={t("tickets.clearSelection")}
                  />
                </Tooltip>
              </div>
            )}
            {archived ? (
              <div className="chat__banner">
                <Icon name="archive" size={16} />
                {t("channel.archived")}
              </div>
            ) : !me && channel.kind === "public" ? (
              <div className="chat__banner">
                <span>{t("channel.viewing", { name: channel.name })}</span>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => zero.mutate(mutators.channels.join({ organizationId: org.id, channelId, at: Date.now() }))}
                >
                  {t("channel.join")}
                </Button>
              </div>
            ) : canPost ? (
              <Composer
                ref={composer}
                channelId={channel.id}
                people={people}
                placeholder={
                  isDm ? t("channel.composerPlaceholderDm", { name: title }) : t("channel.composerPlaceholder", { name: channel.name })
                }
              />
            ) : (
              <div className="chat__banner">{t("chat.readOnly")}</div>
            )}
            {dragging && <div className="chat__drop">{t("chat.dropHere")}</div>}
          </div>

          {threadId && (
            <ThreadPanel
              parentId={threadId}
              channelName={title}
              canPost={canPost && (!!me || channel.kind === "public")}
              users={users}
              people={people}
              isAdmin={isAdmin}
              onClose={closeThread}
            />
          )}
        </div>
      </ChatSelectionContext.Provider>

      <Menu
        anchor={linkMenu.anchor}
        onClose={linkMenu.close}
        placement="top-start"
        width={420}
        filterPlaceholder={t("chat.searchTicket")}
        emptyText={t("chat.noTicketToLink")}
        items={linkEntries}
      />
      <Menu
        anchor={moreMenu.anchor}
        onClose={moreMenu.close}
        placement="bottom-end"
        width={220}
        items={[
          ...(!isDm
            ? [
                {
                  id: "members",
                  label: t("channel.membersTitle", { name: channel.name }),
                  icon: <Icon name="users" />,
                  onSelect: () => setMembersOpen(true),
                },
              ]
            : []),
          ...(canManage
            ? [{ id: "settings", label: t("channel.settings"), icon: <Icon name="settings" />, onSelect: () => setSettingsOpen(true) }]
            : []),
          {
            id: "copy",
            label: t("channel.copyLink"),
            icon: <Icon name="link" />,
            onSelect: () => {
              void navigator.clipboard.writeText(location.href.split("?")[0] ?? location.href);
              toast({ title: t("channel.linkCopied") });
            },
          },
          ...(me && !isDm
            ? [
                { kind: "separator" as const, id: "s" },
                {
                  id: "leave",
                  label: t("channel.leave"),
                  icon: <Icon name="signOut" />,
                  onSelect: () => {
                    zero.mutate(mutators.channels.leave({ organizationId: org.id, channelId }));
                    toast({ title: t("channel.leftToast", { name: channel.name }) });
                    if (channel.kind === "private") void navigate({ to: "/$orgSlug", params: { orgSlug: org.slug } });
                  },
                },
              ]
            : []),
        ]}
      />
      {canManage && (
        <ChannelSettingsModal key={`${settingsOpen}`} channel={channel} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      )}
      <ChannelMembersModal
        channel={channel}
        members={memberUsers}
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        canAdd={canAddPeople}
      />
    </>
  );
}
