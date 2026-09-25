import type { TicketPriority, TicketStatus } from "@feedbacks/schema/enums";
import { newId } from "@feedbacks/schema/ids";
import { canComment, canEditTickets, parseTicketKey, ticketKey } from "@feedbacks/schema/tickets";
import { mutators, queries } from "@feedbacks/schema/zero";
import {
  Avatar,
  Button,
  Caret,
  clock,
  Icon,
  type IconName,
  LabelDot,
  Menu,
  Popover,
  shortDate,
  Tooltip,
  timeAgo,
  toast,
  useMenu,
} from "@feedbacks/ui";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../chat.css";
import { encodeMentions } from "../chat/Composer";
import { EmojiPicker } from "../chat/Reactions";
import { fileUrl } from "../chat/upload";
import { encodeDocMentions, useDocIndex } from "../docs/data";
import { RelatedDocs } from "../docs/RelatedDocs";
import { useOrg } from "../org-context";
import { type OrgUser, useOrgMembers } from "../org-data";
import { ViewHeader } from "../ViewHeader";
import { useTicketActions } from "./actions";
import { useLabels, useProjectRoles, useProjects } from "./data";
import { ProjectBadge, priorityLabel, statusLabel, TicketPriorityIcon, TicketStatusIcon } from "./meta";
import { assigneeEntries, labelEntries, priorityEntries, projectEntries, statusEntries } from "./pickers";
import { RichText } from "./RichText";
import { shortcutsBlocked } from "./TicketList";
import { TicketsEmpty } from "./TicketsPages";
import "./tickets.css";

/** /issue/APP-12 (current or former key) or /issue/<id> */
export function TicketPage() {
  const { ref } = useParams({ from: "/$orgSlug/issue/$ref" });
  const { org } = useOrg();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const parsed = parseTicketKey(ref);
  const [byKey, keyResult] = useQuery(
    parsed ? queries.tickets.byKey({ organizationId: org.id, key: parsed.key, number: parsed.number }) : undefined,
  );
  const needAlias = !!parsed && !byKey && keyResult.type === "complete";
  const [alias, aliasResult] = useQuery(
    needAlias && parsed ? queries.tickets.aliasByKey({ organizationId: org.id, key: parsed.key, number: parsed.number }) : undefined,
  );

  // A former key redirects to the current one
  useEffect(() => {
    if (alias?.ticket?.project) {
      void navigate({
        to: "/$orgSlug/issue/$ref",
        params: { orgSlug: org.slug, ref: ticketKey(alias.ticket.project.key, alias.ticket.number) },
        replace: true,
      });
    }
  }, [alias, navigate, org.slug]);

  const ticketId = parsed ? (byKey?.id ?? alias?.ticketId) : ref;
  if (ticketId) return <TicketView key={ticketId} ticketId={ticketId} />;
  const done = !parsed || (keyResult.type === "complete" && (!needAlias || aliasResult.type === "complete"));
  if (!done) return null;
  return (
    <>
      <ViewHeader>
        <span className="crumb">{ref}</span>
      </ViewHeader>
      <TicketsEmpty icon="ticket" title={t("tickets.notFound")} text={t("tickets.notFoundText")} />
    </>
  );
}

type ActivityRow = {
  id: string;
  kind: string;
  actorId: string | null;
  fromValue: string | null;
  toValue: string | null;
  createdAt: number | null;
};

