import type { TicketPriority, TicketStatus } from "@feedbacks/schema/enums";
import { newId } from "@feedbacks/schema/ids";
import {
  canEditTickets,
  DEFAULT_STATUS,
  DEFAULT_STATUS_FROM_MESSAGES,
  descriptionFromMessages,
  parseAlreadyLinked,
  ticketKey,
  titleFromMessages,
} from "@feedbacks/schema/tickets";
import { mutators, queries } from "@feedbacks/schema/zero";
import { Avatar, Button, Caret, clock, Icon, LabelDot, Menu, Modal, Tooltip, toast, useMenu } from "@feedbacks/ui";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { plainText } from "../chat/markdown";
import { fileUrl } from "../chat/upload";
import { useOrg } from "../org-context";
import { useOrgMembers } from "../org-data";
import { type CreateTicketDraft, closeCreateTicket, useCreateTicketDraft, useLabels, useProjectRoles, useProjects } from "./data";
import { ProjectBadge, priorityLabel, statusLabel, TicketPriorityIcon, TicketStatusIcon } from "./meta";
import { assigneeEntries, labelEntries, priorityEntries, projectEntries, statusEntries } from "./pickers";
import "./tickets.css";

/** Global "New ticket" dialog (sidebar button, `C`, chat selection). Rendered once in the org layout. */
export function CreateTicketModal() {
  const draft = useCreateTicketDraft();
  if (!draft) return null;
  return (
    <Modal open onClose={closeCreateTicket} width={660} labelledBy="ct-title">
      <CreateTicketForm key={draftKey(draft)} draft={draft} />
    </Modal>
  );
}

const keys = new WeakMap<CreateTicketDraft, number>();
let keySeq = 0;
function draftKey(d: CreateTicketDraft) {
  if (!keys.has(d)) keys.set(d, ++keySeq);
  return keys.get(d);
}

