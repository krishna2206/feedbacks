import { newId } from "@feedbacks/schema/ids";
import { mutators } from "@feedbacks/schema/zero";
import { Button, Modal } from "@feedbacks/ui";
import { useZero } from "@rocicorp/zero/react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ProjectPicker } from "./chat/ChannelModals";
import { useOrg } from "./org-context";

export function NewChannelModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const zero = useZero();
  const navigate = useNavigate();
  const { org } = useOrg();
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const id = newId();
    zero.mutate(
      mutators.channels.create({
        id,
        organizationId: org.id,
        name,
        kind: isPrivate ? "private" : "public",
        topic: topic.trim() || null,
        projectId,
        createdAt: Date.now(),
      }),
    );
    onClose();
    setName("");
    setTopic("");
    setPrivate(false);
    setProjectId(null);
    void navigate({ to: "/$orgSlug/c/$channelId", params: { orgSlug: org.slug, channelId: id } });
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="new-channel-title">
      <form onSubmit={submit}>
        <div className="modal__header">
          <b id="new-channel-title" style={{ fontWeight: 500, color: "var(--label-title)" }}>
            {t("channel.newTitle")}
          </b>
        </div>
        <div className="modal__body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            className="input"
            autoFocus
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("channel.namePlaceholder")}
            aria-label={t("channel.name")}
          />
          <input
            className="input"
            maxLength={500}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={t("channel.topic")}
            aria-label={t("channel.topic")}
          />
          <div className="field">
            <span className="field__label">{t("channel.project")}</span>
            <ProjectPicker value={projectId} onChange={setProjectId} />
            <span className="field__hint">{t("channel.projectHint")}</span>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} />
            {t("channel.private")}
            <span className="muted" style={{ fontSize: 12 }}>
              {t("channel.privateHint")}
            </span>
          </label>
        </div>
        <div className="modal__footer">
          <Button variant="muted" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit">
            {t("common.create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
