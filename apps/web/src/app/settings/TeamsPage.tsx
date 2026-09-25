import { newId } from "@feedbacks/schema/ids";
import { mutators } from "@feedbacks/schema/zero";
import { Avatar, Button, Icon, Menu, type MenuEntry, useMenu } from "@feedbacks/ui";
import { useZero } from "@rocicorp/zero/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NameModal } from "../docs/DocsPages";
import { useTeams } from "../docs/data";
import { useReport } from "../docs/util";
import { useOrg } from "../org-context";
import { useOrgMembers } from "../org-data";
import { ViewHeader } from "../ViewHeader";
import { SettingsTabs } from "./SettingsTabs";
import "../docs/docs.css";

/**
 * Teams: groups of members used as principals of document access (and reusable elsewhere).
 * Owners and admins manage them; everyone can see them.
 */
export function TeamsPage() {
  const { t } = useTranslation();
  const zero = useZero();
  const report = useReport();
  const { org } = useOrg();
  const { users, sorted, isAdmin } = useOrgMembers();
  const teams = useTeams();
  const [naming, setNaming] = useState<null | { id?: string; name: string }>(null);

  return (
    <>
      <ViewHeader>
        <span className="crumb">
          <Icon name="settings" size={14} />
          {t("settings.title")}
        </span>
        <SettingsTabs current="teams" />
        <span className="spacer" />
        {isAdmin && (
          <Button variant="secondary" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setNaming({ name: "" })}>
            {t("teams.new")}
          </Button>
        )}
      </ViewHeader>
      <div className="docs-scroll">
        <div className="teams">
          <p className="faint">{t("teams.intro")}</p>
          {teams.length === 0 && <p className="faint">{isAdmin ? t("teams.emptyAdmin") : t("teams.empty")}</p>}
          {teams.map((team) => (
            <TeamCard
              key={team.id}
              name={team.name}
              memberIds={team.members.map((m) => m.userId)}
              editable={isAdmin}
              candidates={sorted.filter((u) => !team.members.some((m) => m.userId === u.id))}
              nameOf={(id) => users.get(id)}
              onRename={() => setNaming({ id: team.id, name: team.name })}
              onDelete={() => {
                if (window.confirm(t("teams.deleteConfirm", { name: team.name })))
                  void report(zero.mutate(mutators.teams.delete({ organizationId: org.id, teamId: team.id })), t("teams.deleted"));
              }}
              onAdd={(userId) =>
                void report(zero.mutate(mutators.teams.addMember({ organizationId: org.id, teamId: team.id, userId, at: Date.now() })))
              }
              onRemove={(userId) =>
                void report(zero.mutate(mutators.teams.removeMember({ organizationId: org.id, teamId: team.id, userId })))
              }
            />
          ))}
        </div>
      </div>
      {naming && (
        <NameModal
          title={naming.id ? t("teams.rename") : t("teams.new")}
          initial={naming.name}
          placeholder={t("teams.namePlaceholder")}
          onClose={() => setNaming(null)}
          onSubmit={(name) => {
            if (naming.id)
              void report(zero.mutate(mutators.teams.rename({ organizationId: org.id, teamId: naming.id, name, at: Date.now() })));
            else
              void report(
                zero.mutate(mutators.teams.create({ id: newId(), organizationId: org.id, name, at: Date.now() })),
                t("teams.created"),
              );
            setNaming(null);
          }}
        />
      )}
    </>
  );
}

function TeamCard({
  name,
  memberIds,
  editable,
  candidates,
  nameOf,
  onRename,
  onDelete,
  onAdd,
  onRemove,
}: {
  name: string;
  memberIds: string[];
  editable: boolean;
  candidates: { id: string; name: string; email: string; image: string | null }[];
  nameOf: (id: string) => { id: string; name: string; image: string | null } | undefined;
  onRename: () => void;
  onDelete: () => void;
  onAdd: (userId: string) => void;
  onRemove: (userId: string) => void;
}) {
  const { t } = useTranslation();
  const add = useMenu();
  const more = useMenu();
  const addItems: MenuEntry[] = candidates.map((u) => ({
    id: u.id,
    label: u.name,
    keywords: u.email,
    icon: <Avatar user={u} size={16} />,
    onSelect: () => onAdd(u.id),
  }));
  return (
    <div className="team-card">
      <div className="team-card__head">
        <Icon name="team" size={16} />
        <span className="team-card__name truncate">{name}</span>
        <span className="faint">{t("teams.memberCount", { count: memberIds.length })}</span>
        {editable && (
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="personAdd" size={14} />}
              onClick={add.toggleFrom}
              active={add.open}
              disabled={!candidates.length}
            >
              {t("teams.addMember")}
            </Button>
            <Button
              variant="muted"
              size="sm"
              iconOnly
              icon={<Icon name="more" size={14} />}
              onClick={more.toggleFrom}
              active={more.open}
              aria-label={t("chat.more")}
            />
          </>
        )}
      </div>
      <div className="team-card__members">
        {memberIds.length === 0 && <span className="faint">{t("teams.noMembers")}</span>}
        {memberIds.map((id) => {
          const u = nameOf(id);
          return (
            <span key={id} className="team-member">
              <Avatar user={u ?? null} size={18} />
              {u?.name ?? "…"}
              {editable && (
                <button type="button" aria-label={t("teams.removeMember")} onClick={() => onRemove(id)}>
                  <Icon name="x" size={10} />
                </button>
              )}
            </span>
          );
        })}
      </div>
      <Menu anchor={add.anchor} onClose={add.close} items={addItems} width={260} filterPlaceholder={t("teams.addPlaceholder")} />
      <Menu
        anchor={more.anchor}
        onClose={more.close}
        width={200}
        placement="bottom-end"
        items={[
          { id: "rename", label: t("teams.rename"), icon: <Icon name="edit" size={14} />, onSelect: onRename },
          { id: "delete", label: t("teams.delete"), icon: <Icon name="trash" size={14} />, onSelect: onDelete },
        ]}
      />
    </div>
  );
}
