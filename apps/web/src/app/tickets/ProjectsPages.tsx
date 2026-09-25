import type { ProjectRole, ProjectVisibility } from "@feedbacks/schema/enums";
import { newId } from "@feedbacks/schema/ids";
import { canManageProject, isValidProjectKey, normalizeProjectKey } from "@feedbacks/schema/tickets";
import { mutators, queries } from "@feedbacks/schema/zero";
import { Avatar, Button, Caret, Icon, LabelDot, Menu, Modal, toast, useMenu } from "@feedbacks/ui";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "../org-context";
import { useOrgMembers } from "../org-data";
import { ViewHeader } from "../ViewHeader";
import { useLabels, useProjectRoles, useProjects } from "./data";
import { LABEL_COLORS, PROJECT_COLORS, ProjectBadge } from "./meta";
import { TicketsEmpty } from "./TicketsPages";
import "./tickets.css";

const ROLES: ProjectRole[] = ["lead", "contributor", "reporter", "viewer"];

function useReport() {
  const { t } = useTranslation();
  return (w: { server: Promise<{ type: string; error?: { message: string } }> }, success?: string) =>
    void w.server.then((r) => {
      if (r.type === "error") toast({ tone: "error", title: t("projects.actionFailed"), description: r.error?.message }, 6000);
      else if (success) toast({ title: success });
    });
}

/* ================================================================== */
/* Projects: list, create (owners/admins), labels                       */
/* ================================================================== */

