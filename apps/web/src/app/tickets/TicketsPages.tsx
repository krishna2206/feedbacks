import type { TicketStatus } from "@feedbacks/schema/enums";
import { canEditTickets, canManageProject } from "@feedbacks/schema/tickets";
import { queries } from "@feedbacks/schema/zero";
import { Button, Icon, type IconName, Tooltip } from "@feedbacks/ui";
import { useQuery } from "@rocicorp/zero/react";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "../org-context";
import { type OrgUser, useOrgMembers } from "../org-data";
import { ViewHeader } from "../ViewHeader";
import { ActiveFilters, DisplayButton, FilterButton } from "./controls";
import { openCreateTicket, useLabels, useProjectKeys, useProjectRoles, useProjects } from "./data";
import { ProjectBadge } from "./meta";
import {
  applyFilters,
  type Display,
  type Filters,
  type Group,
  groupTickets,
  loadView,
  saveView,
  type TabKey,
  type TicketRow,
} from "./model";
import { TicketBoard } from "./TicketBoard";
import { TicketList } from "./TicketList";
import "./tickets.css";

export function TicketsEmpty({ icon, title, text, action }: { icon: IconName; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="iss-empty">
      <div className="iss-empty__icon">
        <Icon name={icon} size={26} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action && <div className="iss-empty__actions">{action}</div>}
    </div>
  );
}

/** People who can read a project (assignee pickers, filters) */
function useProjectPeople(project: { visibility: string | null; members: readonly { userId: string }[] } | undefined) {
  const { sorted, roles } = useOrgMembers();
  return useMemo(
    () =>
      project
        ? sorted.filter((u) => {
            const r = roles.get(u.id);
            return r === "owner" || r === "admin" || project.visibility === "org" || project.members.some((m) => m.userId === u.id);
          })
        : sorted,
    [project, sorted, roles],
  );
}

/* ================================================================== */
/* Project page: tabs · filters · list ↔ board                          */
/* ================================================================== */

export function ProjectPage() {
  const { projectKey } = useParams({ from: "/$orgSlug/projects/$projectKey" });
  const search = useSearch({ from: "/$orgSlug/projects/$projectKey" });
  const { org } = useOrg();
  const { t } = useTranslation();
  const [project, result] = useQuery(queries.projects.byKey({ organizationId: org.id, key: projectKey.toUpperCase() }));
  if (!project)
    return result.type === "complete" ? (
      <>
        <ViewHeader>
          <span className="crumb">{projectKey}</span>
        </ViewHeader>
        <TicketsEmpty icon="box" title={t("tickets.projectNotFound")} text={t("tickets.projectNotFoundText")} />
      </>
    ) : null;
  return <ProjectView key={project.id} project={project} tab={search.tab ?? "all"} />;
}

type ProjectData = {
  id: string;
  key: string;
  name: string;
  color: string;
  visibility: string | null;
  members: readonly { userId: string; role: string }[];
};