function TicketView({ ticketId }: { ticketId: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { org, user } = useOrg();
  const { users, sorted, roles } = useOrgMembers();
  const { labels, byId: labelById } = useLabels();
  const projects = useProjects();
  const roleOf = useProjectRoles();
  const actions = useTicketActions();
  const [ticket, result] = useQuery(queries.tickets.get({ organizationId: org.id, ticketId }));
  const project = ticket?.project;
  const listedProject = projects.find((p) => p.id === ticket?.projectId);
  const role = roleOf(listedProject);
  const editable = canEditTickets(role);
  const isSourceAuthor = !!ticket?.sources.some((s) => s.message?.authorId === user.id);
  const commentable = canComment(role) || isSourceAuthor;
  const [siblings] = useQuery(ticket ? queries.tickets.byProject({ organizationId: org.id, projectId: ticket.projectId }) : undefined);

  const statusMenu = useMenu();
  const priorityMenu = useMenu();
  const assigneeMenu = useMenu();
  const labelMenu = useMenu();
  const projectMenu = useMenu();
  const moreMenu = useMenu();
  const statusBtn = useRef<HTMLButtonElement>(null);
  const priorityBtn = useRef<HTMLButtonElement>(null);
  const assigneeBtn = useRef<HTMLButtonElement>(null);
  const labelBtn = useRef<HTMLButtonElement>(null);

  const people = useMemo(
    () =>
      listedProject
        ? sorted.filter((u) => {
            const r = roles.get(u.id);
            return (
              r === "owner" || r === "admin" || listedProject.visibility === "org" || listedProject.members.some((m) => m.userId === u.id)
            );
          })
        : sorted,
    [listedProject, sorted, roles],
  );
  const key = ticket && project ? ticketKey(project.key, ticket.number) : "";
  const ordered = useMemo(() => [...(siblings ?? [])].sort((a, b) => b.number - a.number), [siblings]);
  const idx = ordered.findIndex((x) => x.id === ticketId);
  const prev = idx > 0 ? ordered[idx - 1] : undefined;
  const next = idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1] : undefined;
  const goTo = (x?: { number: number }) =>
    x && project && void navigate({ to: "/$orgSlug/issue/$ref", params: { orgSlug: org.slug, ref: ticketKey(project.key, x.number) } });
  const backToProject = () =>
    project && void navigate({ to: "/$orgSlug/projects/$projectKey", params: { orgSlug: org.slug, projectKey: project.key } });

  // Keyboard: s / p / a / l open the property menus, j/k previous/next, Esc back to the project
  const live = useRef({ editable, prev, next, goTo, backToProject });
  live.current = { editable, prev, next, goTo, backToProject };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || shortcutsBlocked(e)) return;
      const L = live.current;
      const open = (btn: HTMLButtonElement | null, m: ReturnType<typeof useMenu>) => {
        if (!L.editable || !btn) return;
        e.preventDefault();
        m.openFrom(btn);
      };
      if (e.key === "s") open(statusBtn.current, statusMenu);
      else if (e.key === "p") open(priorityBtn.current, priorityMenu);
      else if (e.key === "a") open(assigneeBtn.current, assigneeMenu);
      else if (e.key === "l") open(labelBtn.current, labelMenu);
      else if (e.key === "k") L.goTo(L.prev);
      else if (e.key === "j") L.goTo(L.next);
      else if (e.key === "Escape") L.backToProject();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [statusMenu, priorityMenu, assigneeMenu, labelMenu]);

  if (!ticket || !project)
    return result.type === "complete" ? (
      <>
        <ViewHeader>
          <span className="crumb">{t("tickets.ticket")}</span>
        </ViewHeader>
        <TicketsEmpty icon="ticket" title={t("tickets.notFound")} text={t("tickets.notFoundText")} />
      </>
    ) : null;

  const priority = (ticket.priority ?? 0) as TicketPriority;
  const assignee = ticket.assigneeId ? users.get(ticket.assigneeId) : undefined;
  const creator = ticket.creatorId ? users.get(ticket.creatorId) : undefined;
  const ticketLabels = ticket.labels.map((l) => labelById.get(l.labelId)).filter((l): l is (typeof labels)[number] => !!l);
  const labelIds = ticket.labels.map((l) => l.labelId);
  const lookup = (id: string) => users.get(id);
  const update = (patch: {
    status?: TicketStatus;
    priority?: TicketPriority;
    assigneeId?: string | null;
    title?: string;
    description?: string;
  }) => actions.update([ticket.id], patch);

  // Timeline: activities and comments by time
  type Item = { at: number; kind: "activity"; a: ActivityRow } | { at: number; kind: "comment"; c: (typeof ticket.comments)[number] };
  const timeline: Item[] = [
    ...ticket.activities.map((a) => ({ at: a.createdAt ?? 0, kind: "activity" as const, a: a as ActivityRow })),
    ...ticket.comments.map((c) => ({ at: c.createdAt ?? 0, kind: "comment" as const, c })),
  ].sort((x, y) => x.at - y.at);

  return (
    <>
      <ViewHeader>
        <Link to="/$orgSlug/projects/$projectKey" params={{ orgSlug: org.slug, projectKey: project.key }} className="crumb">
          <ProjectBadge project={project} size={16} />
          <span className="truncate">{project.name}</span>
        </Link>
        <span className="crumb-sep">
          <Icon name="chevronRight" size={14} />
        </span>
        <span className="crumb tabular">{key}</span>
        <span className="spacer" />
        <Tooltip content={t("tickets.copyLink")} placement="bottom">
          <Button
            variant="muted"
            size="sm"
            iconOnly
            icon={<Icon name="link" size={14} />}
            aria-label={t("tickets.copyLink")}
            onClick={() => {
              void navigator.clipboard.writeText(`${location.origin}/${org.slug}/issue/${key}`);
              toast({ title: t("tickets.linkCopied") });
            }}
          />
        </Tooltip>
        <span className="tk-nav">
          <Tooltip content={t("tickets.previous")} shortcut="K" placement="bottom">
            <Button
              variant="muted"
              size="sm"
              iconOnly
              icon={<Icon name="arrowUp" size={14} />}
              disabled={!prev}
              onClick={() => goTo(prev)}
              aria-label={t("tickets.previous")}
            />
          </Tooltip>
          <Tooltip content={t("tickets.next")} shortcut="J" placement="bottom">
            <Button
              variant="muted"
              size="sm"
              iconOnly
              icon={<Icon name="arrowDown" size={14} />}
              disabled={!next}
              onClick={() => goTo(next)}
              aria-label={t("tickets.next")}
            />
          </Tooltip>
        </span>
        <Button
          variant="muted"
          size="sm"
          iconOnly
          icon={<Icon name="more" size={14} />}
          active={moreMenu.open}
          onClick={moreMenu.toggleFrom}
          aria-label={t("chat.more")}
        />
      </ViewHeader>

      <div className="tk">
        <div className="tk-main">
          <div className="tk-content">
            <TitleEditor value={ticket.title} editable={editable} onSave={(title) => update({ title })} />
            <DescriptionEditor
              value={ticket.description ?? ""}
              editable={editable}
              users={lookup}
              meId={user.id}
              onSave={(description) => update({ description })}
            />

            <section className="tk-section">
              <h2 className="tk-section__title">
                <Icon name="chat" size={14} />
                {t("tickets.sourceMessages", { count: ticket.sources.length })}
              </h2>
              {ticket.sources.length === 0 ? (
                <p className="tk-muted">{t("tickets.noSources")}</p>
              ) : (
                <div className="tk-sources">
                  {ticket.sources.map((s) =>
                    s.message ? (
                      <div key={s.messageId} className="tk-source" data-surface="elevated">
                        <div className="tk-source__head">
                          <Avatar user={s.message.author ?? null} size={18} />
                          <b>{s.message.author?.name ?? "—"}</b>
                          <span className="tk-muted">
                            {s.message.createdAt
                              ? `${shortDate(s.message.createdAt, i18n.language)} · ${clock(s.message.createdAt, i18n.language)}`
                              : ""}
                          </span>
                          {s.message.channel && s.message.channel.kind !== "dm" && (
                            <span className="tk-muted">#{s.message.channel.name}</span>
                          )}
                          <span className="spacer" />
                          <Link
                            to="/$orgSlug/c/$channelId"
                            params={{ orgSlug: org.slug, channelId: s.message.channelId }}
                            search={{ m: s.messageId, thread: s.message.parentId ?? undefined }}
                            className="tk-source__open"
                          >
                            {t("tickets.viewInChat")}
                            <Icon name="arrowRight" size={12} />
                          </Link>
                          {editable && (
                            <Tooltip content={t("tickets.unlink")}>
                              <Button
                                className="tk-source__unlink"
                                variant="muted"
                                size="sm"
                                iconOnly
                                icon={<Icon name="unlink" size={14} />}
                                aria-label={t("tickets.unlink")}
                                onClick={() => {
                                  actions.unlinkMessage(ticket.id, s.messageId);
                                  toast({ title: t("tickets.unlinked") });
                                }}
                              />
                            </Tooltip>
                          )}
                        </div>
                        {s.message.deletedAt ? (
                          <p className="tk-muted tk-source__body">{t("chat.deleted")}</p>
                        ) : (
                          <div className="tk-source__body">
                            <RichText text={s.message.body} users={lookup} meId={user.id} />
                            {s.message.attachments.length > 0 && (
                              <div className="tk-source__files">
                                {s.message.attachments.map((a) =>
                                  a.kind === "image" ? (
                                    <a key={a.id} href={fileUrl(a.id)} target="_blank" rel="noreferrer" className="tk-thumb">
                                      <img src={fileUrl(a.id, "thumb")} alt={a.name} loading="lazy" />
                                    </a>
                                  ) : (
                                    <a key={a.id} href={fileUrl(a.id, "download")} className="chip">
                                      <Icon name="clip" size={14} />
                                      {a.name}
                                    </a>
                                  ),
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div key={s.messageId} className="tk-source tk-source--hidden">
                        <Icon name="lock" size={14} />
                        {t("tickets.hiddenSource")}
                      </div>
                    ),
                  )}
                </div>
              )}
            </section>

            <RelatedDocs ticketId={ticket.id} links={ticket.docLinks} editable={editable} />

            <section className="tk-section">
              <h2 className="tk-section__title">{t("tickets.activity")}</h2>
              <div className="tk-timeline">
                {timeline.map((item) =>
                  item.kind === "activity" ? (
                    <ActivityLine key={item.a.id} a={item.a} users={users} labels={labelById} />
                  ) : (
                    <CommentCard key={item.c.id} c={item.c} users={lookup} meId={user.id} />
                  ),
                )}
              </div>
              {commentable ? (
                <CommentComposer ticketId={ticket.id} people={people} />
              ) : (
                <p className="tk-muted">{t("tickets.cannotComment")}</p>
              )}
            </section>
          </div>
        </div>

        <aside className="tk-props" aria-label={t("tickets.properties")}>
          <PropRow label={t("tickets.status.label")}>
            <button
              ref={statusBtn}
              type="button"
              className="tk-prop"
              disabled={!editable}
              data-active={statusMenu.open || undefined}
              onClick={statusMenu.toggleFrom}
            >
              <TicketStatusIcon status={ticket.status} />
              {statusLabel(t, ticket.status)}
            </button>
          </PropRow>
          <PropRow label={t("tickets.priorityLabel")}>
            <button
              ref={priorityBtn}
              type="button"
              className="tk-prop"
              disabled={!editable}
              data-active={priorityMenu.open || undefined}
              onClick={priorityMenu.toggleFrom}
            >
              <TicketPriorityIcon priority={priority} />
              {priorityLabel(t, priority)}
            </button>
          </PropRow>
          <PropRow label={t("tickets.assignee")}>
            <button
              ref={assigneeBtn}
              type="button"
              className="tk-prop"
              disabled={!editable}
              data-active={assigneeMenu.open || undefined}
              onClick={assigneeMenu.toggleFrom}
            >
              <Avatar user={assignee ?? null} size={16} />
              {assignee?.name ?? t("tickets.unassigned")}
            </button>
          </PropRow>
          <PropRow label={t("tickets.labels")} top>
            <div className="tk-labels">
              {ticketLabels.map((l) => (
                <span key={l.id} className="chip">
                  <LabelDot color={l.color} />
                  {l.name}
                </span>
              ))}
              {editable && (
                <button
                  ref={labelBtn}
                  type="button"
                  className="tk-prop tk-prop--add"
                  data-active={labelMenu.open || undefined}
                  onClick={labelMenu.toggleFrom}
                  aria-label={t("tickets.addLabels")}
                >
                  <Icon name={ticketLabels.length ? "plus" : "tag"} size={14} />
                  {!ticketLabels.length && t("tickets.addLabels")}
                </button>
              )}
            </div>
          </PropRow>
          <PropRow label={t("tickets.project")}>
            <button
              type="button"
              className="tk-prop"
              disabled={!editable}
              data-active={projectMenu.open || undefined}
              onClick={projectMenu.toggleFrom}
            >
              <ProjectBadge project={project} size={14} />
              {project.name}
              {editable && <Caret />}
            </button>
          </PropRow>
          <div className="tk-props__sep" />
          <div className="tk-meta">
            <span>
              {t("tickets.createdBy", { name: creator?.name ?? "—" })} · {ticket.createdAt ? timeAgo(ticket.createdAt, i18n.language) : ""}
            </span>
            {ticket.createdVia === "mcp" && (
              <span className="tk-mcp">
                <Icon name="bot" size={14} />
                {t("tickets.viaMcp")}
              </span>
            )}
            {ticket.aliases.length > 0 && <span>{t("tickets.formerKeys", { count: ticket.aliases.length })}</span>}
            {!editable && <span className="tk-muted">{commentable ? t("tickets.readOnlyCanComment") : t("tickets.readOnly")}</span>}
          </div>
        </aside>
      </div>

      <Menu
        anchor={statusMenu.anchor}
        onClose={statusMenu.close}
        filterPlaceholder={t("tickets.changeStatus")}
        items={statusEntries(t, ticket.status, (status) => update({ status }))}
      />
      <Menu
        anchor={priorityMenu.anchor}
        onClose={priorityMenu.close}
        filterPlaceholder={t("tickets.changePriority")}
        items={priorityEntries(t, priority, (p) => update({ priority: p }))}
      />
      <Menu
        anchor={assigneeMenu.anchor}
        onClose={assigneeMenu.close}
        filterPlaceholder={t("tickets.assignTo")}
        items={assigneeEntries(t, people as OrgUser[], ticket.assigneeId, user.id, (assigneeId) => update({ assigneeId }))}
      />
      <Menu
        anchor={labelMenu.anchor}
        onClose={labelMenu.close}
        keepOpen
        filterPlaceholder={t("tickets.addLabels")}
        emptyText={labels.length ? undefined : t("tickets.noLabels")}
        items={labelEntries(labels, labelIds, (id) =>
          actions.setLabels(ticket.id, labelIds.includes(id) ? labelIds.filter((x) => x !== id) : [...labelIds, id]),
        )}
      />
      <Menu
        anchor={projectMenu.anchor}
        onClose={projectMenu.close}
        filterPlaceholder={t("tickets.moveTo")}
        items={projectEntries(
          projects.filter((p) => canEditTickets(roleOf(p))),
          ticket.projectId,
          (projectId) => {
            if (projectId === ticket.projectId) return;
            actions.move(ticket.id, projectId);
            toast({ title: t("tickets.moved") });
          },
        )}
      />
      <Menu
        anchor={moreMenu.anchor}
        onClose={moreMenu.close}
        placement="bottom-end"
        width={220}
        items={[
          {
            id: "copy-key",
            label: t("tickets.copyKey"),
            icon: <Icon name="copy" size={14} />,
            onSelect: () => {
              void navigator.clipboard.writeText(key);
              toast({ title: t("tickets.keyCopied", { key }) });
            },
          },
          ...(editable
            ? [
                {
                  id: "move",
                  label: t("tickets.moveTo"),
                  icon: <Icon name="arrowRight" size={14} />,
                  onSelect: () => setTimeout(() => moreMenu.anchor && projectMenu.openFrom(moreMenu.anchor as HTMLElement), 0),
                },
              ]
            : []),
        ]}
      />
    </>
  );
}

function PropRow({ label, children, top }: { label: string; children: ReactNode; top?: boolean }) {
  return (
    <div className="tk-prop-row" data-top={top || undefined}>
      <span className="tk-prop-row__label">{label}</span>
      <div className="tk-prop-row__value">{children}</div>
    </div>
  );
}

function TitleEditor({ value, editable, onSave }: { value: string; editable: boolean; onSave: (v: string) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-grow on every content change
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  const commit = () => {
    const v = draft.trim();
    if (!v) setDraft(value);
    else if (v !== value) onSave(v);
  };
  if (!editable) return <h1 className="tk-title">{value}</h1>;
  return (
    <textarea
      ref={ref}
      className="tk-title tk-title--input"
      value={draft}
      rows={1}
      aria-label={t("tickets.titlePlaceholder")}
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(value);
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}

function DescriptionEditor({
  value,
  editable,
  users,
  meId,
  onSave,
}: {
  value: string;
  editable: boolean;
  users: (id: string) => { name: string } | undefined;
  meId: string;
  onSave: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-grow on every content change
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 92)}px`;
  }, [draft, editing]);
  const save = () => {
    setEditing(false);
    if (draft !== value) onSave(draft);
  };
  if (editing)
    return (
      <div className="tk-desc-edit">
        <textarea
          ref={ref}
          autoFocus
          className="tk-desc-input"
          value={draft}
          placeholder={t("tickets.descriptionPlaceholder")}
          aria-label={t("tickets.descriptionPlaceholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              save();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(value);
              setEditing(false);
            }
          }}
        />
        <div className="tk-desc-edit__bar">
          <span className="tk-muted">{t("tickets.markdownHint")}</span>
          <span className="spacer" />
          <Button
            size="sm"
            variant="muted"
            onClick={() => {
              setDraft(value);
              setEditing(false);
            }}
          >
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="primary" onClick={save}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    );
  if (!value.trim())
    return editable ? (
      <button type="button" className="tk-desc-empty" onClick={() => setEditing(true)}>
        {t("tickets.descriptionPlaceholder")}
      </button>
    ) : null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-to-edit, also reachable with the edit button
    <div className="tk-desc" onDoubleClick={() => editable && setEditing(true)}>
      <RichText text={value} users={users} meId={meId} />
      {editable && (
        <Button className="tk-desc__edit" size="sm" variant="muted" icon={<Icon name="edit" size={14} />} onClick={() => setEditing(true)}>
          {t("tickets.editDescription")}
        </Button>
      )}
    </div>
  );
}

const ACTIVITY_ICON: Record<string, IconName> = {
  created: "plus",
  title: "edit",
  description: "doc",
  labels: "tag",
  project: "arrowRight",
  linked_messages: "link",
  unlinked_messages: "unlink",
  assignee: "user",
};

function ActivityLine({ a, users, labels }: { a: ActivityRow; users: Map<string, OrgUser>; labels: Map<string, { name: string }> }) {
  const { t, i18n } = useTranslation();
  const actor = a.actorId ? users.get(a.actorId) : undefined;
  const name = actor?.name ?? t("tickets.someone");
  const b = (s: string) => <b>{s}</b>;
  let icon: ReactNode = <Icon name={ACTIVITY_ICON[a.kind] ?? "circleDashed"} size={14} />;
  let text: ReactNode;
  switch (a.kind) {
    case "status":
      icon = <TicketStatusIcon status={(a.toValue ?? "todo") as TicketStatus} />;
      text = (
        <>
          {b(name)} {t("tickets.act.status")} {b(statusLabel(t, (a.fromValue ?? "todo") as TicketStatus))} →{" "}
          {b(statusLabel(t, (a.toValue ?? "todo") as TicketStatus))}
        </>
      );
      break;
    case "priority":
      icon = <TicketPriorityIcon priority={Number(a.toValue ?? 0) as TicketPriority} size={14} />;
      text = (
        <>
          {b(name)} {t("tickets.act.priority")} {b(priorityLabel(t, Number(a.toValue ?? 0) as TicketPriority))}
        </>
      );
      break;
    case "assignee":
      text = a.toValue ? (
        <>
          {b(name)} {t("tickets.act.assigned")} {b(users.get(a.toValue)?.name ?? "?")}
        </>
      ) : (
        <>
          {b(name)} {t("tickets.act.unassigned")}
        </>
      );
      break;
    case "labels": {
      const names = (v: string | null) =>
        v
          ? v
              .split(",")
              .filter(Boolean)
              .map((id) => labels.get(id)?.name ?? "?")
          : [];
      text = (
        <>
          {b(name)} {t("tickets.act.labels")} {b(names(a.toValue).join(", ") || t("tickets.none"))}
        </>
      );
      break;
    }
    case "project":
      text = (
        <>
          {b(name)} {t("tickets.act.moved")} {b(a.fromValue ?? "?")} → {b(a.toValue ?? "?")}
        </>
      );
      break;
    case "linked_messages":
      text = (
        <>
          {b(name)} {t("tickets.act.linked", { count: Number(a.toValue ?? 1) })}
        </>
      );
      break;
    default:
      text = (
        <>
          {b(name)} {t(`tickets.act.${a.kind}`)}
        </>
      );
  }
  return (
    <div className="tk-event">
      <span className="tk-event__icon">{icon}</span>
      <span className="tk-event__text">
        {text}
        <span className="tk-event__time"> · {a.createdAt ? timeAgo(a.createdAt, i18n.language) : ""}</span>
      </span>
    </div>
  );
}

type CommentData = {
  id: string;
  authorId: string | null;
  body: string;
  createdAt: number | null;
  editedAt: number | null;
  author?: { id: string; name: string; image: string | null } | null;
  reactions: readonly { id: string; emoji: string; userId: string }[];
};

function CommentCard({ c, users, meId }: { c: CommentData; users: (id: string) => OrgUser | undefined; meId: string }) {
  const { t, i18n } = useTranslation();
  const zero = useZero();
  const { org } = useOrg();
  const picker = useMenu();
  const grouped = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of c.reactions) m.set(r.emoji, [...(m.get(r.emoji) ?? []), r.userId]);
    return [...m.entries()];
  }, [c.reactions]);
  const react = (emoji: string) => zero.mutate(mutators.comments.react({ organizationId: org.id, commentId: c.id, emoji, at: Date.now() }));
  return (
    <article className="tk-comment" data-surface="elevated">
      <header className="tk-comment__head">
        <Avatar user={c.author ?? null} size={18} />
        <b>{c.author?.name ?? "—"}</b>
        <span className="tk-muted">{c.createdAt ? timeAgo(c.createdAt, i18n.language) : ""}</span>
        {c.editedAt && <span className="tk-muted">· {t("chat.edited")}</span>}
      </header>
      <div className="tk-comment__body">
        <RichText text={c.body} users={users} meId={meId} />
      </div>
      <div className="reactions tk-comment__reactions">
        {grouped.map(([emoji, ids]) => (
          <Tooltip key={emoji} content={ids.map((id) => (id === meId ? t("chat.you") : (users(id)?.name ?? "?"))).join(", ")}>
            <button type="button" className="reaction" data-mine={ids.includes(meId) || undefined} onClick={() => react(emoji)}>
              <span className="reaction__emoji">{emoji}</span>
              <span className="reaction__count">{ids.length}</span>
            </button>
          </Tooltip>
        ))}
        <button
          type="button"
          className="reaction reaction--add"
          data-active={picker.open || undefined}
          aria-label={t("chat.react")}
          onClick={picker.toggleFrom}
        >
          <Icon name="smile" size={14} />
        </button>
      </div>
      <Popover anchor={picker.anchor} onClose={picker.close} placement="bottom-start" width={292}>
        <EmojiPicker
          onPick={(emoji) => {
            react(emoji);
            picker.close();
          }}
        />
      </Popover>
    </article>
  );
}

function CommentComposer({ ticketId, people }: { ticketId: string; people: readonly OrgUser[] }) {
  const { t } = useTranslation();
  const zero = useZero();
  const { org } = useOrg();
  const docIndex = useDocIndex();
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-grow on every content change
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [body]);
  const send = () => {
    const text = body.trim();
    if (!text) return;
    const w = zero.mutate(
      mutators.comments.create({
        id: newId(),
        organizationId: org.id,
        ticketId,
        body: encodeDocMentions(encodeMentions(text, people), docIndex),
        createdAt: Date.now(),
      }),
    );
    setBody("");
    void w.server.then(
      (r) => r.type === "error" && toast({ tone: "error", title: t("tickets.commentFailed"), description: r.error.message }),
    );
  };
  return (
    <div className="tk-composer" data-surface="elevated">
      <textarea
        ref={ref}
        value={body}
        rows={2}
        placeholder={t("tickets.commentPlaceholder")}
        aria-label={t("tickets.commentPlaceholder")}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="tk-composer__bar">
        <span className="tk-muted">{t("tickets.commentHint")}</span>
        <span className="spacer" />
        <Tooltip content={t("tickets.sendComment")} shortcut={["⌘", "↵"]}>
          <Button
            className="tk-composer__send"
            variant={body.trim() ? "primary" : "secondary"}
            size="sm"
            iconOnly
            icon={<Icon name="arrowUp" size={14} />}
            onClick={send}
            aria-label={t("tickets.sendComment")}
          />
        </Tooltip>
      </div>
    </div>
  );
}
