import { aclId, LEVEL_RANK } from "@feedbacks/schema/docs";
import type { AccessLevel, PrincipalType } from "@feedbacks/schema/enums";
import { mutators, queries } from "@feedbacks/schema/zero";
import { Avatar, Button, Caret, Icon, Menu, type MenuEntry, Modal, useMenu } from "@feedbacks/ui";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "../org-context";
import { useOrgMembers } from "../org-data";
import { canManage, useDocsTree, useTeams } from "./data";
import { levelLabel, useReport } from "./util";

const LEVELS: AccessLevel[] = ["read", "edit", "manage"];

/**
 * Share dialog (manage access): inherited vs restricted, the node's own grants (organization, teams,
 * people), who ends up with access. Agents (MCP) use the rights of the person running them.
 */
export function ShareModal({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const zero = useZero();
  const report = useReport();
  const { org } = useOrg();
  const { users, sorted } = useOrgMembers();
  const teams = useTeams();
  const tree = useDocsTree();
  const [grants] = useQuery(queries.docs.grants({ organizationId: org.id, nodeId }));
  const addMenu = useMenu();

  const folder = tree.folderById.get(nodeId);
  const doc = tree.docById.get(nodeId);
  const node = folder ?? doc;
  const name = folder?.name ?? doc?.title ?? "";
  const inherit = node?.inheritGrants ?? true;
  const parentId = folder ? folder.parentId : doc ? doc.folderId : null;
  const parentName = parentId ? tree.folderById.get(parentId)?.name : null;
  const level = folder ? tree.folderLevel(nodeId) : tree.docLevel(nodeId);
  const manageable = canManage(level) && !tree.readOnly;

  const principalName = (type: PrincipalType, id: string | null) =>
    type === "org"
      ? t("docs.everyone", { org: org.name })
      : type === "team"
        ? (teams.find((x) => x.id === id)?.name ?? t("docs.unknownTeam"))
        : (users.get(id ?? "")?.name ?? t("docs.unknownUser"));

  // Resulting access (resolved entries): who can do what once inheritance is applied
  const effective = useMemo(
    () => [...(node?.aclEntries ?? [])].sort((a, b) => LEVEL_RANK[b.level as AccessLevel] - LEVEL_RANK[a.level as AccessLevel]),
    [node?.aclEntries],
  );

  const grant = (principalType: PrincipalType, principalId: string | null, lvl: AccessLevel) =>
    void report(
      zero.mutate(mutators.access.grant({ organizationId: org.id, nodeId, principalType, principalId, level: lvl, at: Date.now() })),
    );
  const revoke = (id: string) => void report(zero.mutate(mutators.access.revoke({ organizationId: org.id, grantId: id })));
  const setInherit = (value: boolean) =>
    void report(
      zero.mutate(mutators.access.setInherit({ organizationId: org.id, nodeId, inherit: value, at: Date.now() })),
      value ? t("docs.inheritOn") : t("docs.inheritOff"),
    );

  const granted = new Set(grants.map((g) => aclId(nodeId, g.principalType as PrincipalType, g.principalId)));
  const addItems: MenuEntry[] = [
    ...(!granted.has(aclId(nodeId, "org", null))
      ? [
          {
            id: "org",
            label: t("docs.everyone", { org: org.name }),
            icon: <Icon name="building" size={14} />,
            onSelect: () => grant("org", null, "read"),
          },
        ]
      : []),
    ...(teams.length ? [{ kind: "group" as const, id: "g-teams", label: t("docs.teams") }] : []),
    ...teams
      .filter((x) => !granted.has(aclId(nodeId, "team", x.id)))
      .map((x) => ({ id: `t-${x.id}`, label: x.name, icon: <Icon name="team" size={14} />, onSelect: () => grant("team", x.id, "read") })),
    { kind: "group" as const, id: "g-people", label: t("docs.people") },
    ...sorted
      .filter((u) => !granted.has(aclId(nodeId, "user", u.id)))
      .map((u) => ({
        id: `u-${u.id}`,
        label: u.name,
        keywords: u.email,
        icon: <Avatar user={u} size={16} />,
        onSelect: () => grant("user", u.id, "read"),
      })),
  ];

  return (
    <Modal open onClose={onClose} width={540} labelledBy="share-title">
      <div className="modal__header">
        <Icon name="share" size={16} />
        <span id="share-title" className="modal__title truncate">
          {t("docs.shareTitle", { name })}
        </span>
      </div>
      <div className="modal__body">
        <div className="share-inherit">
          <Icon name={inherit ? "folder" : "lock"} size={16} />
          <span style={{ flex: 1 }}>
            {inherit
              ? parentName
                ? t("docs.inheritsFrom", { name: parentName })
                : t("docs.inheritsOrg", { org: org.name })
              : t("docs.restrictedHelp")}
          </span>
          {manageable && (
            <Button variant="secondary" size="sm" onClick={() => setInherit(!inherit)}>
              {inherit ? t("docs.restrict") : t("docs.inheritAgain")}
            </Button>
          )}
        </div>

        <div className="share-section">{t("docs.ownGrants")}</div>
        <div className="share-list">
          {grants.length === 0 && (
            <div className="faint" style={{ padding: "8px 0" }}>
              {t("docs.noOwnGrants")}
            </div>
          )}
          {grants.map((g) => (
            <GrantRow
              key={g.id}
              name={principalName(g.principalType as PrincipalType, g.principalId)}
              type={g.principalType as PrincipalType}
              user={g.principalType === "user" ? users.get(g.principalId ?? "") : undefined}
              level={g.level as AccessLevel}
              editable={manageable}
              onLevel={(lvl) => grant(g.principalType as PrincipalType, g.principalId, lvl)}
              onRemove={() => revoke(g.id)}
            />
          ))}
        </div>
        {manageable && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="personAdd" size={14} />}
            style={{ marginTop: 8 }}
            onClick={addMenu.toggleFrom}
            active={addMenu.open}
          >
            {t("docs.addAccess")}
          </Button>
        )}

        <div className="share-section">{t("docs.whoHasAccess")}</div>
        <div className="share-list">
          {effective.map((e) => (
            <div key={e.id} className="share-row">
              {e.principalType === "user" ? (
                <Avatar user={users.get(e.principalId ?? "") ?? null} size={24} />
              ) : (
                <span className="share-row__icon">
                  <Icon name={e.principalType === "org" ? "building" : "team"} size={14} />
                </span>
              )}
              <span className="share-row__who">
                <span className="share-row__name">{principalName(e.principalType as PrincipalType, e.principalId)}</span>
              </span>
              <span className="faint">{levelLabel(t, e.level as AccessLevel)}</span>
            </div>
          ))}
          <div className="share-row">
            <span className="share-row__icon">
              <Icon name="shieldLock" size={14} />
            </span>
            <span className="share-row__who">
              <span className="share-row__name">{t("docs.ownersAdmins")}</span>
            </span>
            <span className="faint">{levelLabel(t, "manage")}</span>
          </div>
        </div>

        <div className="share-note">
          <Icon name="bot" size={14} />
          <span>{t("docs.agentsNote")}</span>
        </div>
      </div>
      <div className="modal__footer">
        <Button
          variant="muted"
          icon={<Icon name="link" size={14} />}
          onClick={() => void navigator.clipboard.writeText(`${location.origin}/${org.slug}/docs/${folder ? "f" : "d"}/${nodeId}`)}
        >
          {t("docs.copyLink")}
        </Button>
        <span className="spacer" />
        <Button variant="primary" onClick={onClose}>
          {t("common.done")}
        </Button>
      </div>
      <Menu
        anchor={addMenu.anchor}
        onClose={addMenu.close}
        items={addItems}
        width={280}
        filterPlaceholder={t("docs.addAccessPlaceholder")}
      />
    </Modal>
  );
}

