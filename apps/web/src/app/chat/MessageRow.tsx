import { ticketKey } from "@feedbacks/schema/tickets";
import { mutators } from "@feedbacks/schema/zero";
import { Avatar, Button, Checkbox, clock, Icon, Menu, Modal, Tooltip, timeAgo, toast, useMenu } from "@feedbacks/ui";
import { useZero } from "@rocicorp/zero/react";
import { Link } from "@tanstack/react-router";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { decodeDocMentions, encodeDocMentions, useDocIndex } from "../docs/data";
import { useOrg } from "../org-context";
import type { OrgUser } from "../org-data";
import { statusLabel, TicketStatusIcon } from "../tickets/meta";
import { Attachments } from "./Attachments";
import { decodeMentions, encodeMentions } from "./Composer";
import { Markdown, plainText } from "./markdown";
import { AddReactionButton, Reactions } from "./Reactions";
import { useChatSelection } from "./selection";

export type MessageData = {
  id: string;
  channelId: string;
  authorId: string | null;
  parentId: string | null;
  body: string;
  seq: number | null;
  replyCount: number | null;
  lastReplyAt: number | null;
  createdAt: number | null;
  editedAt: number | null;
  deletedAt: number | null;
  /** Agent/client label when posted through the API or MCP */
  via?: string | null;
  author?: { id: string; name: string; image: string | null } | null;
  attachments: readonly {
    id: string;
    kind: string;
    name: string;
    mimeType: string;
    size: number;
    width: number | null;
    height: number | null;
  }[];
  reactions: readonly { id: string; emoji: string; userId: string; user?: { name: string } | null }[];
  replies?: readonly { id: string; authorId: string | null; author?: { id: string; name: string; image: string | null } | null }[];
  /** Tickets built from this message (ticket is absent when the user can't read it) */
  ticketSources?: readonly {
    ticketId: string;
    ticket?: {
      id: string;
      number: number;
      status: "triage" | "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled";
      project?: { key: string } | null;
    } | null;
  }[];
};

type Props = {
  message: MessageData;
  /** First message of a group (shows avatar and name) */
  first: boolean;
  users: Map<string, OrgUser>;
  people: readonly OrgUser[];
  isAdmin: boolean;
  /** Opens the thread panel (top-level messages in the channel view) */
  onOpenThread?: (id: string) => void;
  highlighted?: boolean;
};