export function ProjectsPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { isAdmin } = useOrgMembers();
  const projects = useProjects(true);
  const roleOf = useProjectRoles();
  const [creating, setCreating] = useState(false);
  const active = projects.filter((p) => !p.archivedAt);
  const archived = projects.filter((p) => p.archivedAt);

  return (
    <>
      <ViewHeader>
        <span className="crumb">
          <Icon name="box" size={14} />
          {t("projects.title")}
        </span>
        <span className="spacer" />
        {isAdmin && (
          <Button variant="secondary" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setCreating(true)}>
            {t("projects.new")}
          </Button>
        )}
      </ViewHeader>
      <div className="prj">
        {projects.length === 0 ? (
          <TicketsEmpty
            icon="box"
            title={t("projects.empty")}
            text={isAdmin ? t("projects.emptyAdmin") : t("projects.emptyMember")}
            action={
              isAdmin ? (
                <Button variant="primary" size="md" onClick={() => setCreating(true)}>
                  {t("projects.new")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="prj-inner">
            <div className="prj-list">
              {[...active, ...archived].map((p) => {
                const role = roleOf(p);
                return (
                  <div key={p.id} className="prj-row" data-archived={!!p.archivedAt || undefined}>
                    <Link to="/$orgSlug/projects/$projectKey" params={{ orgSlug: org.slug, projectKey: p.key }} className="prj-row__main">
                      <ProjectBadge project={p} size={24} />
                      <span className="prj-row__name">{p.name}</span>
                      <span className="prj-row__key tabular">{p.key}</span>
                      {p.visibility === "members" && <Icon name="lock" size={14} className="faint" />}
                      {p.archivedAt && <span className="chip">{t("projects.archived")}</span>}
                    </Link>
                    <span className="prj-row__meta">{t("projects.memberCount", { count: p.members.length })}</span>
                    <span className="prj-row__role">{role ? t(`projects.role.${role}`) : ""}</span>
                    {canManageProject(role) && (
                      <Link
                        to="/$orgSlug/projects/$projectKey/settings"
                        params={{ orgSlug: org.slug, projectKey: p.key }}
                        className="btn btn--muted btn--sm btn--icon"
                        aria-label={t("projects.settings")}
                      >
                        <Icon name="settings" size={14} />
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
            <LabelsSection />
          </div>
        )}
      </div>
      {creating && <CreateProjectModal onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const zero = useZero();
  const navigate = useNavigate();
  const { org } = useOrg();
  const projects = useProjects(true);
  const report = useReport();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyTouched, setKeyTouched] = useState(false);
  const [color, setColor] = useState<string>(PROJECT_COLORS[projects.length % PROJECT_COLORS.length] as string);
  const [visibility, setVisibility] = useState<ProjectVisibility>("org");
  const finalKey = keyTouched ? normalizeProjectKey(key) : normalizeProjectKey(name).slice(0, 4);
  const taken = projects.some((p) => p.key === finalKey);
  const valid = name.trim() && isValidProjectKey(finalKey) && !taken;

  const submit = () => {
    if (!valid) return;
    report(
      zero.mutate(
        mutators.projects.create({
          id: newId(),
          organizationId: org.id,
          key: finalKey,
          name: name.trim(),
          color,
          visibility,
          createdAt: Date.now(),
        }),
      ),
      t("projects.created", { name: name.trim() }),
    );
    onClose();
    void navigate({ to: "/$orgSlug/projects/$projectKey", params: { orgSlug: org.slug, projectKey: finalKey } });
  };

  return (
    <Modal open onClose={onClose} width={480} labelledBy="new-project">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="modal__header">
          <b className="modal__title" id="new-project">
            {t("projects.new")}
          </b>
        </div>
        <div className="modal__body prj-form">
          <label className="prj-field">
            <span>{t("projects.name")}</span>
            <input
              className="input"
              autoFocus
              value={name}
              maxLength={80}
              placeholder={t("projects.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="prj-field">
            <span>{t("projects.key")}</span>
            <input
              className="input tabular"
              value={finalKey}
              maxLength={10}
              placeholder="APP"
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value);
              }}
            />
            <small className={taken ? "prj-field__error" : "muted"}>
              {taken ? t("projects.keyTaken", { key: finalKey }) : t("projects.keyHint", { key: `${finalKey || "APP"}-1` })}
            </small>
          </label>
          <div className="prj-field">
            <span>{t("projects.color")}</span>
            <div className="prj-colors">
              {PROJECT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="prj-color"
                  style={{ background: c }}
                  data-active={c === color || undefined}
                  onClick={() => setColor(c)}
                  aria-label={c}
                />
              ))}
            </div>
          </div>
          <VisibilityField value={visibility} onChange={setVisibility} />
        </div>
        <div className="modal__footer">
          <Button variant="muted" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!valid}>
            {t("common.create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function VisibilityField({
  value,
  onChange,
  disabled,
}: {
  value: ProjectVisibility;
  onChange: (v: ProjectVisibility) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="prj-field">
      <span>{t("projects.visibility")}</span>
      <div className="prj-radio">
        {(["org", "members"] as ProjectVisibility[]).map((v) => (
          <label key={v} className="prj-radio__opt" data-active={value === v || undefined}>
            <input type="radio" name="visibility" checked={value === v} disabled={disabled} onChange={() => onChange(v)} />
            <Icon name={v === "org" ? "users" : "lock"} size={16} />
            <span>
              <b>{t(`projects.vis.${v}`)}</b>
              <small>{t(`projects.vis.${v}Hint`)}</small>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function LabelsSection() {
  const { t } = useTranslation();
  const zero = useZero();
  const { org } = useOrg();
  const { isAdmin } = useOrgMembers();
  const { labels } = useLabels();
  const report = useReport();
  const [name, setName] = useState("");
  const add = () => {
    const n = name.trim();
    if (!n || labels.some((l) => l.name.toLowerCase() === n.toLowerCase())) return;
    report(
      zero.mutate(
        mutators.labels.create({
          id: newId(),
          organizationId: org.id,
          name: n,
          color: LABEL_COLORS[labels.length % LABEL_COLORS.length] as string,
          createdAt: Date.now(),
        }),
      ),
    );
    setName("");
  };
  return (
    <section className="prj-labels">
      <h2 className="tk-section__title">
        <Icon name="tag" size={14} />
        {t("projects.labels")}
      </h2>
      <div className="prj-labels__list">
        {labels.map((l) => (
          <span key={l.id} className="chip">
            <LabelDot color={l.color} />
            {l.name}
            {isAdmin && (
              <button
                type="button"
                className="prj-labels__x"
                aria-label={t("projects.deleteLabel", { name: l.name })}
                onClick={() => report(zero.mutate(mutators.labels.delete({ organizationId: org.id, id: l.id })))}
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </span>
        ))}
        {!labels.length && <span className="muted">{t("tickets.noLabels")}</span>}
      </div>
      <form
        className="prj-labels__add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          className="input"
          value={name}
          maxLength={40}
          placeholder={t("projects.newLabel")}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={!name.trim()}>
          {t("projects.addLabel")}
        </Button>
      </form>
    </section>
  );
}

/* ================================================================== */
/* Project settings: name, color, visibility, members & roles, archive  */
/* ================================================================== */

export function ProjectSettingsPage() {
  const { projectKey } = useParams({ from: "/$orgSlug/projects/$projectKey/settings" });
  const { t } = useTranslation();
  const zero = useZero();
  const navigate = useNavigate();
  const { org, user } = useOrg();
  const { sorted, isAdmin } = useOrgMembers();
  const roleOf = useProjectRoles();
  const report = useReport();
  const [project, result] = useQuery(queries.projects.byKey({ organizationId: org.id, key: projectKey.toUpperCase() }));
  const [name, setName] = useState<string | null>(null);
  const addMenu = useMenu();
  const [roleMenu, setRoleMenu] = useState<{ anchor: HTMLElement; userId: string } | null>(null);
  const role = roleOf(project);
  const members = useMemo(() => project?.members ?? [], [project]);

  if (!project)
    return result.type === "complete" ? (
      <TicketsEmpty icon="box" title={t("tickets.projectNotFound")} text={t("tickets.projectNotFoundText")} />
    ) : null;
  if (!canManageProject(role)) return <TicketsEmpty icon="lock" title={t("projects.noAccess")} text={t("projects.noAccessText")} />;

  const outsiders = sorted.filter((u) => !members.some((m) => m.userId === u.id));
  const setRole = (userId: string, r: ProjectRole) =>
    report(zero.mutate(mutators.projects.setMember({ organizationId: org.id, projectId: project.id, userId, role: r, at: Date.now() })));
  const update = (patch: { name?: string; color?: string; visibility?: ProjectVisibility }) =>
    report(zero.mutate(mutators.projects.update({ organizationId: org.id, projectId: project.id, ...patch })));

  return (
    <>
      <ViewHeader>
        <Link to="/$orgSlug/projects/$projectKey" params={{ orgSlug: org.slug, projectKey: project.key }} className="crumb">
          <ProjectBadge project={project} size={16} />
          {project.name}
        </Link>
        <span className="crumb-sep">
          <Icon name="chevronRight" size={14} />
        </span>
        <span className="crumb">{t("projects.settings")}</span>
      </ViewHeader>
      <div className="prj">
        <div className="prj-inner prj-settings">
          <section>
            <h2 className="tk-section__title">{t("projects.general")}</h2>
            <label className="prj-field">
              <span>{t("projects.name")}</span>
              <input
                className="input"
                value={name ?? project.name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  if (name?.trim() && name.trim() !== project.name) update({ name: name.trim() });
                  setName(null);
                }}
              />
            </label>
            <div className="prj-field">
              <span>{t("projects.key")}</span>
              <span className="tabular prj-key">{project.key}</span>
              <small className="muted">{t("projects.keyImmutable")}</small>
            </div>
            <div className="prj-field">
              <span>{t("projects.color")}</span>
              <div className="prj-colors">
                {PROJECT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="prj-color"
                    style={{ background: c }}
                    data-active={c === project.color || undefined}
                    onClick={() => update({ color: c })}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
            <VisibilityField value={(project.visibility ?? "org") as ProjectVisibility} onChange={(visibility) => update({ visibility })} />
          </section>

          <section>
            <div className="prj-section-h">
              <h2 className="tk-section__title">{t("projects.members", { count: members.length })}</h2>
              <span className="spacer" />
              <Button
                variant="secondary"
                size="sm"
                icon={<Icon name="personAdd" size={14} />}
                onClick={addMenu.toggleFrom}
                disabled={!outsiders.length}
              >
                {t("projects.addMember")}
              </Button>
            </div>
            <p className="muted prj-help">{t("projects.rolesHelp")}</p>
            <div className="prj-members">
              {members.map((m) => (
                <div key={m.userId} className="prj-member">
                  <Avatar user={m.user ?? null} size={24} />
                  <span className="prj-member__name">
                    {m.user?.name ?? "—"}
                    {m.userId === user.id && <span className="muted"> · {t("chat.you")}</span>}
                  </span>
                  <span className="muted prj-member__email">{m.user?.email}</span>
                  <button type="button" className="chip" onClick={(e) => setRoleMenu({ anchor: e.currentTarget, userId: m.userId })}>
                    {t(`projects.role.${m.role}`)}
                    <Caret />
                  </button>
                </div>
              ))}
            </div>
          </section>

          {isAdmin && (
            <section>
              <h2 className="tk-section__title">{t("projects.dangerZone")}</h2>
              <Button
                variant={project.archivedAt ? "secondary" : "danger"}
                onClick={() => {
                  report(
                    zero.mutate(
                      mutators.projects.archive({
                        organizationId: org.id,
                        projectId: project.id,
                        archived: !project.archivedAt,
                        at: Date.now(),
                      }),
                    ),
                    project.archivedAt ? t("projects.restored") : t("projects.archivedToast"),
                  );
                  if (!project.archivedAt) void navigate({ to: "/$orgSlug/projects", params: { orgSlug: org.slug } });
                }}
              >
                {project.archivedAt ? t("projects.restore") : t("projects.archive")}
              </Button>
            </section>
          )}
        </div>
      </div>

      <Menu
        anchor={addMenu.anchor}
        onClose={addMenu.close}
        filterPlaceholder={t("projects.addMember")}
        items={outsiders.map((u) => ({
          id: u.id,
          label: u.name,
          keywords: u.email,
          icon: <Avatar user={u} size={16} />,
          onSelect: () => setRole(u.id, "contributor"),
        }))}
      />
      <Menu
        anchor={roleMenu?.anchor ?? null}
        onClose={() => setRoleMenu(null)}
        width={260}
        items={
          roleMenu
            ? [
                ...ROLES.map((r) => ({
                  id: r,
                  label: t(`projects.role.${r}`),
                  hint: <span className="muted">{t(`projects.roleHint.${r}`)}</span>,
                  checked: members.find((m) => m.userId === roleMenu.userId)?.role === r,
                  onSelect: () => setRole(roleMenu.userId, r),
                })),
                { kind: "separator" as const, id: "s" },
                {
                  id: "remove",
                  label: t("projects.removeMember"),
                  icon: <Icon name="x" size={14} />,
                  onSelect: () =>
                    report(
                      zero.mutate(
                        mutators.projects.removeMember({ organizationId: org.id, projectId: project.id, userId: roleMenu.userId }),
                      ),
                    ),
                },
              ]
            : []
        }
      />
    </>
  );
}