function GrantRow({
  name,
  type,
  user,
  level,
  editable,
  onLevel,
  onRemove,
}: {
  name: string;
  type: PrincipalType;
  user?: { id: string; name: string; image: string | null } | undefined;
  level: AccessLevel;
  editable: boolean;
  onLevel: (l: AccessLevel) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const m = useMenu();
  return (
    <div className="share-row">
      {type === "user" ? (
        <Avatar user={user ?? null} size={24} />
      ) : (
        <span className="share-row__icon">
          <Icon name={type === "org" ? "building" : "team"} size={14} />
        </span>
      )}
      <span className="share-row__who">
        <span className="share-row__name">{name}</span>
        <span className="share-row__sub">{t(`docs.principal.${type}`)}</span>
      </span>
      {editable ? (
        <Button variant="borderless" size="sm" onClick={m.toggleFrom} active={m.open}>
          {levelLabel(t, level)}
          <Caret />
        </Button>
      ) : (
        <span className="faint">{levelLabel(t, level)}</span>
      )}
      <Menu
        anchor={m.anchor}
        onClose={m.close}
        width={220}
        placement="bottom-end"
        items={[
          ...LEVELS.map((l) => ({
            id: l,
            label: levelLabel(t, l),
            hint: t(`docs.levelHint.${l}`),
            checked: l === level,
            onSelect: () => onLevel(l),
          })),
          { kind: "separator" as const, id: "s" },
          { id: "remove", label: t("docs.removeAccess"), icon: <Icon name="x" size={14} />, onSelect: onRemove },
        ]}
      />
    </div>
  );
}