export const MessageRow = memo(function MessageRow({ message: m, first, users, people, isAdmin, onOpenThread, highlighted }: Props) {
  const { t, i18n } = useTranslation();
  const { org, user } = useOrg();
  const zero = useZero();
  const docIndex = useDocIndex();
  const more = useMenu();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const lookup = (id: string) => users.get(id);
  const time = m.createdAt ?? Date.now();
  const mine = m.authorId === user.id;
  const deleted = !!m.deletedAt;
  const replyCount = m.replyCount ?? 0;
  const sel = useChatSelection();
  // Only top-level messages of the channel view can be selected (not the thread panel)
  const selectable = !!sel?.enabled && !!onOpenThread && !deleted;
  const selected = selectable && !!sel?.selected.has(m.id);
  const selecting = selectable && (sel?.selected.size ?? 0) > 0;
  const chips = (m.ticketSources ?? []).filter((s) => s.ticket?.project);

  const repliers = (() => {
    const seen = new Map<string, { id: string; name: string; image: string | null }>();
    for (const r of m.replies ?? []) if (r.author && !seen.has(r.author.id)) seen.set(r.author.id, r.author);
    return [...seen.values()].slice(0, 3);
  })();

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: click toggles the message while selecting (checkbox and `x` are the accessible paths)
    <div
      className={`msg${first ? " msg--first" : ""}`}
      data-highlighted={highlighted || undefined}
      data-actions-open={more.open || pickerOpen || undefined}
      data-selectable={selectable || undefined}
      data-selecting={selecting || undefined}
      data-selected={selected || undefined}
      data-surface={selected ? "selected" : undefined}
      id={`msg-${m.id}`}
      onMouseEnter={selectable ? () => sel?.hover(m.id) : undefined}
      onClick={
        selectable
          ? (e) => {
              const target = e.target as HTMLElement;
              if (target.closest("button, a, textarea, input, .msg__actions")) return;
              if (selecting || e.shiftKey || e.metaKey || e.ctrlKey) sel?.toggle(m.id, { shiftKey: e.shiftKey });
            }
          : undefined
      }
    >
      {selectable && (
        <span className="msg__select">
          <Checkbox checked={selected} onChange={() => sel?.toggle(m.id)} label={t("chat.selectMessage")} />
        </span>
      )}
      {first ? <Avatar user={m.author ?? null} size={32} /> : <span className="msg__gutter">{clock(time, i18n.language)}</span>}
      <div className="msg__main">
        {first && (
          <div className="msg__head">
            <span className="msg__author">{m.author?.name ?? "—"}</span>
            <Tooltip content={new Date(time).toLocaleString(i18n.language)} placement="top">
              <span className="msg__time">{clock(time, i18n.language)}</span>
            </Tooltip>
          </div>
        )}

        {editing ? (
          <EditBox
            initial={decodeDocMentions(decodeMentions(m.body, users), docIndex)}
            onCancel={() => setEditing(false)}
            onSave={(body) => {
              zero.mutate(
                mutators.messages.edit({
                  organizationId: org.id,
                  id: m.id,
                  body: encodeDocMentions(encodeMentions(body, people), docIndex),
                  at: Date.now(),
                }),
              );
              setEditing(false);
            }}
          />
        ) : deleted ? (
          <div className="msg__body msg__body--deleted">{t("chat.deleted")}</div>
        ) : (
          m.body && (
            <div className="msg__body">
              <Markdown text={m.body} users={lookup} meId={user.id} />
              {m.editedAt && <span className="msg__edited">{t("chat.edited")}</span>}
              {m.via && (
                <span className="msg__edited" title={t("chat.viaHint")}>
                  {t("chat.via", { client: m.via })}
                </span>
              )}
            </div>
          )
        )}

        {!deleted && <Attachments items={m.attachments} />}
        {chips.length > 0 && (
          <div className="msg__tickets">
            {chips.map((s) => {
              const tk = s.ticket as NonNullable<typeof s.ticket>;
              const key = ticketKey((tk.project as { key: string }).key, tk.number);
              return (
                <Link key={s.ticketId} to="/$orgSlug/issue/$ref" params={{ orgSlug: org.slug, ref: key }} className="chip msg__ticket">
                  <TicketStatusIcon status={tk.status} />
                  <span className="tabular">{key}</span>
                  <span className="msg__ticket-status">· {statusLabel(t, tk.status)}</span>
                </Link>
              );
            })}
          </div>
        )}
        {!deleted && <Reactions messageId={m.id} reactions={m.reactions} meId={user.id} />}

        {onOpenThread && replyCount > 0 && (
          <button type="button" className="thread-summary" onClick={() => onOpenThread(m.id)}>
            <span className="thread-summary__avatars">
              {repliers.map((u) => (
                <Avatar key={u.id} user={u} size={20} />
              ))}
            </span>
            <span className="thread-summary__count">{t("chat.replies", { count: replyCount })}</span>
            {m.lastReplyAt && (
              <span className="thread-summary__when">{t("chat.lastReply", { when: timeAgo(m.lastReplyAt, i18n.language) })}</span>
            )}
          </button>
        )}
      </div>

      {!deleted && !editing && (
        <div className="msg__actions" data-surface="elevated">
          <AddReactionButton messageId={m.id} onOpenChange={setPickerOpen} />
          {onOpenThread && (
            <Tooltip content={t("chat.reply")} placement="top">
              <button type="button" className="msg-action" aria-label={t("chat.reply")} onClick={() => onOpenThread(m.id)}>
                <Icon name="reply" size={16} />
              </button>
            </Tooltip>
          )}
          {selectable && (
            <Tooltip content={t("chat.createTicket")} shortcut="C" placement="top">
              <button type="button" className="msg-action" aria-label={t("chat.createTicket")} onClick={() => sel?.createFrom(m.id)}>
                <Icon name="ticket" size={16} />
              </button>
            </Tooltip>
          )}
          {mine && (
            <Tooltip content={t("chat.edit")} placement="top">
              <button type="button" className="msg-action" aria-label={t("chat.edit")} onClick={() => setEditing(true)}>
                <Icon name="edit" size={16} />
              </button>
            </Tooltip>
          )}
          <Tooltip content={t("chat.more")} placement="top">
            <button
              type="button"
              className="msg-action"
              aria-label={t("chat.more")}
              data-active={more.open || undefined}
              onClick={more.toggleFrom}
            >
              <Icon name="more" size={16} />
            </button>
          </Tooltip>
        </div>
      )}

      <Menu
        anchor={more.anchor}
        onClose={more.close}
        placement="bottom-end"
        width={200}
        items={[
          ...(selectable
            ? [
                { id: "ticket", label: t("chat.createTicket"), icon: <Icon name="ticket" />, onSelect: () => sel?.createFrom(m.id) },
                {
                  id: "select",
                  label: selected ? t("chat.unselect") : t("chat.select"),
                  icon: <Icon name="check" />,
                  hint: "X",
                  onSelect: () => sel?.toggle(m.id),
                },
                { kind: "separator" as const, id: "s0" },
              ]
            : []),
          {
            id: "copy",
            label: t("chat.copyText"),
            icon: <Icon name="copy" />,
            onSelect: () => {
              void navigator.clipboard.writeText(plainText(m.body, lookup));
              toast({ title: t("chat.copied") });
            },
          },
          ...(mine || isAdmin
            ? [
                { kind: "separator" as const, id: "s" },
                { id: "delete", label: t("chat.delete"), icon: <Icon name="trash" />, onSelect: () => setConfirmDelete(true) },
              ]
            : []),
        ]}
      />

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} width={420} labelledBy={`del-${m.id}`}>
        <div className="modal__header">
          <b id={`del-${m.id}`} className="modal__title">
            {t("chat.deleteConfirmTitle")}
          </b>
        </div>
        <div className="modal__body">
          <p className="muted">{t("chat.deleteConfirm")}</p>
        </div>
        <div className="modal__footer">
          <Button variant="muted" onClick={() => setConfirmDelete(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            autoFocus
            onClick={() => {
              zero.mutate(mutators.messages.delete({ organizationId: org.id, id: m.id, at: Date.now() }));
              setConfirmDelete(false);
            }}
          >
            {t("chat.delete")}
          </Button>
        </div>
      </Modal>
    </div>
  );
});

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (body: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  const save = () => {
    if (!value.trim()) return;
    if (value.trim() === initial.trim()) onCancel();
    else onSave(value.trim());
  };
  return (
    <div className="msg-edit" data-surface="elevated">
      <textarea
        ref={ref}
        value={value}
        rows={1}
        onChange={(e) => {
          setValue(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }}
        aria-label={t("chat.edit")}
      />
      <div className="msg-edit__bar">
        <span className="muted">{t("chat.editHint")}</span>
        <span className="spacer" />
        <Button size="sm" variant="muted" onClick={onCancel}>
          {t("chat.cancelEdit")}
        </Button>
        <Button size="sm" variant="primary" onClick={save}>
          {t("chat.save")}
        </Button>
      </div>
    </div>
  );
}