function ProjectView({ project, tab }: { project: ProjectData; tab: TabKey }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { org, user } = useOrg();
  const { users } = useOrgMembers();
  const { labels, byId: labelById } = useLabels();
  const { keyOf } = useProjectKeys();
  const roleOf = useProjectRoles();
  const role = roleOf(project);
  const editable = canEditTickets(role);
  const people = useProjectPeople(project);
  const [tickets] = useQuery(queries.tickets.byProject({ organizationId: org.id, projectId: project.id }));
  const [view, setView] = useState(() => loadView(project.id));
  useEffect(() => saveView(project.id, view), [project.id, view]);
  const setFilters = (filters: Filters) => setView((v) => ({ ...v, filters }));
  const setDisplay = (display: Display) => setView((v) => ({ ...v, display }));

  const rows = tickets as unknown as readonly (TicketRow & (typeof tickets)[number])[];
  const visible = useMemo(() => applyFilters(rows, tab, view.filters, view.display), [rows, tab, view.filters, view.display]);
  const groups = useMemo(() => groupTickets(t, visible, view.display, people, user.id), [t, visible, view.display, people, user.id]);
  const open = useCallback(
    (x: TicketRow) => void navigate({ to: "/$orgSlug/issue/$ref", params: { orgSlug: org.slug, ref: keyOf(x) } }),
    [navigate, org.slug, keyOf],
  );
  const create = (status?: TicketStatus) => openCreateTicket({ projectId: project.id, status });
  const setTab = (next: TabKey) =>
    void navigate({
      to: "/$orgSlug/projects/$projectKey",
      params: { orgSlug: org.slug, projectKey: project.key },
      search: { tab: next === "all" ? undefined : next },
    });

  // `c` creates a ticket in this project
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (
        e.key !== "c" ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        el.isContentEditable ||
        ["INPUT", "TEXTAREA"].includes(el.tagName) ||
        document.querySelector(".popover, .modal-backdrop")
      )
        return;
      e.preventDefault();
      create();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const common = { keyOf, users, labels: labelById, people, onOpen: open, canEdit: () => editable };
  const empty = tickets.length ? (
    <TicketsEmpty
      icon="filter"
      title={t("tickets.noMatch")}
      text={t("tickets.noMatchText")}
      action={
        <Button size="md" variant="secondary" onClick={() => setFilters({ status: [], priority: [], assignee: [], label: [] })}>
          {t("tickets.clearFilters")}
        </Button>
      }
    />
  ) : (
    <TicketsEmpty
      icon="target"
      title={t("tickets.emptyProject")}
      text={editable ? t("tickets.emptyProjectText") : t("tickets.emptyProjectReadOnly")}
      action={
        editable ? (
          <Button size="md" variant="primary" icon={<Icon name="plus" size={14} />} onClick={() => create()}>
            {t("tickets.newTicket")}
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <>
      <ViewHeader>
        <span className="crumb">
          <ProjectBadge project={project} size={16} />
          <span className="truncate">{project.name}</span>
        </span>
        <div className="view-tabs">
          {(["all", "active", "backlog"] as TabKey[]).map((k) => (
            <Button key={k} variant="tab" size="md" active={tab === k} onClick={() => setTab(k)}>
              {t(`tickets.tab.${k}`)}
            </Button>
          ))}
        </div>
        <span className="spacer" />
        <FilterButton filters={view.filters} onChange={setFilters} people={people} labels={labels} meId={user.id} />
        <div className="iss-layout-switch">
          <Tooltip content={t("tickets.listView")} placement="bottom">
            <Button
              variant="borderless"
              size="sm"
              iconOnly
              icon={<Icon name="list" size={14} />}
              active={view.layout === "list"}
              onClick={() => setView((v) => ({ ...v, layout: "list" }))}
              aria-label={t("tickets.listView")}
            />
          </Tooltip>
          <Tooltip content={t("tickets.boardView")} placement="bottom">
            <Button
              variant="borderless"
              size="sm"
              iconOnly
              icon={<Icon name="board" size={14} />}
              active={view.layout === "board"}
              onClick={() => setView((v) => ({ ...v, layout: "board" }))}
              aria-label={t("tickets.boardView")}
            />
          </Tooltip>
        </div>
        <DisplayButton display={view.display} onChange={setDisplay} board={view.layout === "board"} />
        {canManageProject(role) && (
          <Tooltip content={t("projects.settings")} placement="bottom">
            <Button
              variant="muted"
              size="sm"
              iconOnly
              icon={<Icon name="settings" size={14} />}
              onClick={() =>
                void navigate({ to: "/$orgSlug/projects/$projectKey/settings", params: { orgSlug: org.slug, projectKey: project.key } })
              }
              aria-label={t("projects.settings")}
            />
          </Tooltip>
        )}
        {editable && (
          <Tooltip content={t("tickets.newTicket")} shortcut="C" placement="bottom">
            <Button
              variant="secondary"
              size="sm"
              iconOnly
              icon={<Icon name="plus" size={14} />}
              onClick={() => create()}
              aria-label={t("tickets.newTicket")}
            />
          </Tooltip>
        )}
      </ViewHeader>
      <ActiveFilters filters={view.filters} onChange={setFilters} people={people} labels={labels} meId={user.id} />
      <div className="iss-body">
        {view.layout === "board" ? (
          visible.length || tickets.length ? (
            <TicketBoard {...common} tickets={visible} display={view.display} tab={tab} onCreate={editable ? create : undefined} />
          ) : (
            empty
          )
        ) : (
          <TicketList
            {...common}
            groups={groups}
            empty={empty}
            onCreateInGroup={editable ? (g: Group<TicketRow>) => create(g.status) : undefined}
          />
        )}
      </div>
    </>
  );
}

/* ================================================================== */
/* My tickets: assigned · created · reported (built from my messages)   */
/* ================================================================== */

type MineTab = "assigned" | "created" | "reported";
const MINE_DISPLAY: Display = { groupBy: "status", sortBy: "updated", showClosed: true };

export function MyTicketsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({ from: "/$orgSlug/tickets" });
  const tab: MineTab = search.tab ?? "assigned";
  const { org, user } = useOrg();
  const { users, sorted } = useOrgMembers();
  const { byId: labelById } = useLabels();
  const { keyOf } = useProjectKeys();
  const projects = useProjects(true);
  const roleOf = useProjectRoles();
  const [tickets] = useQuery(queries.tickets.mine({ organizationId: org.id, filter: tab }));
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const rows = tickets as unknown as readonly TicketRow[];
  const groups = useMemo(() => groupTickets(t, rows, MINE_DISPLAY, sorted, user.id), [t, rows, sorted, user.id]);
  const open = useCallback(
    (x: TicketRow) => void navigate({ to: "/$orgSlug/issue/$ref", params: { orgSlug: org.slug, ref: keyOf(x) } }),
    [navigate, org.slug, keyOf],
  );
  const canEdit = useCallback((x: TicketRow) => canEditTickets(roleOf(projectById.get(x.projectId))), [roleOf, projectById]);

  return (
    <>
      <ViewHeader>
        <span className="crumb">
          <Icon name="target" size={14} />
          {t("nav.tickets")}
        </span>
        <div className="view-tabs">
          {(["assigned", "created", "reported"] as MineTab[]).map((k) => (
            <Button
              key={k}
              variant="tab"
              size="md"
              active={tab === k}
              onClick={() =>
                void navigate({ to: "/$orgSlug/tickets", params: { orgSlug: org.slug }, search: { tab: k === "assigned" ? undefined : k } })
              }
            >
              {t(`tickets.mine.${k}`)}
            </Button>
          ))}
        </div>
      </ViewHeader>
      <div className="iss-body">
        <TicketList
          groups={groups}
          keyOf={keyOf}
          users={users}
          labels={labelById}
          people={sorted as OrgUser[]}
          projects={projectById}
          onOpen={open}
          canEdit={canEdit}
          empty={
            <TicketsEmpty
              icon={tab === "reported" ? "chat" : "target"}
              title={t(`tickets.mine.empty.${tab}`)}
              text={t(`tickets.mine.emptyText.${tab}`)}
            />
          }
        />
      </div>
    </>
  );
}
