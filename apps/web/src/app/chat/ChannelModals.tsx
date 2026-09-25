import { DM_MAX_MEMBERS, dmChannelId } from "@feedbacks/schema/chat";
import { mutators, queries } from "@feedbacks/schema/zero";
import { Avatar, Button, Checkbox, Icon, Menu, Modal, toast, useMenu } from "@feedbacks/ui";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "../org-context";
import { type OrgUser, useOrgMembers } from "../org-data";

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/* ------------------------------------------------------------------ */

/** Dropdown to pick the default project of a channel (projects are managed in M2) */
export function ProjectPicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [projects] = useQuery(queries.projects.list({ organizationId: org.id }));
  const menu = useMenu();
  const current = projects.find((p) => p.id === value);
  return (
    <>
      <Button variant="secondary" onClick={menu.toggleFrom} active={menu.open} icon={<Icon name="box" size={14} />}>
        {current ? `${current.key} · ${current.name}` : t("channel.noProject")}
      </Button>
      <Menu
        anchor={menu.anchor}
        onClose={menu.close}
        width={260}
        items={[
          { id: "none", label: t("channel.noProject"), checked: !value, onSelect: () => onChange(null) },
          ...projects.map((p) => ({
            id: p.id,
            label: `${p.key} · ${p.name}`,
            icon: <span className="project-dot" style={{ background: p.color }} />,
            checked: p.id === value,
            onSelect: () => onChange(p.id),
          })),
        ]}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */

function PeoplePicker({
  candidates,
  selected,
  onToggle,
  disabled,
  disabledLabel,
}: {
  candidates: readonly OrgUser[];
  selected: readonly string[];
  onToggle: (id: string) => void;
  disabled?: ReadonlySet<string>;
  disabledLabel?: string;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const n = norm(q.trim());
    return candidates.filter((u) => !n || norm(u.name).includes(n) || norm(u.email).includes(n));
  }, [candidates, q]);
  return (
    <div className="people-picker">
      <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("channel.searchPeople")} />
      <div className="people-picker__list">
        {list.map((u) => {
          const off = disabled?.has(u.id);
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the checkbox inside is the keyboard-accessible control; the row is a larger click target
            // biome-ignore lint/a11y/noStaticElementInteractions: see above
            <div key={u.id} className="people-picker__row" data-disabled={off || undefined} onClick={() => !off && onToggle(u.id)}>
              <Checkbox checked={off || selected.includes(u.id)} onChange={() => !off && onToggle(u.id)} label={u.name} />
              <Avatar user={u} size={24} />
              <span className="people-picker__name truncate">{u.name}</span>
              <span className="people-picker__email truncate">{off ? disabledLabel : u.email}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

type ChannelLite = {
  id: string;
  name: string;
  kind: string;
  topic: string | null;
  projectId: string | null;
  archivedAt: number | null;
  members: readonly { userId: string }[];
};

export function ChannelSettingsModal({ channel, open, onClose }: { channel: ChannelLite; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const zero = useZero();
  const { org } = useOrg();
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [projectId, setProjectId] = useState<string | null>(channel.projectId);

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    zero.mutate(mutators.channels.update({ organizationId: org.id, channelId: channel.id, name, topic: topic.trim() || null, projectId }));
    toast({ title: t("channel.saved") });
    onClose();
  };
  const archive = () => {
    const archived = !channel.archivedAt;
    zero.mutate(mutators.channels.archive({ organizationId: org.id, channelId: channel.id, archived, at: Date.now() }));
    toast({ title: t(archived ? "channel.archivedToast" : "channel.restoredToast", { name: channel.name }) });
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="channel-settings-title">
      <form onSubmit={save}>
        <div className="modal__header">
          <b id="channel-settings-title" className="modal__title">
            {t("channel.settings")}
          </b>
        </div>
        <div className="modal__body form-stack">
          <label className="field">
            <span className="field__label">{t("channel.name")}</span>
            <input className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">{t("channel.topic")}</span>
            <input className="input" maxLength={500} value={topic} onChange={(e) => setTopic(e.target.value)} />
          </label>
          <div className="field">
            <span className="field__label">{t("channel.project")}</span>
            <ProjectPicker value={projectId} onChange={setProjectId} />
            <span className="field__hint">{t("channel.projectHint")}</span>
          </div>
        </div>
        <div className="modal__footer">
          <Button
            variant={channel.archivedAt ? "secondary" : "danger"}
            onClick={archive}
            icon={<Icon name={channel.archivedAt ? "restore" : "archive"} size={14} />}
          >
            {channel.archivedAt ? t("channel.unarchive") : t("channel.archive")}
          </Button>
          <span className="spacer" />
          <Button variant="muted" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit">
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

export function ChannelMembersModal({
  channel,
  members,
  open,
  onClose,
  canAdd,
}: {
  channel: ChannelLite;
  members: readonly { userId: string; user?: OrgUser | null }[];
  open: boolean;
  onClose: () => void;
  canAdd: boolean;
}) {
  const { t } = useTranslation();
  const zero = useZero();
  const { org, user } = useOrg();
  const { sorted } = useOrgMembers();
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const memberIds = useMemo(() => new Set(members.map((m) => m.userId)), [members]);

  const close = () => {
    setAdding(false);
    setSelected([]);
    onClose();
  };
  const add = () => {
    if (selected.length)
      zero.mutate(mutators.channels.addMembers({ organizationId: org.id, channelId: channel.id, userIds: selected, at: Date.now() }));
    close();
  };

  return (
    <Modal open={open} onClose={close} labelledBy="channel-members-title">
      <div className="modal__header">
        <b id="channel-members-title" className="modal__title">
          {adding ? t("channel.addPeopleTitle", { name: channel.name }) : t("channel.membersTitle", { name: channel.name })}
        </b>
      </div>
      <div className="modal__body">
        {adding ? (
          <PeoplePicker
            candidates={sorted}
            selected={selected}
            onToggle={(id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))}
            disabled={memberIds}
            disabledLabel={t("channel.alreadyMember")}
          />
        ) : (
          <div className="member-list">
            {members.map((m) => (
              <div key={m.userId} className="member-list__row">
                <Avatar user={m.user ?? null} size={24} />
                <span className="truncate">{m.user?.name ?? "—"}</span>
                {m.userId === user.id && <span className="muted">({t("members.you")})</span>}
                <span className="spacer" />
                <span className="muted truncate">{m.user?.email}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="modal__footer">
        {adding ? (
          <>
            <Button variant="muted" onClick={() => setAdding(false)}>
              {t("common.back")}
            </Button>
            <Button variant="primary" disabled={!selected.length} onClick={add}>
              {t("channel.add")}
            </Button>
          </>
        ) : (
          <>
            {canAdd && (
              <Button variant="secondary" icon={<Icon name="personAdd" size={14} />} onClick={() => setAdding(true)}>
                {t("channel.addPeople")}
              </Button>
            )}
            <span className="spacer" />
            <Button variant="muted" onClick={close}>
              {t("common.close")}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

export function BrowseChannelsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const zero = useZero();
  const navigate = useNavigate();
  const { org, user } = useOrg();
  const [browse] = useQuery(open ? queries.channels.browse({ organizationId: org.id }) : undefined);
  const channels = browse ?? [];
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const n = norm(q.trim());
    return channels.filter((c) => !c.archivedAt && (!n || norm(c.name).includes(n) || norm(c.topic ?? "").includes(n)));
  }, [channels, q]);

  const openChannel = (id: string) => {
    onClose();
    void navigate({ to: "/$orgSlug/c/$channelId", params: { orgSlug: org.slug, channelId: id } });
  };

  return (
    <Modal open={open} onClose={onClose} width={560} labelledBy="browse-title">
      <div className="modal__header">
        <b id="browse-title" className="modal__title">
          {t("channel.browseTitle")}
        </b>
      </div>
      <div className="modal__body form-stack">
        <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("channel.searchChannels")} />
        <div className="browse-list">
          {list.length === 0 && <div className="muted browse-list__empty">{t("channel.noChannels")}</div>}
          {list.map((c) => {
            const joined = c.members.some((m) => m.userId === user.id);
            return (
              <div key={c.id} className="browse-list__row">
                <Icon name="hash" size={16} />
                <div className="browse-list__text">
                  <span className="browse-list__name">{c.name}</span>
                  {c.topic && <span className="browse-list__topic truncate">{c.topic}</span>}
                </div>
                <span className="spacer" />
                {joined ? (
                  <>
                    <span className="muted browse-list__joined">
                      <Icon name="check" size={14} /> {t("channel.joined")}
                    </span>
                    <Button size="sm" variant="secondary" onClick={() => openChannel(c.id)}>
                      {t("channel.open")}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      zero.mutate(mutators.channels.join({ organizationId: org.id, channelId: c.id, at: Date.now() }));
                      openChannel(c.id);
                    }}
                  >
                    {t("channel.join")}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

export function NewDmModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const zero = useZero();
  const navigate = useNavigate();
  const { org, user } = useOrg();
  const { sorted } = useOrgMembers();
  const [selected, setSelected] = useState<string[]>([]);
  const others = useMemo(() => sorted.filter((u) => u.id !== user.id), [sorted, user.id]);

  const start = () => {
    if (!selected.length) return;
    zero.mutate(mutators.channels.openDm({ organizationId: org.id, userIds: selected, at: Date.now() }));
    const id = dmChannelId(org.id, [user.id, ...selected]);
    setSelected([]);
    onClose();
    void navigate({ to: "/$orgSlug/c/$channelId", params: { orgSlug: org.slug, channelId: id } });
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        setSelected([]);
        onClose();
      }}
      labelledBy="dm-title"
    >
      <div className="modal__header">
        <b id="dm-title" className="modal__title">
          {t("dm.title")}
        </b>
      </div>
      <div className="modal__body">
        <PeoplePicker
          candidates={others}
          selected={selected}
          onToggle={(id) =>
            setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= DM_MAX_MEMBERS - 1 ? s : [...s, id]))
          }
        />
        {selected.length >= DM_MAX_MEMBERS - 1 && <p className="field__hint">{t("dm.maxReached", { max: DM_MAX_MEMBERS })}</p>}
      </div>
      <div className="modal__footer">
        <Button
          variant="muted"
          onClick={() => {
            setSelected([]);
            onClose();
          }}
        >
          {t("common.cancel")}
        </Button>
        <Button variant="primary" disabled={!selected.length} onClick={start}>
          {t("dm.start")}
        </Button>
      </div>
    </Modal>
  );
}