function CreateTicketForm({ draft }: { draft: CreateTicketDraft }) {
  const { t, i18n } = useTranslation();
  const zero = useZero();
  const navigate = useNavigate();
  const { org, user } = useOrg();
  const { users, sorted, roles } = useOrgMembers();
  const projects = useProjects();
  const roleOf = useProjectRoles();
  const writable = useMemo(() => projects.filter((p) => canEditTickets(roleOf(p))), [projects, roleOf]);
  const { labels } = useLabels();

  const [sourceIds, setSourceIds] = useState<string[]>(draft.sourceMessageIds ?? []);
  const [msgs, msgsResult] = useQuery(queries.messages.byIds({ organizationId: org.id, ids: draft.sourceMessageIds ?? [] }));
  const sources = useMemo(() => msgs.filter((m) => sourceIds.includes(m.id)), [msgs, sourceIds]);
  const lookup = (id: string) => users.get(id);
  const asSource = (m: (typeof msgs)[number]) => ({
    authorName: m.author?.name ?? "?",
    createdAt: m.createdAt ?? Date.now(),
    body: plainText(m.body, lookup),
    attachmentNames: m.attachments.map((a) => a.name),
  });

  const [projectId, setProjectId] = useState<string | undefined>(draft.projectId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [descTouched, setDescTouched] = useState(false);
  const [status, setStatus] = useState<TicketStatus>(
    draft.status ?? (draft.sourceMessageIds?.length ? DEFAULT_STATUS_FROM_MESSAGES : DEFAULT_STATUS),
  );
  const [priority, setPriority] = useState<TicketPriority>(0);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [titleError, setTitleError] = useState(false);
  const prefilled = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const projectMenu = useMenu();
  const statusMenu = useMenu();
  const priorityMenu = useMenu();
  const assigneeMenu = useMenu();
  const labelMenu = useMenu();

  // Prefill once the source messages are loaded (deterministic title + quoted description, no AI)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the source messages have loaded
  useEffect(() => {
    if (
      prefilled.current ||
      (draft.sourceMessageIds?.length && msgsResult.type !== "complete" && msgs.length < (draft.sourceMessageIds?.length ?? 0))
    )
      return;
    prefilled.current = true;
    const list = msgs.filter((m) => sourceIds.includes(m.id)).map(asSource);
    if (list.length) {
      setTitle(titleFromMessages(list));
      setDescription(descriptionFromMessages(list));
    }
    const channelProject = msgs[0]?.channel?.projectId;
    setProjectId((p) => p ?? writable.find((x) => x.id === channelProject)?.id ?? writable[0]?.id);
  }, [msgs, msgsResult.type]);

  // Default project once projects are synced (dialog opened without sources)
  useEffect(() => {
    if (!projectId && writable[0] && !draft.sourceMessageIds?.length) setProjectId(writable[0].id);
  }, [writable, projectId, draft.sourceMessageIds]);

  // Keep the generated description in sync with the sources until the user edits it
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the list of sources changes
  useEffect(() => {
    if (prefilled.current && !descTouched) setDescription(descriptionFromMessages(sources.map(asSource)));
  }, [sources]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus when the title gets prefilled (caret at the end)
  useEffect(() => {
    const el = titleRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [title === ""]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-grow on every content change
  useEffect(() => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [description]);

  const project = projects.find((p) => p.id === projectId);
  // Assignable: people who can read the project
  const assignable = useMemo(() => {
    if (!project) return sorted;
    return sorted.filter((u) => {
      const r = roles.get(u.id);
      return r === "owner" || r === "admin" || project.visibility === "org" || project.members.some((m) => m.userId === u.id);
    });
  }, [project, sorted, roles]);
  const assignee = assigneeId ? users.get(assigneeId) : undefined;
  const selectedLabels = labels.filter((l) => labelIds.includes(l.id));

  // Messages already backing another ticket (checked again by the server: ALREADY_LINKED)
  const conflicts = sources.filter((m) => m.ticketSources.length > 0);
  const linkedKeys = (m: (typeof msgs)[number]) =>
    m.ticketSources
      .map((s) => (s.ticket?.project ? ticketKey(s.ticket.project.key, s.ticket.number) : t("tickets.hiddenTicket")))
      .join(", ");
  const notified = [...new Set(sources.map((m) => m.authorId).filter((a): a is string => !!a && a !== user.id))].map(
    (id) => users.get(id)?.name ?? "?",
  );

  const submit = (force = false) => {
    if (!title.trim()) {
      setTitleError(true);
      titleRef.current?.focus();
      return;
    }
    if (!project) return;
    if (conflicts.length && !force) return;
    const id = newId();
    const w = zero.mutate(
      mutators.tickets.create({
        id,
        eventId: newId(),
        organizationId: org.id,
        projectId: project.id,
        title: title.trim(),
        description,
        status,
        priority,
        assigneeId,
        labelIds,
        sourceMessageIds: sourceIds,
        force,
        at: Date.now(),
      }),
    );
    closeCreateTicket();
    draft.onCreated?.(id);
    const open = () => void navigate({ to: "/$orgSlug/issue/$ref", params: { orgSlug: org.slug, ref: id } });
    toast({
      title: t("tickets.createdToast", { project: project.name }),
      description: sourceIds.length ? t("tickets.createdFromMessages", { title: title.trim(), count: sourceIds.length }) : title.trim(),
      action: { label: t("tickets.open"), onClick: open },
    });
    void w.server.then((r) => {
      if (r.type !== "error") return;
      const links = parseAlreadyLinked(r.error.message);
      toast(
        {
          tone: "error",
          title: links ? t("tickets.alreadyLinkedTitle", { count: links.length }) : t("tickets.createFailed"),
          description: links ? undefined : r.error.message,
        },
        8000,
      );
    });
  };

  if (!writable.length) {
    return (
      <>
        <div className="modal__header">
          <b className="modal__title" id="ct-title">
            {t("tickets.newTicket")}
          </b>
        </div>
        <div className="modal__body">
          <p className="muted">{t("tickets.noWritableProject")}</p>
        </div>
        <div className="modal__footer">
          <Button variant="secondary" onClick={closeCreateTicket}>
            {t("common.close")}
          </Button>
        </div>
      </>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: ⌘↵ anywhere in the dialog submits
    <div
      className="ct"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="ct-head">
        <button type="button" className="chip ct-project" data-active={projectMenu.open || undefined} onClick={projectMenu.toggleFrom}>
          <ProjectBadge project={project} size={14} />
          <span className="truncate">{project?.name ?? t("tickets.chooseProject")}</span>
          <Caret />
        </button>
        <Icon name="chevronRight" size={14} className="faint" />
        <span className="ct-head__title" id="ct-title">
          {t("tickets.newTicket")}
        </span>
        {sources.length > 0 && <span className="ct-head__hint">· {t("tickets.fromMessages", { count: sources.length })}</span>}
        <span className="spacer" />
        <Tooltip content={t("common.close")} shortcut="Esc">
          <Button
            variant="muted"
            size="sm"
            iconOnly
            icon={<Icon name="x" size={14} />}
            onClick={closeCreateTicket}
            aria-label={t("common.close")}
          />
        </Tooltip>
      </div>

      <div className="ct-body">
        <input
          ref={titleRef}
          className="ct-title"
          value={title}
          placeholder={t("tickets.titlePlaceholder")}
          aria-label={t("tickets.titlePlaceholder")}
          aria-invalid={titleError || undefined}
          maxLength={300}
          onChange={(e) => {
            setTitle(e.target.value);
            setTitleError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              descRef.current?.focus();
            }
          }}
        />
        {titleError && <div className="ct-error">{t("tickets.titleRequired")}</div>}
        <textarea
          ref={descRef}
          className="ct-desc"
          value={description}
          placeholder={t("tickets.descriptionPlaceholder")}
          aria-label={t("tickets.descriptionPlaceholder")}
          onChange={(e) => {
            setDescription(e.target.value);
            setDescTouched(true);
          }}
        />

        {sources.length > 0 && (
          <div className="ct-sources">
            <div className="ct-sources__head">
              <Icon name="chat" size={14} />
              {t("tickets.sourceMessages", { count: sources.length })}
              {descTouched && (
                <Button
                  variant="muted"
                  size="sm"
                  className="ct-sources__regen"
                  onClick={() => {
                    setDescription(descriptionFromMessages(sources.map(asSource)));
                    setDescTouched(false);
                  }}
                >
                  {t("tickets.regenerateDescription")}
                </Button>
              )}
            </div>
            <div className="ct-sources__list">
              {sources.map((m) => {
                const img = m.attachments.find((a) => a.kind === "image");
                return (
                  <div key={m.id} className="ct-source" data-surface="elevated" data-linked={m.ticketSources.length > 0 || undefined}>
                    <Avatar user={m.author ?? null} size={16} />
                    <span className="ct-source__name">{m.author?.name ?? "—"}</span>
                    <span className="ct-source__time">{m.createdAt ? clock(m.createdAt, i18n.language) : ""}</span>
                    <span className="ct-source__text">{plainText(m.body, lookup) || m.attachments.map((a) => a.name).join(", ")}</span>
                    {img && <img className="ct-source__thumb" src={fileUrl(img.id, "thumb")} alt="" loading="lazy" />}
                    {m.ticketSources.length > 0 && (
                      <Tooltip content={t("tickets.alreadyLinkedTo", { keys: linkedKeys(m) })}>
                        <span className="ct-source__linked">
                          <Icon name="link" size={14} />
                        </span>
                      </Tooltip>
                    )}
                    <Tooltip content={t("tickets.removeSource")}>
                      <Button
                        variant="muted"
                        size="sm"
                        iconOnly
                        icon={<Icon name="x" size={12} />}
                        aria-label={t("tickets.removeSource")}
                        onClick={() => setSourceIds((ids) => ids.filter((x) => x !== m.id))}
                      />
                    </Tooltip>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {conflicts.length > 0 && (
        <div className="ct-warn" role="alert">
          <div className="ct-warn__title">
            <Icon name="link" size={14} />
            {t("tickets.alreadyLinkedTitle", { count: conflicts.length })}
          </div>
          <ul>
            {conflicts.map((m) => (
              <li key={m.id}>
                <b>{linkedKeys(m)}</b> — {plainText(m.body, lookup) || m.attachments.map((a) => a.name).join(", ")}
              </li>
            ))}
          </ul>
          <div className="ct-warn__actions">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setSourceIds((ids) => ids.filter((x) => !conflicts.some((c) => c.id === x)))}
            >
              {t("tickets.removeLinkedMessages")}
            </Button>
            <Button size="sm" variant="borderless" onClick={() => submit(true)}>
              {t("tickets.createAnyway")}
            </Button>
          </div>
        </div>
      )}

      <div className="ct-props">
        <button type="button" className="chip" data-active={statusMenu.open || undefined} onClick={statusMenu.toggleFrom}>
          <TicketStatusIcon status={status} />
          {statusLabel(t, status)}
        </button>
        <button type="button" className="chip" data-active={priorityMenu.open || undefined} onClick={priorityMenu.toggleFrom}>
          <TicketPriorityIcon priority={priority} size={14} />
          {priority === 0 ? t("tickets.priorityLabel") : priorityLabel(t, priority)}
        </button>
        <button type="button" className="chip" data-active={assigneeMenu.open || undefined} onClick={assigneeMenu.toggleFrom}>
          <Avatar user={assignee ?? null} size={14} />
          {assignee?.name ?? t("tickets.assignee")}
        </button>
        <button type="button" className="chip" data-active={labelMenu.open || undefined} onClick={labelMenu.toggleFrom}>
          {selectedLabels.length ? selectedLabels.map((l) => <LabelDot key={l.id} color={l.color} />) : <Icon name="tag" size={14} />}
          {selectedLabels.length ? selectedLabels.map((l) => l.name).join(", ") : t("tickets.labels")}
        </button>
      </div>

      <div className="modal__footer ct-footer">
        {notified.length > 0 && (
          <span className="ct-footer__note">
            <Icon name="bell" size={14} />
            {t("tickets.authorsNotified", { names: notified.join(", ") })}
          </span>
        )}
        <span className="spacer" />
        <Button variant="primary" onClick={() => submit()} disabled={!project || conflicts.length > 0}>
          {t("tickets.create")}
          <span className="ct-kbd">⌘↵</span>
        </Button>
      </div>

      <Menu
        anchor={projectMenu.anchor}
        onClose={projectMenu.close}
        filterPlaceholder={t("tickets.chooseProject")}
        items={projectEntries(writable, projectId, setProjectId)}
      />
      <Menu
        anchor={statusMenu.anchor}
        onClose={statusMenu.close}
        filterPlaceholder={t("tickets.changeStatus")}
        items={statusEntries(t, status, setStatus)}
      />
      <Menu
        anchor={priorityMenu.anchor}
        onClose={priorityMenu.close}
        filterPlaceholder={t("tickets.changePriority")}
        items={priorityEntries(t, priority, setPriority)}
      />
      <Menu
        anchor={assigneeMenu.anchor}
        onClose={assigneeMenu.close}
        filterPlaceholder={t("tickets.assignTo")}
        items={assigneeEntries(t, assignable, assigneeId, user.id, setAssigneeId)}
      />
      <Menu
        anchor={labelMenu.anchor}
        onClose={labelMenu.close}
        keepOpen
        filterPlaceholder={t("tickets.addLabels")}
        emptyText={labels.length ? undefined : t("tickets.noLabels")}
        items={labelEntries(labels, labelIds, (id) =>
          setLabelIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])),
        )}
      />
    </div>
  );
}
