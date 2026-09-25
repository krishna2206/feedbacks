import { mutators, queries } from "@feedbacks/schema/zero";
import { Avatar, Button, Icon, Menu, Tooltip, toast, useMenu } from "@feedbacks/ui";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./chat.css";
import { ChannelMembersModal, ChannelSettingsModal } from "./chat/ChannelModals";
import { Composer, type ComposerHandle } from "./chat/Composer";
import { MessageList } from "./chat/MessageList";
import type { MessageData } from "./chat/MessageRow";
import { ThreadPanel } from "./chat/ThreadPanel";
import { useOrg } from "./org-context";
import { type OrgUser, useOrgMembers } from "./org-data";
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
            messages={messages}
            hasMore={latest.length >= limit}
            onLoadMore={() => setLimit((l) => l + PAGE)}
            lastReadSeqAtOpen={readAtOpen.current ?? null}
            meId={user.id}
            users={users}
            people={people}
            isAdmin={isAdmin}
            onOpenThread={openThread}
            onReadUpTo={onReadUpTo}
            highlightId={highlightId}
            intro={intro}
          />
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
